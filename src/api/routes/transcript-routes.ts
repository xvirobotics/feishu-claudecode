/**
 * Transcript page routes — drive the public-facing "查看完整对话" detail page.
 *
 *   GET /api/auth/feishu/login?return=<url>&bot=<botName>
 *     302 → passport.feishu.cn OAuth (HMAC-signed state with returnUrl + botName).
 *
 *   GET /api/auth/feishu/callback?code=...&state=...
 *     Verifies state, exchanges code for open_id + name, sets HttpOnly
 *     mb_session cookie (7-day JWT), 302 → original returnUrl.
 *
 *   GET /api/transcript/:chatId?turn=<n|all>
 *     Cookie-gated + open_id whitelist. Returns
 *     { chat: { chatId, totalTurns }, turn, messages: TranscriptMessage[] }.
 *
 * Whitelist resolution: per-bot `transcriptAllowOpenIds` wins, else falls back
 * to env METABOT_TRANSCRIPT_ALLOW_OPEN_IDS (comma-separated).
 *
 * publicBaseUrl: read from the bot's config and used to build the absolute
 * callback URI sent to Feishu. We also accept an explicit Host header (when
 * the bot has no publicBaseUrl) as a best-effort fallback for local dev.
 */
import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';
import type { BotConfig } from '../../config.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForUser,
  parseCookies,
  signSession,
  verifySession,
  verifyState,
  loadOrCreateSessionSecret,
} from '../../feishu/oauth.js';
import { sessionJsonlPath } from '../../session/session-registry.js';
import { readTranscript } from '../../session/transcript-reader.js';

