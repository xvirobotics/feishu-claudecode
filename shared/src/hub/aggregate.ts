/**
 * Pure hub aggregator — converts a host's already-collected bot list, pm2
 * snapshot and per-bot session counts into the `HubHost` shape served by
 * `GET /api/hub/hosts(/:hostId)?`.
 *
 * The route shell (`src/manager/routes/hub.ts`) supplies the inputs via its
 * existing I/O helpers (`loadBotsJson`, `listPm2`, `listSessions`); the cloud
 * server will eventually do the same via a WS `request{route:"hub.host"}`
 * from each registered local instance.
 *
 * "Pure" means: no fs / process reads here. `hostId`, `hostName`,
 * `agentVersion`, `os` are all passed in by the caller.
 */
import type { HubBot, HubBotInput, HubHost, HubProcInfo } from './types.js';

/**
 * Sensitive bot fields that MUST NEVER appear on the wire. Hardcoded for
 * Phase 1; PR D-or-later may let a bot opt extra fields in/out via
 * `hubFields` config. Exported so callers + tests can reference the same
 * source of truth.
 */
export const HUB_HIDDEN_FIELDS: readonly string[] = ['feishuAppSecret', 'env'];

function pickStatus(proc: HubProcInfo | null): HubBot['status'] {
  if (!proc) return 'stopped';
  const s = proc.status;
  switch (s) {
    case 'online':
    case 'stopped':
    case 'launching':
    case 'errored':
      return s === 'errored' ? 'error' : s;
    default:
      return 'unknown';
  }
}

function toMb(bytes: number | undefined): number | undefined {
  if (bytes == null) return undefined;
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function isHubVisible(bot: HubBotInput): boolean {
  return bot.hubVisible === true;
}

/** Compose the safe view of a single bot for Hub consumers. */
export function botToHubBot(bot: HubBotInput, proc: HubProcInfo | null, sessionCount: number): HubBot {
  const out: HubBot = {
    name:         bot.name,
    status:       pickStatus(proc),
    uptimeMs:     proc?.uptimeMs,
    cpu:          proc?.cpu,
    memMb:        toMb(proc?.memoryBytes),
    restarts:     proc?.restarts,
    sessions:     sessionCount,
    hiddenFields: [...HUB_HIDDEN_FIELDS],
  };
  if (bot.defaultWorkingDirectory) out.workdir = bot.defaultWorkingDirectory;
  if (typeof bot.publicBaseUrl === 'string' && bot.publicBaseUrl) {
    out.transcriptBaseUrl = bot.publicBaseUrl.replace(/\/+$/, '');
  }
  return out;
}

export interface BuildHubHostInput {
  hostId:       string;
  hostName:     string;
  agentVersion: string;
  /** `os.type() + ' ' + os.release()` — caller-built so shared has no os dep. */
  osDescription: string;
  /** All feishu bots from `bots.json`, including hubVisible: false ones (used for `hiddenBotCount`). */
  feishuBots:   HubBotInput[];
  /** All pm2 entries on the host. Indexed by `name`. */
  procs:        HubProcInfo[];
  /** Per-bot session count. Missing key → 0. */
  sessionCountByBot: Record<string, number>;
  /** ISO timestamp — caller passes `new Date().toISOString()`. */
  lastSeen:     string;
}

export function buildHubHost(input: BuildHubHostInput): HubHost {
  const byName = new Map(input.procs.map((p) => [p.name, p]));
  const visibleEntries = input.feishuBots.filter(isHubVisible);
  const visibleBots    = visibleEntries.map((b) =>
    botToHubBot(b, byName.get(b.name) || null, input.sessionCountByBot[b.name] || 0),
  );
  const hiddenBotCount = Math.max(0, input.feishuBots.length - visibleEntries.length);
  return {
    hostId:         input.hostId,
    hostName:       input.hostName,
    online:         true,
    lastSeen:       input.lastSeen,
    agentVersion:   input.agentVersion,
    os:             input.osDescription,
    visibleBots,
    hiddenBotCount,
  };
}

/**
 * Compute the union of every hubVisible bot's `accessAllowOpenIds`. The Hub
 * landing endpoint (`/api/hub/hosts`) auths against this union; the per-bot
 * sessions endpoint (`/api/hub/bots/:name/sessions`) auths against the
 * **target bot's** allowlist alone (see test
 * `hub-routes.test.ts:enforces the target bot allowlist (not the union)`).
 */
export function hubAccessAllowListUnion(feishuBots: HubBotInput[]): string[] {
  const set = new Set<string>();
  for (const bot of feishuBots) {
    if (!isHubVisible(bot)) continue;
    for (const id of bot.accessAllowOpenIds || []) set.add(id);
  }
  return Array.from(set);
}
