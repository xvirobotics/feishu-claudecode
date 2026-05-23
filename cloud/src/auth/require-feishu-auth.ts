/**
 * Cloud-side requireFeishuAuth.
 *
 * Same shape as `src/api/middleware/feishu-auth.ts` on the local side, but
 * cloud receives the per-instance bot whitelist over the WS register frame
 * (rather than reading it from the local SessionRegistry / bot config). The
 * cloud relay never holds long-lived bot config — the registry is the source
 * of truth, and the route handler passes `allowOpenIds` in from the
 * `BotMeta` it looked up by `instanceId + chatId`.
 *
 * TODO(post-PR-5): consolidate with the local middleware via
 * `@metabot/shared/auth`.
 */
import type * as http from 'node:http';
import { parseCookies, verifySession } from './feishu-session.js';

export interface FeishuAuthOk {
  ok: true;
  openId: string;
  name: string;
}

export interface FeishuAuthFail {
  ok: false;
  status: 401 | 403;
  loginUrl?: string;
}

export type FeishuAuthResult = FeishuAuthOk | FeishuAuthFail;

export interface RequireFeishuAuthOpts {
  allowOpenIds: string[];
  returnPath: string;
  botName: string;
  sessionSecret: string;
}

export function requireFeishuAuth(
  req: http.IncomingMessage,
  opts: RequireFeishuAuthOpts,
): FeishuAuthResult {
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies.mb_session
    ? verifySession(cookies.mb_session, opts.sessionSecret)
    : null;
  if (!session) {
    return {
      ok: false,
      status: 401,
      loginUrl: `/api/auth/feishu/login?return=${encodeURIComponent(opts.returnPath)}&bot=${encodeURIComponent(opts.botName)}`,
    };
  }
  if (opts.allowOpenIds.length === 0 || !opts.allowOpenIds.includes(session.open_id)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, openId: session.open_id, name: session.name };
}
