/**
 * Hub routes — owner-facing panoramic view of every bot on this host.
 *
 * Lives inside the metabot-manager process (port MANAGER_PORT, default 11000)
 * because that's where the per-host bot inventory + pm2 view already exists.
 * Each per-bot API process (`:10001+`) has no business listing siblings.
 *
 * Auth model:
 *   - Uses the unified Feishu OAuth middleware (`requireFeishuAuth`),
 *     **not** the manager's admin `mb_mgr_session` cookie.
 *   - The owner is the principal that matters; they may already be logged in
 *     via Feishu for the transcript page, and the cookie carries over.
 *   - Whitelist is the union of every hubVisible bot's `accessAllowOpenIds`.
 *     Bots with `hubVisible: true` but empty `accessAllowOpenIds` contribute
 *     nothing — a host with zero-trust gets a fail-closed Hub by default.
 *
 * Single-machine scope: `hostId = os.hostname().toLowerCase()`, `hosts` array
 * always returns exactly 1 element. The `peers[]` field in `bots.json` is out
 * of scope for Phase 1.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import { jsonResponse } from '../../api/routes/helpers.js';
import { requireFeishuAuth, unionAllowLists } from '../../api/middleware/feishu-auth.js';
import { loadBotsJson, type BotJsonEntry } from '../bots-config.js';
import { listPm2 } from '../pm2-control.js';
import { listSessions, type SessionMapping } from '../session-control.js';
import {
  buildHubHost,
  hubAccessAllowListUnion,
  type HubHost,
  type HubProcInfo,
} from '@metabot/shared/hub';

// Re-export public types so legacy importers keep working unchanged.
export type { HubBot, HubHost } from '@metabot/shared/hub';

// ─── helpers ────────────────────────────────────────────────────────────────

function hostId(): string {
  return os.hostname().toLowerCase();
}

function hostName(): string {
  return os.hostname();
}

let cachedAgentVersion: string | null = null;
function readAgentVersion(): string {
  if (cachedAgentVersion !== null) return cachedAgentVersion;
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    cachedAgentVersion = `metabot ${pkg.version || '0.0.0'}`;
  } catch {
    cachedAgentVersion = 'metabot unknown';
  }
  return cachedAgentVersion;
}

function osDescription(): string {
  return `${os.type()} ${os.release()}`;
}

function isHubVisible(bot: BotJsonEntry): boolean {
  return bot.hubVisible === true;
}

/**
 * The Hub OAuth driver bot — the first hubVisible feishu bot found. Used to
 * build the loginUrl (Feishu needs an appId + appSecret to drive the dance).
 * Falls back to the first feishu bot if no hubVisible bot exists yet, so the
 * Hub UI still has something to redirect through when a fresh host hasn't
 * flipped any toggles yet — but we still 403 because the allowlist is empty.
 */
function pickOAuthDriverBot(feishuBots: BotJsonEntry[]): BotJsonEntry | null {
  const visible = feishuBots.find(isHubVisible);
  if (visible) return visible;
  return feishuBots[0] || null;
}

function build401Or403(req: http.IncomingMessage, feishuBots: BotJsonEntry[], returnPath: string): { status: 401 | 403; body: { error: string; loginUrl?: string } } | null {
  const allowList = hubAccessAllowListUnion(feishuBots);
  const driver    = pickOAuthDriverBot(feishuBots);
  if (!driver) {
    // No feishu bots at all on this host — nothing to gate, but also nothing
    // to OAuth through. Surface as 503 in the caller; here we just return
    // null so the caller can branch.
    return { status: 403, body: { error: 'no feishu bot configured on this host' } };
  }
  const authRes = requireFeishuAuth(req, {
    allowOpenIds: allowList,
    returnPath,
    botName:      driver.name,
  });
  if (authRes.ok) return null;
  if (authRes.status === 401) {
    return { status: 401, body: { error: 'unauthenticated', loginUrl: authRes.loginUrl } };
  }
  return { status: 403, body: { error: 'forbidden' } };
}

