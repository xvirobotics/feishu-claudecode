/**
 * Cloud-split dispatcher.
 *
 * Cloud relays browser HTTP requests to this instance as `request` frames
 * carrying a `route` string + opaque `params` object. The dispatcher maps
 * each route to a pure async handler returning a `{ status, body }` pair
 * that the cloud-client serialises back into a `response` frame.
 *
 * Routes are produced by a factory so the SessionRegistry / BotRegistry
 * singletons can be injected from the boot site (`src/index.ts`) instead of
 * being imported from inside this module. Tests pass fakes.
 *
 * Auth gating is NOT this dispatcher's job. The cloud relay is expected to
 * have run Feishu OAuth before forwarding the request frame; the per-bot
 * `accessAllowOpenIds` whitelist is also enforced at the cloud edge.
 *
 *   transcript.get  →  { chatId, turn } → 200 TranscriptPayload | 404
 *   sessions.list   →  { botName }      → 200 SessionRecord[]   | 400
 *   hub.botList     →  pending PR-6     → 501
 */
import type { SessionRegistry, SessionRecord } from '../session/session-registry.js';
import { sessionJsonlPath } from '../session/session-registry.js';
import type { BotRegistry } from '../api/bot-registry.js';
import {
  resolveTranscriptCore,
  type TranscriptSessionRecord,
} from '@metabot/shared/transcript';

export interface DispatchResult {
  status: number;
  body:   unknown;
}

export type RouteHandler = (params: unknown) => Promise<DispatchResult>;

export interface DispatcherDeps {
  sessionRegistry: SessionRegistry;
  botRegistry:     BotRegistry;
}

function badRequest(message: string): DispatchResult {
  return { status: 400, body: { error: 'bad request', message } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** transcript.get → mirror the path used by `src/api/routes/transcript-routes.ts`. */
function makeTranscriptGet(deps: DispatcherDeps): RouteHandler {
  return async (params: unknown): Promise<DispatchResult> => {
    if (!isObject(params)) return badRequest('params must be an object');
    const chatId = params.chatId;
    const turnIn = params.turn;
    if (typeof chatId !== 'string' || chatId.length === 0) {
      return badRequest('chatId required');
    }
    const turn: number | 'all' =
      turnIn === 'all'
        ? 'all'
        : typeof turnIn === 'number' && Number.isFinite(turnIn) && turnIn >= 1
          ? Math.floor(turnIn)
          : 'all';

    const record = deps.sessionRegistry.findByChatId(chatId);
    if (!record) {
      return resolveTranscriptCore({
        chatId, turn, sessionRecord: null, botKnown: false, jsonlPath: null,
      });
    }
    const bot = deps.botRegistry.get(record.botName);
    const botKnown = Boolean(bot);

    const sessionRecord: TranscriptSessionRecord = {
      botName:          record.botName,
      workingDirectory: record.workingDirectory,
      ...(record.claudeSessionId ? { claudeSessionId: record.claudeSessionId } : {}),
      ...(record.title            ? { title:           record.title }           : {}),
      ...(record.platform         ? { platform:        record.platform }        : {}),
    };
    const jsonlPath = record.claudeSessionId
      ? sessionJsonlPath(record.workingDirectory, record.claudeSessionId)
      : null;

    return resolveTranscriptCore({ chatId, turn, sessionRecord, botKnown, jsonlPath });
  };
}

/** sessions.list → return the bot's sessions, ordered most-recent first. */
function makeSessionsList(deps: DispatcherDeps): RouteHandler {
  return async (params: unknown): Promise<DispatchResult> => {
    if (!isObject(params)) return badRequest('params must be an object');
    const botName = params.botName;
    if (typeof botName !== 'string' || botName.length === 0) {
      return badRequest('botName required');
    }
    if (!deps.botRegistry.get(botName)) {
      return { status: 404, body: { error: 'bot not registered', botName } };
    }
    const list: SessionRecord[] = deps.sessionRegistry.listSessions(botName);
    return { status: 200, body: list };
  };
}

/** hub.botList → PR-6 will wire this to `@metabot/shared/hub/aggregate`. */
const hubBotListPending: RouteHandler = async () => ({
  status: 501,
  body: { error: 'PR-6 pending: hub aggregation not yet wired' },
});

/** Build the route table from injected dependencies. */
export function createRoutes(deps: DispatcherDeps): Record<string, RouteHandler> {
  return {
    'transcript.get': makeTranscriptGet(deps),
    'sessions.list':  makeSessionsList(deps),
    'hub.botList':    hubBotListPending,
  };
}

export async function dispatchRoute(
  route:  string,
  params: unknown,
  table:  Record<string, RouteHandler>,
): Promise<DispatchResult> {
  const handler = table[route];
  if (!handler) {
    return { status: 404, body: { error: `unknown route: ${route}` } };
  }
  try {
    return await handler(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: 'handler threw', message } };
  }
}
