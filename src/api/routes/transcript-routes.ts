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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';
import type { BotConfig } from '../../config.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForUser,
  signSession,
  verifyState,
  loadOrCreateSessionSecret,
} from '../../feishu/oauth.js';
import { requireFeishuAuth, unionAllowLists } from '../middleware/feishu-auth.js';
import { sessionJsonlPath } from '../../session/session-registry.js';
import {
  resolveTranscriptCore,
  type TranscriptPayload,
  type TranscriptSessionRecord,
} from '@metabot/shared/transcript';

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

/**
 * Resolve transcript data for `chatId` + `turn`, returning either the data
 * payload or a structured failure reason. Shared by both the JSON API endpoint
 * (`/api/transcript/...`) and the SSR HTML endpoint (`/web/transcript/...`) so
 * mobile webviews that silently drop XHR can still load the page via inlined data.
 */
type TranscriptResolveOk = { ok: true; payload: TranscriptPayload };
type TranscriptResolveFail =
  | { ok: false; status: 401; loginUrl: string }
  | { ok: false; status: 403 }
  | { ok: false; status: 404; reason: 'session' | 'bot' }
  | { ok: false; status: 503 };

function resolveTranscript(
  ctx:      RouteContext,
  req:      http.IncomingMessage,
  chatId:   string,
  turn:     number | 'all',
  turnRaw:  string,
): TranscriptResolveOk | TranscriptResolveFail {
  loadOrCreateSessionSecret();

  if (!ctx.sessionRegistry) return { ok: false, status: 503 };

  const record = ctx.sessionRegistry.findByChatId(chatId);
  if (!record) return { ok: false, status: 404, reason: 'session' };

  const bot = ctx.registry.get(record.botName);
  if (!bot) return { ok: false, status: 404, reason: 'bot' };

  const botCfg     = bot.platform === 'feishu' ? (bot.config as BotConfig) : null;
  const disableAuth = botCfg?.transcriptDisableAuth === true;

  if (!disableAuth) {
    const allowList  = unionAllowLists(botCfg, /*forTranscript=*/true);
    const returnPath = `/web/transcript/${encodeURIComponent(chatId)}${turnRaw ? `?turn=${turnRaw}` : ''}`;
    const authRes    = requireFeishuAuth(req, {
      allowOpenIds: allowList,
      returnPath,
      botName:      record.botName,
    });
    if (!authRes.ok) {
      if (authRes.status === 401) return { ok: false, status: 401, loginUrl: authRes.loginUrl! };
      return { ok: false, status: 403 };
    }
  }

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

  const core = resolveTranscriptCore({
    chatId,
    turn,
    sessionRecord,
    botKnown: true,
    jsonlPath,
  });
  if (core.status === 404) {
    return { ok: false, status: 404, reason: core.body.reason };
  }
  return { ok: true, payload: core.body };
}

/** Escape characters that could break out of an HTML <script> embed. */
function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g,    '\\u003c')
    .replace(/>/g,    '\\u003e')
    .replace(/&/g,    '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Read dist/web/index.html and inject `window.__TRANSCRIPT_DATA__ = {...}`
 * right before the bundle script. Some mobile in-app browsers (notably Baidu
 * and certain Feishu webview configurations on CN mobile networks) silently
 * drop XHR/fetch to lesser-known domains while still loading the initial HTML;
 * inlining the data lets the page render without any subsequent network call.
 */
function readIndexHtmlWithData(payload: unknown): string | null {
  const indexPath = path.resolve(process.cwd(), 'dist', 'web', 'index.html');
  let html: string;
  try {
    html = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return null;
  }
  const injection = `<script>window.__TRANSCRIPT_DATA__ = ${safeJsonForScript(payload)};</script>`;
  if (html.includes('<script type="module"')) {
    return html.replace('<script type="module"', `${injection}\n    <script type="module"`);
  }
  return html.replace('</head>', `  ${injection}\n  </head>`);
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
  const apiM = url.match(/^\/api\/transcript\/([^/?#]+)/);
  if (method === 'GET' && apiM) {
    const chatId    = decodeURIComponent(apiM[1]);
    const parsed    = new URL(url, 'http://localhost');
    const turnParam = parsed.searchParams.get('turn') || 'all';
    const turn: number | 'all' = turnParam === 'all' ? 'all' : Math.max(1, parseInt(turnParam, 10) || 1);

    const result = resolveTranscript(ctx, req, chatId, turn, turnParam);
    if (!result.ok) {
      if (result.status === 401) {
        jsonResponse(res, 401, { error: 'unauthenticated', loginUrl: result.loginUrl });
      } else if (result.status === 403) {
        jsonResponse(res, 403, { error: 'forbidden' });
      } else if (result.status === 404) {
        jsonResponse(res, 404, { error: result.reason === 'session' ? 'session not found' : 'bot not registered' });
      } else {
        jsonResponse(res, 503, { error: 'session registry unavailable' });
      }
      return true;
    }
    jsonResponse(res, 200, result.payload);
    return true;
  }

  // ── 4) GET /web/transcript/:chatId ───────────────────────────────────
  // Server-rendered HTML with data inlined. Used to survive mobile webviews
  // (Baidu, some Feishu configurations on CN networks) that drop XHR/fetch.
  // Returns early so this beats the static-file fallback.
  const htmlM = url.match(/^\/web\/transcript\/([^/?#]+)/);
  if (method === 'GET' && htmlM) {
    const chatId    = decodeURIComponent(htmlM[1]);
    const parsed    = new URL(url, 'http://localhost');
    const turnParam = parsed.searchParams.get('turn') || 'all';
    const turn: number | 'all' = turnParam === 'all' ? 'all' : Math.max(1, parseInt(turnParam, 10) || 1);

    const result = resolveTranscript(ctx, req, chatId, turn, turnParam);

    // For 401 (cookie-gated bots only — disableAuth bots never return this),
    // redirect the browser to OAuth directly. No XHR needed.
    if (!result.ok && result.status === 401) {
      res.writeHead(302, { Location: result.loginUrl });
      res.end();
      return true;
    }

    // Build the inline payload. For non-200 cases we still serve the HTML
    // shell but tell the frontend what went wrong via the embedded JSON.
    type InlineData =
      | { kind: 'ok'; payload: TranscriptResolveOk['payload'] }
      | { kind: 'forbidden' }
      | { kind: 'notFound' }
      | { kind: 'unavailable' };
    let inline: InlineData;
    if (result.ok) inline = { kind: 'ok', payload: result.payload };
    else if (result.status === 403) inline = { kind: 'forbidden' };
    else if (result.status === 404) inline = { kind: 'notFound' };
    else inline = { kind: 'unavailable' };

    const html = readIndexHtmlWithData(inline);
    if (html == null) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Web UI not built. Run `npm run build:web` first.');
      return true;
    }
    // Strongest no-cache combo — Baidu/Feishu webviews on CN networks have
    // been observed ignoring plain "no-cache" and serving stale HTML that
    // points at deleted bundle hashes after a redeploy.
    res.writeHead(200, {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma:          'no-cache',
      Expires:         '0',
    });
    res.end(html);
    return true;
  }

  return false;
}
