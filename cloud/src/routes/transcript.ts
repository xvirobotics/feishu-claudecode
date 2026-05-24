/**
 * Cloud transcript relay.
 *
 * Two routes, both scoped to `/i/:instanceId/...`:
 *
 *   1. `GET /i/:instanceId/api/transcript/:chatId`
 *      Looks up the instance, runs `requireFeishuAuth` against the bot that
 *      owns `chatId` on that instance, then forwards the request to the
 *      local dispatcher as a `request{route:"transcript.get"}` frame and
 *      pipes the `response{status,body}` straight back to the browser.
 *
 *   2. `GET /i/:instanceId/web/transcript/*`
 *      Serves the transcript SPA build output (under `staticDir`) — this is
 *      what the IM card link points at; once it loads it XHRs route #1 for
 *      the actual data.
 *
 * Cloud holds no transcript data; it's a pure relay. The local dispatcher
 * (`src/cluster/dispatcher.ts`) is the side that calls
 * `resolveTranscriptCore` from `@metabot/shared`.
 */
import path from 'node:path';
import express, {
  type Express,
  type RequestHandler,
  type Request,
  type Response,
} from 'express';
import {
  InstanceOfflineError,
  InstanceDisconnectedError,
  RequestTimeoutError,
  type InstanceRegistry,
} from '../ws/instance-registry.js';
import { requireFeishuAuth } from '../auth/require-feishu-auth.js';

const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 2_000;

export interface TranscriptRoutesOptions {
  registry: InstanceRegistry;
  /** Filesystem root for the transcript SPA build (served at `/i/:id/web/transcript/*`). */
  staticDir: string;
  /** Shared secret used to verify `mb_session` cookies (HS256). */
  sessionSecret: string;
  /** Per-request relay timeout. Defaults to 2s — same as the task spec. */
  requestTimeoutMs?: number;
  /** Optional auth bypass (cloudflared anonymous tunnel grey-launch only). */
  disableAuth?: boolean;
  logger?: (msg: string) => void;
}

/**
 * Look up the bot record on an instance whose name owns `chatId`. The
 * register frame carries `bots: BotMeta[]` where each entry may declare its
 * `chatIds`. Resolution order:
 *   1. Explicit chatIds match — first bot listing the chat wins.
 *   2. If a bot omits `chatIds` (undefined / empty), it implicitly owns
 *      every chat on this instance — pick the first such bot. This handles
 *      single-bot-per-instance deployments where pushing live chat lists in
 *      the register frame would be churny.
 *   3. Otherwise null → caller surfaces 404.
 */
function findOwningBot(
  bots: { name: string; chatIds?: string[]; accessAllowOpenIds?: string[] }[],
  chatId: string,
): { name: string; allowOpenIds: string[] } | null {
  for (const bot of bots) {
    if (bot.chatIds?.includes(chatId)) {
      return { name: bot.name, allowOpenIds: bot.accessAllowOpenIds ?? [] };
    }
  }
  for (const bot of bots) {
    if (!bot.chatIds || bot.chatIds.length === 0) {
      return { name: bot.name, allowOpenIds: bot.accessAllowOpenIds ?? [] };
    }
  }
  return null;
}

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).type('application/json').send(JSON.stringify(body));
}

function makeRelayHandler(opts: TranscriptRoutesOptions): RequestHandler {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TRANSCRIPT_TIMEOUT_MS;
  const log = opts.logger ?? (() => {});

  return async (req: Request, res: Response) => {
    const { instanceId, chatId } = req.params as {
      instanceId: string;
      chatId: string;
    };

    const record = opts.registry.get(instanceId);
    if (!record) {
      sendJson(res, 503, { error: 'instance offline', instanceId });
      return;
    }

    const owningBot = findOwningBot(record.bots, chatId);

    if (!opts.disableAuth) {
      const botName = owningBot?.name ?? record.bots[0]?.name ?? instanceId;
      const allowOpenIds = owningBot?.allowOpenIds ?? [];
      const returnPath = `/i/${instanceId}/web/transcript/${chatId}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
      const authResult = requireFeishuAuth(req, {
        allowOpenIds,
        returnPath,
        botName,
        sessionSecret: opts.sessionSecret,
        instanceId,
      });
      if (!authResult.ok) {
        if (authResult.status === 401) {
          sendJson(res, 401, { error: 'login required', loginUrl: authResult.loginUrl });
        } else {
          sendJson(res, 403, { error: 'forbidden' });
        }
        return;
      }
    }

    if (!owningBot) {
      // Auth passed (or disabled) but the chat isn't owned by any bot on
      // this instance — treat as 404 rather than leaking instance state.
      sendJson(res, 404, { error: 'chat not found on instance', instanceId, chatId });
      return;
    }

    const turnParam = req.query.turn;
    const turn =
      turnParam === 'all'
        ? 'all'
        : typeof turnParam === 'string' && /^\d+$/.test(turnParam)
          ? Number(turnParam)
          : 1;

    try {
      const responseFrame = await opts.registry.request(
        instanceId,
        'transcript.get',
        { chatId, turn },
        timeoutMs,
      );
      res.status(responseFrame.status).type('application/json');
      res.send(JSON.stringify(responseFrame.body ?? null));
    } catch (err) {
      if (err instanceof InstanceOfflineError) {
        sendJson(res, 503, { error: 'instance offline', instanceId });
        return;
      }
      if (err instanceof InstanceDisconnectedError) {
        sendJson(res, 503, {
          error: 'instance disconnected mid-request',
          instanceId,
        });
        return;
      }
      if (err instanceof RequestTimeoutError) {
        sendJson(res, 504, {
          error: 'instance request timed out',
          instanceId,
          timeoutMs,
        });
        return;
      }
      log(
        `transcript-relay: unexpected error instance=${instanceId} chat=${chatId} err=${(err as Error).message}`,
      );
      sendJson(res, 500, { error: 'relay failed', message: (err as Error).message });
    }
  };
}

/**
 * Mount the transcript relay routes on `app`. Idempotent against the registry
 * — call once at server start.
 */
export function mountTranscriptRoutes(
  app: Express,
  opts: TranscriptRoutesOptions,
): void {
  const handler = makeRelayHandler(opts);

  app.get('/i/:instanceId/api/transcript/:chatId', handler);

  // Static SPA: `/i/:instanceId/web/transcript/*` → `staticDir/...`
  //
  // Express's express.static doesn't know about the `:instanceId` prefix,
  // so we strip it before delegating. We also serve `index.html` for any
  // unmatched sub-path under `/web/transcript/` so the SPA client-side
  // router (anchor turn navigation) keeps working on a hard refresh.
  const spaStatic = express.static(opts.staticDir, {
    fallthrough: true,
    index: 'index.html',
  });

  app.use('/i/:instanceId/web/transcript', (req, res, next) => {
    spaStatic(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      // SPA fallback — only when the request looks like an HTML page (no file extension).
      if (/\.[a-zA-Z0-9]+$/.test(req.path)) {
        next();
        return;
      }
      res.sendFile(path.join(opts.staticDir, 'index.html'), (sendErr) => {
        if (sendErr) next(sendErr);
      });
    });
  });
}
