import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handlePeerMemoryRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!url.startsWith('/api/peer-memory')) return false;

  const { peerManager } = ctx;
  if (!peerManager) {
    jsonResponse(res, 503, { error: 'Peer manager not available' });
    return true;
  }

  if (method === 'GET' && url.startsWith('/api/peer-memory/search')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const query = params.get('q') || '';
    const limit = Math.min(Math.max(parseInt(params.get('limit') || '20', 10) || 20, 1), 100);
    if (!query.trim()) {
      jsonResponse(res, 400, { error: 'Missing q' });
      return true;
    }
    jsonResponse(res, 200, { results: peerManager.searchCachedPeerMemory(query, limit) });
    return true;
  }

  if (method === 'GET' && /^\/api\/peer-memory\/documents\/[^/]+\/[^/]+$/.test(url)) {
    const parts = url.split('/');
    const peerName = decodeURIComponent(parts[4]);
    const docId = decodeURIComponent(parts[5]);
    const doc = peerManager.getCachedPeerMemoryDocument(peerName, docId);
    if (!doc) {
      jsonResponse(res, 404, { error: `Cached memory document not found: ${peerName}/${docId}` });
      return true;
    }
    jsonResponse(res, 200, doc);
    return true;
  }

  jsonResponse(res, 404, { error: 'Peer memory endpoint not found' });
  return true;
}