function envAllowList(): string[] {
  const v = process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS || '';
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function pickFeishuBot(ctx: RouteContext, botName?: string): { name: string; cfg: BotConfig } | null {
  const feishuBots = ctx.registry.listByPlatform('feishu');
  if (feishuBots.length === 0) return null;
  if (botName) {
    const exact = feishuBots.find((b) => b.name === botName);
    if (exact) return { name: exact.name, cfg: exact.config as BotConfig };
    return null;
  }
  // No bot specified — pick the first one. Plan calls this out: in single-bot
  // setups this is unambiguous; in multi-bot deployments callers should pass
  // ?bot=<name> via the card link template.
  return { name: feishuBots[0].name, cfg: feishuBots[0].config as BotConfig };
}

function resolveBaseUrl(ctx: RouteContext, req: http.IncomingMessage, bot: BotConfig): string {
  if (bot.publicBaseUrl) return bot.publicBaseUrl.replace(/\/+$/, '');
  // Best-effort fallback: synthesize from request headers. Only used in local
  // dev when no publicBaseUrl is set.
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  const host  = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function isAllowed(openId: string, bot: BotConfig): boolean {
  const perBot = bot.transcriptAllowOpenIds ?? [];
  if (perBot.includes(openId)) return true;
  return envAllowList().includes(openId);
}

export async function handleTranscriptRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  // ── 1) GET /api/auth/feishu/login ────────────────────────────────────
  if (method === 'GET' && url.startsWith('/api/auth/feishu/login')) {
    const parsed = new URL(url, 'http://localhost');
    const returnUrl = parsed.searchParams.get('return') || '/web';
    const wantedBot = parsed.searchParams.get('bot') || undefined;
    const picked = pickFeishuBot(ctx, wantedBot);
    if (!picked) {
      jsonResponse(res, 503, { error: 'no feishu bot configured for OAuth' });
      return true;
    }
    const base = resolveBaseUrl(ctx, req, picked.cfg);
    const redirectUri = `${base}/api/auth/feishu/callback`;
    const authorizeUrl = buildAuthorizeUrl(
      {
        appId:     picked.cfg.feishu.appId,
        appSecret: picked.cfg.feishu.appSecret,
        botName:   picked.name,
      },
      redirectUri,
      returnUrl,
    );
    res.writeHead(302, { Location: authorizeUrl });
    res.end();
    return true;
  }

  // ── 2) GET /api/auth/feishu/callback ─────────────────────────────────
  if (method === 'GET' && url.startsWith('/api/auth/feishu/callback')) {
    const parsed = new URL(url, 'http://localhost');
    const code   = parsed.searchParams.get('code');
    const state  = parsed.searchParams.get('state');
    if (!code || !state) {
      jsonResponse(res, 400, { error: 'missing code or state' });
      return true;
    }
    const decoded = verifyState(state);
    if (!decoded) {
      jsonResponse(res, 400, { error: 'invalid or expired state' });
      return true;
    }
    const picked = pickFeishuBot(ctx, decoded.botName);
    if (!picked) {
      jsonResponse(res, 503, { error: 'bot vanished between login and callback' });
      return true;
    }
    let profile;
    try {
      profile = await exchangeCodeForUser(
        { appId: picked.cfg.feishu.appId, appSecret: picked.cfg.feishu.appSecret },
        code,
      );
    } catch (err: unknown) {
      ctx.logger.warn({ err }, 'Feishu OAuth exchange failed');
      jsonResponse(res, 502, { error: 'oauth exchange failed', detail: (err as Error).message });
      return true;
    }
    const jwt = signSession({ open_id: profile.openId, name: profile.name });
    const cookie = `mb_session=${encodeURIComponent(jwt)}; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}; Path=/`;

    // Defensive: ensure returnUrl is a relative path or under our own host —
    // we don't want this endpoint to be an open redirect. Best-effort: if it
    // parses as a full URL with a different host, fall back to /web.
    let target = decoded.returnUrl;
    try {
      if (/^https?:\/\//i.test(target)) {
        const t = new URL(target);
        const myBase = resolveBaseUrl(ctx, req, picked.cfg);
        const my = new URL(myBase);
        if (t.host !== my.host) target = '/web';
      }
    } catch {
      target = '/web';
    }

    res.writeHead(302, {
      'Set-Cookie': cookie,
      Location:     target,
    });
    res.end();
    return true;
  }

  // ── 3) GET /api/transcript/:chatId ───────────────────────────────────
  const m = url.match(/^\/api\/transcript\/([^/?#]+)/);
  if (method === 'GET' && m) {
    // Touch the secret once so the first request after install bootstraps
    // .env.local instead of waiting for the first login attempt.
    loadOrCreateSessionSecret();

    const chatId = decodeURIComponent(m[1]);
    const parsed = new URL(url, 'http://localhost');
    const turnParam = parsed.searchParams.get('turn') || 'all';
    const turn: number | 'all' = turnParam === 'all' ? 'all' : Math.max(1, parseInt(turnParam, 10) || 1);

    const cookies = parseCookies(req.headers.cookie);
    const session = cookies.mb_session ? verifySession(cookies.mb_session) : null;
    if (!session) {
      const returnPath = `/web/transcript/${encodeURIComponent(chatId)}${turnParam ? `?turn=${turnParam}` : ''}`;
      jsonResponse(res, 401, {
        error:    'unauthenticated',
        loginUrl: `/api/auth/feishu/login?return=${encodeURIComponent(returnPath)}`,
      });
      return true;
    }

    if (!ctx.sessionRegistry) {
      jsonResponse(res, 503, { error: 'session registry unavailable' });
      return true;
    }

    const record = ctx.sessionRegistry.findByChatId(chatId);
    if (!record) {
      jsonResponse(res, 404, { error: 'session not found' });
      return true;
    }

    // Resolve owning bot — used for whitelist + (future) per-bot rendering hints.
    const bot = ctx.registry.get(record.botName);
    if (!bot) {
      jsonResponse(res, 404, { error: 'bot not registered' });
      return true;
    }
    if (bot.platform !== 'feishu') {
      // Non-feishu bots don't have an OAuth flow yet — they remain accessible
      // only via the same Feishu cookie + the global env allowlist.
      if (!envAllowList().includes(session.open_id)) {
        jsonResponse(res, 403, { error: 'forbidden' });
        return true;
      }
    } else {
      if (!isAllowed(session.open_id, bot.config as BotConfig)) {
        jsonResponse(res, 403, { error: 'forbidden' });
        return true;
      }
    }

    if (!record.claudeSessionId) {
      jsonResponse(res, 200, {
        chat:     { chatId, totalTurns: 0, title: record.title },
        turn,
        messages: [],
      });
      return true;
    }
    const jsonlPath = sessionJsonlPath(record.workingDirectory, record.claudeSessionId);
    const result    = readTranscript(jsonlPath, turn);

    jsonResponse(res, 200, {
      chat:     {
        chatId,
        totalTurns: result.totalTurns,
        title:      record.title,
        botName:    record.botName,
        platform:   record.platform,
      },
      turn,
      messages: result.messages,
    });
    return true;
  }

  return false;
}
