/**
 * Pure transcript resolver — shared between the local HTTP route shell
 * (`src/api/routes/transcript-routes.ts`) and the future cloud→local WS
 * dispatcher (`route: "transcript.get"`).
 *
 * "Pure" here means:
 *   - no reads from process.env
 *   - no Node http types in the signature (the caller owns I/O)
 *   - no SessionRegistry / BotRegistry imports (the caller resolves those
 *     and passes the already-shaped record in)
 *
 * Auth gating is NOT this function's job — the caller (route shell or
 * dispatcher) runs `requireFeishuAuth` first and only invokes the core on
 * success.
 *
 * Inputs are intentionally serializable so the same core can be driven by:
 *   - a local HTTP request (route shell builds `params` from `ctx + req`)
 *   - a remote WS request frame (`{ chatId, turn, sessionRecord, jsonlPath }`)
 */
import { readTranscript, type TranscriptMessage } from './reader.js';

/**
 * The slice of a SessionRegistry record that the resolver actually needs.
 * Kept narrow so the local SessionRegistry class can supply this without
 * leaking its full shape, and the cloud dispatcher can serialize it over WS.
 */
export interface TranscriptSessionRecord {
  botName:           string;
  claudeSessionId?:  string;
  workingDirectory:  string;
  title?:            string;
  platform?:         string;
}

export interface ResolveTranscriptParams {
  chatId:         string;
  turn:           number | 'all';
  /** Already-looked-up session record. `null` → 404 (session not found). */
  sessionRecord:  TranscriptSessionRecord | null;
  /** Whether the bot referenced by `sessionRecord.botName` exists. */
  botKnown:       boolean;
  /**
   * Resolved JSONL path for `(workingDirectory, claudeSessionId)`. The caller
   * computes this so the core stays decoupled from the SDK's project-dir
   * encoding. Pass `null` when `claudeSessionId` is missing.
   */
  jsonlPath:      string | null;
}

export interface TranscriptPayload {
  chat:     { chatId: string; totalTurns: number; title?: string; botName?: string; platform?: string };
  turn:     number | 'all';
  messages: TranscriptMessage[];
}

export type ResolveTranscriptResult =
  | { status: 200; body: TranscriptPayload }
  | { status: 404; body: { error: string; reason: 'session' | 'bot' } };

/**
 * Resolve a transcript payload for `{ chatId, turn }`, returning either the
 * data or a structured 404. Higher-level error states (401/403 from auth,
 * 503 when the registry itself is unavailable) belong in the caller; this
 * function only knows about the data layer.
 */
export function resolveTranscriptCore(params: ResolveTranscriptParams): ResolveTranscriptResult {
  const { chatId, turn, sessionRecord, botKnown, jsonlPath } = params;

  if (!sessionRecord) {
    return { status: 404, body: { error: 'session not found', reason: 'session' } };
  }
  if (!botKnown) {
    return { status: 404, body: { error: 'bot not registered', reason: 'bot' } };
  }

  // No claudeSessionId yet → empty transcript, still 200. Mirrors the prior
  // route behaviour where a freshly-created chat with no Claude session yet
  // renders an empty page instead of a 404.
  if (!sessionRecord.claudeSessionId || !jsonlPath) {
    return {
      status: 200,
      body: {
        chat:     { chatId, totalTurns: 0, ...(sessionRecord.title ? { title: sessionRecord.title } : {}) },
        turn,
        messages: [],
      },
    };
  }

  const result = readTranscript(jsonlPath, turn);
  return {
    status: 200,
    body: {
      chat: {
        chatId,
        totalTurns: result.totalTurns,
        ...(sessionRecord.title    ? { title:    sessionRecord.title }    : {}),
        ...(sessionRecord.botName  ? { botName:  sessionRecord.botName }  : {}),
        ...(sessionRecord.platform ? { platform: sessionRecord.platform } : {}),
      },
      turn,
      messages: result.messages,
    },
  };
}
