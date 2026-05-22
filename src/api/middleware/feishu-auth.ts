/**
 * Unified Feishu OAuth middleware — shared cookie + open_id whitelist check.
 *
 * Extracted from `src/api/routes/transcript-routes.ts` so the Hub + Manager
 * routes (Phase 1 follow-ups) can reuse the exact same gate.
 *
 * The middleware does NOT touch the response — it returns a structured
 * `FeishuAuthResult` so callers can choose the right surface (JSON 401,
 * 302 redirect, or HTML shell with inlined error data — transcript routes
 * already need all three).
 *
 * Auth model:
 *   - cookie `mb_session` (HttpOnly HS256 JWT, 7-day) — set by
 *     `/api/auth/feishu/callback` after a successful OAuth dance.
 *   - per-bot whitelist via `accessAllowOpenIds` (new, owner identity).
 *   - transcript-only legacy fallback: `transcriptAllowOpenIds` + env
 *     `METABOT_TRANSCRIPT_ALLOW_OPEN_IDS` (folded in via `unionAllowLists`
 *     when `forTranscript=true`).
 *
 * Empty whitelist always fails closed (403). Never accidentally open to the
 * world — that's the whole reason this middleware exists.
 */
import type * as http from 'node:http';
import { parseCookies, verifySession } from '../../feishu/oauth.js';

/** Successful auth: cookie verified + open_id present in the whitelist. */
export interface FeishuAuthOk {
  ok:     true;
  openId: string;
  name:   string;
}

/** Failed auth. `loginUrl` is only meaningful for 401 (need to start OAuth). */
export interface FeishuAuthFail {
  ok:        false;
  status:    401 | 403;
  loginUrl?: string;
}

export type FeishuAuthResult = FeishuAuthOk | FeishuAuthFail;

export interface RequireFeishuAuthOpts {
  /** open_id whitelist; empty array → deny everyone (closed by default). */
  allowOpenIds: string[];
  /** Path to return to after OAuth completes (relative URL, e.g. `/web/...`). */
  returnPath:   string;
  /** Bot whose Feishu app drives the OAuth dance (must be a feishu bot). */
  botName:      string;
}

/**
 * Verify the `mb_session` cookie and check the open_id against the whitelist.
 *
 *   - no cookie / invalid cookie  →  `{ ok: false, status: 401, loginUrl }`
 *   - cookie ok but open_id not in `allowOpenIds`  →  `{ ok: false, status: 403 }`
 *   - empty `allowOpenIds`  →  `{ ok: false, status: 403 }` (closed by default)
 *   - cookie ok + open_id in whitelist  →  `{ ok: true, openId, name }`
 */
export function requireFeishuAuth(
  req:  http.IncomingMessage,
  opts: RequireFeishuAuthOpts,
): FeishuAuthResult {
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies.mb_session ? verifySession(cookies.mb_session) : null;
  if (!session) {
    return {
      ok:       false,
      status:   401,
      loginUrl: `/api/auth/feishu/login?return=${encodeURIComponent(opts.returnPath)}&bot=${encodeURIComponent(opts.botName)}`,
    };
  }
  if (opts.allowOpenIds.length === 0 || !opts.allowOpenIds.includes(session.open_id)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, openId: session.open_id, name: session.name };
}

/**
 * Resolve the effective whitelist for a bot.
 *
 *   - Transcript routes (`forTranscript=true`): union of
 *     `accessAllowOpenIds` + `transcriptAllowOpenIds` + env
 *     `METABOT_TRANSCRIPT_ALLOW_OPEN_IDS`. Backward-compatible with the
 *     existing transcript page deploy.
 *   - Hub / Manager routes (`forTranscript=false`): only
 *     `accessAllowOpenIds`. No env fallback — Hub is opt-in only.
 */
export function unionAllowLists(
  bot:           { accessAllowOpenIds?: string[]; transcriptAllowOpenIds?: string[] } | null,
  forTranscript: boolean,
): string[] {
  const access     = bot?.accessAllowOpenIds     ?? [];
  const transcript = bot?.transcriptAllowOpenIds ?? [];
  if (forTranscript) {
    const envExtra = (process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set([...access, ...transcript, ...envExtra]));
  }
  return Array.from(new Set(access));
}
