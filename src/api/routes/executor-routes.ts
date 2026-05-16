import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';
import { resolvePersistentExecutorEnvDefault } from '../../bridge/message-bridge.js';

/**
 * Stage 4 — observability for the persistent-executor pool.
 *
 *   GET /api/executors
 *     → snapshot of every persistent Claude process MetaBot is currently
 *       holding open (one per active chatId, when persistent mode is on).
 *
 * Returns an empty array when no bot has yet acquired an executor (the
 * registry is lazy-init — first ever turn after MetaBot start populates it).
 */
export async function handleExecutorRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method !== 'GET' || !url.startsWith('/api/executors')) return false;

  const out: Array<{
    botName: string;
    platform: string;
    chatId: string;
    state: string;
    sessionId?: string;
    hasActiveTurn: boolean;
    lastActivityAt: number;
    idleSec: number;
  }> = [];
  const now = Date.now();

  for (const bot of ctx.registry.listRegistered()) {
    const reg = bot.bridge.getPersistentRegistry?.();
    if (!reg) continue;
    for (const e of reg.list()) {
      out.push({
        botName: bot.name,
        platform: bot.platform,
        chatId: e.chatId,
        state: e.state,
        sessionId: e.sessionId,
        hasActiveTurn: e.hasActiveTurn,
        lastActivityAt: e.lastActivityAt,
        idleSec: Math.round((now - e.lastActivityAt) / 1000),
      });
    }
  }

  // Shared env-resolution helper — keeps this in sync with
  // MessageBridge.isPersistentExecutorEnabled(). Per-bot `bots.json`
  // overrides aren't reflected here; this snapshot is the env default
  // only, and individual bots may differ.
  jsonResponse(res, 200, {
    persistentExecutorEnabled: resolvePersistentExecutorEnvDefault(
      process.env.METABOT_PERSISTENT_EXECUTOR,
    ),
    count: out.length,
    executors: out,
  });
  return true;
}
