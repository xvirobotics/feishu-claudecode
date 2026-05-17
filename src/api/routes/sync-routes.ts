import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import { proxyMemoryRequest } from './memory-proxy.js';
import type { RouteContext } from './types.js';

export async function handleSyncRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger, docSync, feishuServiceClient, memoryServerUrl, memoryAuthToken } = ctx;

  // GET /api/stats — cost and usage aggregation
  if (method === 'GET' && url === '/api/stats') {
    const stats: Record<string, unknown> = {};
    for (const bot of registry.list()) {
      const registered = registry.get(bot.name);
      if (registered?.bridge?.costTracker) {
        stats[bot.name] = registered.bridge.costTracker.getStats();
      }
    }
    jsonResponse(res, 200, stats);
    return true;
  }

  // GET /api/metrics — Prometheus exposition format
  if (method === 'GET' && url === '/api/metrics') {
    const { metrics } = await import('../../utils/metrics.js');
    const startTime = (globalThis as any).__metabot_start_time || Date.now();
    metrics.setGauge('metabot_uptime_seconds', Math.floor((Date.now() - startTime) / 1000));
    const body = metrics.serialize();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(body);
    return true;
  }

  // POST /api/sync — trigger wiki sync
  if (method === 'POST' && url === '/api/sync') {
    if (!docSync) {
      jsonResponse(res, 400, { error: 'Wiki sync is not configured' });
      return true;
    }
    if (docSync.isSyncing()) {
      jsonResponse(res, 409, { error: 'Sync already in progress' });
      return true;
    }
    const syncPromise = docSync.syncAll();
    syncPromise.then((result) => {
      logger.info({ result }, 'API-triggered wiki sync complete');
    }).catch((err) => {
      logger.error({ err }, 'API-triggered wiki sync failed');
    });
    jsonResponse(res, 202, { status: 'sync_started' });
    return true;
  }

  // GET /api/sync — get sync status
  if (method === 'GET' && url === '/api/sync') {
    if (!docSync) {
      jsonResponse(res, 400, { error: 'Wiki sync is not configured' });
      return true;
    }
    const stats = docSync.getStats();
    jsonResponse(res, 200, {
      syncing: docSync.isSyncing(),
      wikiSpaceId: stats.wikiSpaceId,
      documentCount: stats.documentCount,
      folderCount: stats.folderCount,
    });
    return true;
  }

  // POST /api/sync/document — sync a single document
  if (method === 'POST' && url === '/api/sync/document') {
    if (!docSync) {
      jsonResponse(res, 400, { error: 'Wiki sync is not configured' });
      return true;
    }
    const body = await parseJsonBody(req);
    const docId = body.docId as string;
    if (!docId) {
      jsonResponse(res, 400, { error: 'Missing required field: docId' });
      return true;
    }
    const result = await docSync.syncDocument(docId);
    jsonResponse(res, result.success ? 200 : 500, result);
    return true;
  }

  // GET /api/feishu/document — deprecated, use lark-cli (lark-doc skill)
  if (method === 'GET' && url.startsWith('/api/feishu/document')) {
    jsonResponse(res, 501, { error: 'Use lark-cli (lark-doc skill) to read Feishu documents.' });
    return true;
  }

  // Proxy /memory/* to MetaMemory server (preserves inbound Authorization for
  // Pragmatic v1; see src/api/routes/memory-proxy.ts).
  if (url.startsWith('/memory/') || url === '/memory') {
    const memoryUrl = memoryServerUrl || process.env.META_MEMORY_URL || 'http://localhost:8100';
    await proxyMemoryRequest(req, res, url, method, {
      memoryUrl,
      ...(memoryAuthToken ? { memoryAuthToken } : {}),
      logger,
    });
    return true;
  }

  return false;
}
