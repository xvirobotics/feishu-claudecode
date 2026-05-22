/**
 * metabot-manager HTTP server.
 *
 * Native `node:http` (no Express). Route table dispatches by method+url match.
 * Static SPA at `/web/*` from `dist/web/`. `/manager/*` always falls back to
 * `dist/web/index.html` so React Router can pick up the route.
 *
 * Auth model:
 *  - `/api/manager/auth/login`  → public (issues cookie).
 *  - `/api/manager/auth/me`     → public (returns 401 on no cookie).
 *  - `/api/manager/auth/logout` → public (clears cookie).
 *  - everything else under `/api/manager/*` → cookie required (401 otherwise).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { parseJsonBody, jsonResponse } from '../api/routes/helpers.js';
import {
  buildClearCookie,
  buildSessionCookie,
  requireAuth,
  signManagerSession,
  verifyPassword,
} from './auth.js';
import type { ManagerCredentials } from './credentials.js';
import { listPm2, findPm2, startOrReloadBot, stopBot, type Pm2ProcInfo } from './pm2-control.js';
import { botsConfigPath, getBot, loadBotsJson, maskBotForClient, patchBot } from './bots-config.js';
import {
  listJsonls,
  listSessions,
  resetSessions,
  sessionJsonlExists,
  setSession,
} from './session-control.js';
import { attachLogStreamUpgrade } from './log-stream.js';
import type { Logger } from '../utils/logger.js';

interface ManagerServerOpts {
  port:        number;
  host:        string;
  creds:       ManagerCredentials;
  logger:      Logger;
  ecosystemPath: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.map':   'application/json',
};

// ─── helpers ────────────────────────────────────────────────────────────────

function isAuthRoute(url: string): boolean {
  return url.startsWith('/api/manager/auth/');
}

function pickStatus(proc: Pm2ProcInfo | null): string {
  if (!proc) return 'stopped';
  return proc.status || 'unknown';
}

interface BotSummary {
  name:          string;
  status:        string;
  pid?:          number;
  uptimeMs?:     number;
  cpu?:          number;
  memMb?:        number;
  restarts?:     number;
  apiPort?:      number;
  memoryPort?:   number;
  workdir?:      string;
  feishuAppId?: string;
  sessionCount?: number;
  lastError?:    string;
}

function toMb(bytes: number | undefined): number | undefined {
  if (bytes == null) return undefined;
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}

function toIntOrUndef(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function buildBotSummaries(): Promise<BotSummary[]> {
  const { feishuBots } = loadBotsJson();
  const procs = await listPm2();
  const byName = new Map(procs.map((p) => [p.name, p]));

  return feishuBots.map((b) => {
    const proc = byName.get(b.name) || null;
    let sessionCount = 0;
    try { sessionCount = listSessions(b.name).length; } catch { /* ignore */ }
    const summary: BotSummary = {
      name:         b.name,
      status:       pickStatus(proc),
      pid:          proc?.pid,
      uptimeMs:     proc?.uptimeMs,
      cpu:          proc?.cpu,
      memMb:        toMb(proc?.memoryBytes),
      restarts:     proc?.restarts,
      apiPort:      toIntOrUndef(proc?.env.API_PORT),
      memoryPort:   toIntOrUndef(proc?.env.MEMORY_PORT),
      workdir:      b.defaultWorkingDirectory,
      feishuAppId:  b.feishuAppId,
      sessionCount,
    };
    return summary;
  });
}

// ─── route handlers ─────────────────────────────────────────────────────────

type Ctx = {
  creds:         ManagerCredentials;
  logger:        Logger;
  ecosystemPath: string;
};

async function handleAuthRoutes(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: string): Promise<boolean> {
  if (method === 'POST' && url === '/api/manager/auth/login') {
    const body = await parseJsonBody(req);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return true;
    }
    if (username !== ctx.creds.username) {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return true;
    }
    const ok = await verifyPassword(password, ctx.creds.passwordHashBcrypt);
    if (!ok) {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return true;
    }
    const token  = signManagerSession(ctx.creds.username, ctx.creds.sessionSecret);
    const cookie = buildSessionCookie(token);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie });
    res.end(JSON.stringify({ ok: true, username: ctx.creds.username }));
    return true;
  }

  if (method === 'POST' && url === '/api/manager/auth/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': buildClearCookie() });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (method === 'GET' && url === '/api/manager/auth/me') {
    const session = requireAuth(req, ctx.creds.sessionSecret);
    if (!session) {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return true;
    }
    jsonResponse(res, 200, { username: session.username });
    return true;
  }

  return false;
}