async function buildSingleHost(): Promise<HubHost> {
  const { feishuBots } = loadBotsJson();
  const pm2Procs       = await listPm2();
  const procs: HubProcInfo[] = pm2Procs.map((p) => ({
    name:        p.name,
    status:      p.status,
    uptimeMs:    p.uptimeMs,
    cpu:         p.cpu,
    memoryBytes: p.memoryBytes,
    restarts:    p.restarts,
  }));
  const sessionCountByBot: Record<string, number> = {};
  for (const b of feishuBots) {
    try { sessionCountByBot[b.name] = listSessions(b.name).length; }
    catch { sessionCountByBot[b.name] = 0; }
  }

  return buildHubHost({
    hostId:           hostId(),
    hostName:         hostName(),
    agentVersion:     readAgentVersion(),
    osDescription:    osDescription(),
    feishuBots,
    procs,
    sessionCountByBot,
    lastSeen:         new Date().toISOString(),
  });
}

// ─── route handler ──────────────────────────────────────────────────────────

/**
 * Dispatch GET /api/hub/*. Returns `true` if the request matched a Hub route
 * (and the response was written), `false` otherwise so the caller can try
 * other routers / static fallback.
 */
export async function handleHubRoutes(
  req:    http.IncomingMessage,
  res:    http.ServerResponse,
  method: string,
  url:    string,
): Promise<boolean> {
  if (!url.startsWith('/api/hub/')) return false;

  // ── GET /api/hub/hosts ────────────────────────────────────────────────
  if (method === 'GET' && url === '/api/hub/hosts') {
    const { feishuBots } = loadBotsJson();
    const gate = build401Or403(req, feishuBots, '/web/hub/dashboard');
    if (gate) {
      jsonResponse(res, gate.status, gate.body);
      return true;
    }
    const host = await buildSingleHost();
    jsonResponse(res, 200, { hosts: [host] });
    return true;
  }

  // ── GET /api/hub/hosts/:hostId ────────────────────────────────────────
  const hostMatch = url.match(/^\/api\/hub\/hosts\/([^/?#]+)$/);
  if (method === 'GET' && hostMatch) {
    const requested = decodeURIComponent(hostMatch[1]);
    const { feishuBots } = loadBotsJson();
    const gate = build401Or403(req, feishuBots, `/web/hub/hosts/${encodeURIComponent(requested)}`);
    if (gate) {
      jsonResponse(res, gate.status, gate.body);
      return true;
    }
    if (requested.toLowerCase() !== hostId()) {
      jsonResponse(res, 404, { error: 'host not found' });
      return true;
    }
    const host = await buildSingleHost();
    jsonResponse(res, 200, { host });
    return true;
  }

  // ── GET /api/hub/bots/:name/sessions ──────────────────────────────────
  // The Hub-side session list lives here (PR C is Manager-only). Auth is
  // scoped to the target bot's accessAllowOpenIds — not the union — so each
  // bot's owner sees only their own sessions even from the Hub surface.
  const sessionsMatch = url.match(/^\/api\/hub\/bots\/([^/?#]+)\/sessions$/);
  if (method === 'GET' && sessionsMatch) {
    const botName        = decodeURIComponent(sessionsMatch[1]);
    const { feishuBots } = loadBotsJson();
    const bot            = feishuBots.find((b) => b.name === botName);
    // 404 if the bot isn't hubVisible — manager-only bots must not leak via Hub.
    if (!bot || !isHubVisible(bot)) {
      jsonResponse(res, 404, { error: 'bot not found' });
      return true;
    }
    const driver    = pickOAuthDriverBot(feishuBots) || bot;
    const allowList = unionAllowLists(bot, /*forTranscript=*/false);
    const returnPath = `/web/hub/hosts/${encodeURIComponent(hostId())}`;
    const authRes   = requireFeishuAuth(req, {
      allowOpenIds: allowList,
      returnPath,
      botName:      driver.name,
    });
    if (!authRes.ok) {
      if (authRes.status === 401) {
        jsonResponse(res, 401, { error: 'unauthenticated', loginUrl: authRes.loginUrl });
        return true;
      }
      jsonResponse(res, 403, { error: 'forbidden' });
      return true;
    }
    let sessions: SessionMapping[] = [];
    try { sessions = listSessions(botName); } catch { /* ignore — return [] */ }
    jsonResponse(res, 200, { sessions });
    return true;
  }

  return false;
}