async function handleBotsRoutes(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: string): Promise<boolean> {
  // List bots
  if (method === 'GET' && url === '/api/manager/bots') {
    const bots = await buildBotSummaries();
    jsonResponse(res, 200, { bots });
    return true;
  }

  // /api/manager/bots/:name(/...) — capture name + subpath
  const m = url.match(/^\/api\/manager\/bots\/([^/?#]+)(\/[^?#]*)?(?:\?.*)?$/);
  if (!m) return false;
  const name    = decodeURIComponent(m[1]);
  const subPath = m[2] || '';

  // /api/manager/bots/:name (detail)
  if (method === 'GET' && subPath === '') {
    const bot = getBot(name);
    if (!bot) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    const proc     = await findPm2(name);
    let sessions: ReturnType<typeof listSessions> = [];
    try { sessions = listSessions(name); } catch { /* ignore */ }
    jsonResponse(res, 200, {
      config:    maskBotForClient(bot),
      status:    {
        name,
        status:      pickStatus(proc),
        pid:         proc?.pid,
        uptimeMs:    proc?.uptimeMs,
        cpu:         proc?.cpu,
        memMb:       toMb(proc?.memoryBytes),
        restarts:    proc?.restarts,
        apiPort:     toIntOrUndef(proc?.env.API_PORT),
        memoryPort:  toIntOrUndef(proc?.env.MEMORY_PORT),
        workdir:     bot.defaultWorkingDirectory,
        feishuAppId: bot.feishuAppId,
        sessionCount: sessions.length,
      },
      sessions,
      logPath:   proc?.pmOutLogPath,
      errorLogPath: proc?.pmErrLogPath,
    });
    return true;
  }

  // /api/manager/bots/:name/start | stop | restart
  if (method === 'POST' && (subPath === '/start' || subPath === '/restart')) {
    if (!getBot(name)) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    await startOrReloadBot(name, ctx.ecosystemPath);
    // Brief delay so pm2 jlist reflects the new pid before we report status.
    await sleep(400);
    const proc = await findPm2(name);
    jsonResponse(res, 200, { status: procToSummary(name, proc, getBot(name)) });
    return true;
  }
  if (method === 'POST' && subPath === '/stop') {
    if (!getBot(name)) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    try { await stopBot(name); }
    catch (err: unknown) {
      // pm2 errors on stop-of-stopped — tolerate, surface to log.
      ctx.logger.warn({ err: (err as Error).message, name }, 'manager stopBot non-fatal');
    }
    await sleep(200);
    const proc = await findPm2(name);
    jsonResponse(res, 200, { status: procToSummary(name, proc, getBot(name)) });
    return true;
  }

  // PATCH /api/manager/bots/:name/workdir
  if (method === 'PATCH' && subPath === '/workdir') {
    const body    = await parseJsonBody(req);
    const workdir = typeof body.workdir === 'string' ? body.workdir : '';
    if (!workdir || !path.isAbsolute(workdir)) {
      jsonResponse(res, 422, { error: 'invalid', message: 'workdir must be an absolute path' });
      return true;
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(workdir); }
    catch {
      jsonResponse(res, 422, { error: 'invalid', message: `workdir does not exist: ${workdir}` });
      return true;
    }
    if (!stat.isDirectory()) {
      jsonResponse(res, 422, { error: 'invalid', message: `workdir is not a directory: ${workdir}` });
      return true;
    }
    if (!getBot(name)) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    patchBot(name, { defaultWorkingDirectory: workdir });
    // CRITICAL: wipe both session maps + sessions.db (see
    // memory/feedback_workdir_change.md). Without this the SDK keeps chasing
    // the old workdir and crashes with "native binary not found".
    resetSessions(name);
    await startOrReloadBot(name, ctx.ecosystemPath);
    await sleep(400);
    const proc = await findPm2(name);
    jsonResponse(res, 200, {
      status:           procToSummary(name, proc, getBot(name)),
      sessionsCleared:  true,
    });
    return true;
  }

  // PATCH /api/manager/bots/:name/env
  if (method === 'PATCH' && subPath === '/env') {
    const body    = await parseJsonBody(req);
    const envRaw  = body.env;
    const remove  = Array.isArray(body.removeKeys) ? body.removeKeys.filter((k: unknown): k is string => typeof k === 'string') : [];
    let env: Record<string, string> | undefined;
    if (envRaw !== undefined) {
      if (!envRaw || typeof envRaw !== 'object' || Array.isArray(envRaw)) {
        jsonResponse(res, 422, { error: 'invalid', message: 'env must be an object' });
        return true;
      }
      env = {};
      for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          jsonResponse(res, 422, { error: 'invalid', message: `env.${k} must be a string` });
          return true;
        }
        env[k] = v;
      }
    }
    if (!getBot(name)) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    patchBot(name, { env, removeEnvKeys: remove });
    await startOrReloadBot(name, ctx.ecosystemPath);
    await sleep(400);
    const proc = await findPm2(name);
    jsonResponse(res, 200, { status: procToSummary(name, proc, getBot(name)) });
    return true;
  }

  // PATCH /api/manager/bots/:name/session
  if (method === 'PATCH' && subPath === '/session') {
    const body = await parseJsonBody(req);
    const chatId    = typeof body.chatId    === 'string' ? body.chatId    : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!chatId || !sessionId) {
      jsonResponse(res, 422, { error: 'invalid', message: 'chatId and sessionId required' });
      return true;
    }
    const bot = getBot(name);
    if (!bot) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    const workdir = bot.defaultWorkingDirectory;
    if (!workdir) {
      jsonResponse(res, 422, { error: 'invalid', message: 'bot has no defaultWorkingDirectory' });
      return true;
    }
    if (!sessionJsonlExists(workdir, sessionId)) {
      jsonResponse(res, 422, { error: 'invalid', message: `jsonl not found for sessionId=${sessionId} under workdir=${workdir}` });
      return true;
    }
    setSession(name, chatId, sessionId, workdir);
    await startOrReloadBot(name, ctx.ecosystemPath);
    await sleep(400);
    const proc = await findPm2(name);
    jsonResponse(res, 200, { status: procToSummary(name, proc, getBot(name)) });
    return true;
  }

  // POST /api/manager/bots/:name/session/reset
  if (method === 'POST' && subPath === '/session/reset') {
    const body = await parseJsonBody(req).catch(() => ({}));
    const chatId = typeof (body as Record<string, unknown>).chatId === 'string' ? (body as Record<string, unknown>).chatId as string : undefined;
    if (!getBot(name)) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    const result = resetSessions(name, chatId);
    await startOrReloadBot(name, ctx.ecosystemPath);
    await sleep(400);
    const proc = await findPm2(name);
    jsonResponse(res, 200, {
      status:           procToSummary(name, proc, getBot(name)),
      sessionsCleared:  result.cleared,
      dbDeleted:        result.dbDeleted,
    });
    return true;
  }

  // GET /api/manager/bots/:name/sessions/jsonls
  if (method === 'GET' && subPath === '/sessions/jsonls') {
    const bot = getBot(name);
    if (!bot) {
      jsonResponse(res, 404, { error: 'not_found' });
      return true;
    }
    if (!bot.defaultWorkingDirectory) {
      jsonResponse(res, 200, { jsonls: [] });
      return true;
    }
    jsonResponse(res, 200, { jsonls: listJsonls(bot.defaultWorkingDirectory) });
    return true;
  }

  return false;
}

function procToSummary(name: string, proc: Pm2ProcInfo | null, bot: ReturnType<typeof getBot>): BotSummary {
  return {
    name,
    status:       pickStatus(proc),
    pid:          proc?.pid,
    uptimeMs:     proc?.uptimeMs,
    cpu:          proc?.cpu,
    memMb:        toMb(proc?.memoryBytes),
    restarts:     proc?.restarts,
    apiPort:      toIntOrUndef(proc?.env.API_PORT),
    memoryPort:   toIntOrUndef(proc?.env.MEMORY_PORT),
    workdir:      bot?.defaultWorkingDirectory,
    feishuAppId:  bot?.feishuAppId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── static file serving for SPA ────────────────────────────────────────────

function serveSpa(req: http.IncomingMessage, res: http.ServerResponse, url: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const webRoot = path.resolve(process.cwd(), 'dist', 'web');

  // /manager → /manager/
  if (url === '/manager') {
    res.writeHead(301, { Location: '/manager/' });
    res.end();
    return true;
  }

  // /web → /web/
  if (url === '/web') {
    res.writeHead(301, { Location: '/web/' });
    res.end();
    return true;
  }

  // Direct asset serving for /web/<file> and /manager/<asset>.
  // Strip query for path resolution.
  const cleanUrl = url.includes('?') ? url.slice(0, url.indexOf('?')) : url;

  // /manager/* → always SPA index.html (React Router)
  if (cleanUrl === '/manager/' || cleanUrl.startsWith('/manager/')) {
    // If the request is for an actual file under dist/web (e.g. /manager/assets/x.js),
    // serve it; otherwise fall back to index.html.
    const relative = cleanUrl.slice('/manager/'.length);
    if (relative) {
      const candidate = path.resolve(webRoot, relative);
      if (candidate.startsWith(webRoot) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return sendFile(res, candidate);
      }
    }
    return sendIndex(res, webRoot);
  }

  // /web/* — same logic, used by the existing per-bot UI build.
  if (cleanUrl.startsWith('/web/')) {
    const relative = cleanUrl.slice('/web/'.length);
    if (!relative || relative === '') return sendIndex(res, webRoot);
    const candidate = path.resolve(webRoot, relative);
    if (!candidate.startsWith(webRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return true;
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return sendFile(res, candidate);
    }
    if (relative.startsWith('assets/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return true;
    }
    return sendIndex(res, webRoot);
  }

  return false;
}

function sendFile(res: http.ServerResponse, full: string): boolean {
  try {
    const ext         = path.extname(full).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isHashed    = /\/assets\/.+-[a-zA-Z0-9]{8,}\./.test(full);
    const content     = fs.readFileSync(full);
    if (isHashed) {
      res.writeHead(200, {
        'Content-Type':  contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } else {
      res.writeHead(200, {
        'Content-Type':  contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma:          'no-cache',
        Expires:         '0',
      });
    }
    res.end(content);
    return true;
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error');
    return true;
  }
}

function sendIndex(res: http.ServerResponse, webRoot: string): boolean {
  const indexPath = path.resolve(webRoot, 'index.html');
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      res.writeHead(200, {
        'Content-Type':  'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma:          'no-cache',
        Expires:         '0',
      });
      res.end(content);
      return true;
    }
  } catch { /* fall through */ }
  res.writeHead(503, { 'Content-Type': 'text/plain' });
  res.end('Web UI not built. Run `npm run build:web` first.');
  return true;
}

// ─── server bootstrap ───────────────────────────────────────────────────────

export function startManagerServer(opts: ManagerServerOpts): http.Server {
  const ctx: Ctx = { creds: opts.creds, logger: opts.logger, ecosystemPath: opts.ecosystemPath };

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url    = req.url    || '/';

    try {
      // Lightweight health check (no auth)
      if (method === 'GET' && url === '/api/manager/health') {
        jsonResponse(res, 200, { ok: true, service: 'metabot-manager', uptime: Math.floor((Date.now() - startedAt) / 1000) });
        return;
      }

      // Auth gating: everything under /api/manager/* except auth + health
      // requires a valid session cookie.
      if (url.startsWith('/api/manager/') && !isAuthRoute(url)) {
        const session = requireAuth(req, ctx.creds.sessionSecret);
        if (!session) {
          jsonResponse(res, 401, { error: 'unauthorized' });
          return;
        }
      }

      if (await handleAuthRoutes(ctx, req, res, method, url)) return;
      if (await handleBotsRoutes(ctx, req, res, method, url)) return;

      // SPA / static fallback
      if (serveSpa(req, res, url)) return;

      // Redirect root → /manager/
      if (method === 'GET' && url === '/') {
        res.writeHead(302, { Location: '/manager/' });
        res.end();
        return;
      }

      jsonResponse(res, 404, { error: 'not_found' });
    } catch (err: unknown) {
      const e         = err as { statusCode?: number; message?: string };
      const statusCode = e.statusCode || 500;
      if (statusCode >= 500) {
        opts.logger.error({ err, method, url }, 'manager request error');
      }
      jsonResponse(res, statusCode, {
        error:   statusCode === 500 ? 'internal' : 'request_failed',
        message: e.message || 'Internal error',
      });
    }
  });

  // Attach WebSocket upgrade for log tailing.
  attachLogStreamUpgrade(server, { sessionSecret: ctx.creds.sessionSecret, logger: opts.logger });

  server.listen(opts.port, opts.host, () => {
    opts.logger.info({ host: opts.host, port: opts.port }, 'metabot-manager listening');
  });

  return server;
}

const startedAt = Date.now();

export function _pathHelpers(): { botsConfig: string } {
  return { botsConfig: botsConfigPath() };
}
