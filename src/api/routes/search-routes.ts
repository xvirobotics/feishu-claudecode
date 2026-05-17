import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import { proxyFetch } from '../../utils/http.js';
import type { RouteContext } from './types.js';
import type { PeerManager } from '../peer-manager.js';

const PEER_FETCH_TIMEOUT_MS = 2_000;
const LOCAL_FETCH_TIMEOUT_MS = 2_000;

export type FederatedSearchSource = 'local' | 'peer' | 'cache-stale';

export interface FederatedSearchHit {
  source: FederatedSearchSource;
  id: string;
  title: string;
  path: string;
  snippet: string;
  tags: string[];
  created_by: string;
  updated_at: string;
  peerName?: string;
  peerUrl?: string;
  lastSeenAt?: number;
  cachedAt?: number;
}

interface FederatedSearchResponse {
  query: string;
  results: FederatedSearchHit[];
  local: { ok: boolean; count: number; error?: string };
  peers: Array<{ peerName: string; peerUrl: string; ok: boolean; count: number; error?: string }>;
  cacheStaleCount: number;
}

interface LocalSearchHit {
  id: string;
  title: string;
  path: string;
  snippet: string;
  tags: string[];
  created_by: string;
  updated_at: string;
}

export async function handleSearchRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method !== 'GET' || !url.startsWith('/api/search/federated')) return false;

  const { peerManager, memoryServerUrl, memoryAuthToken, logger } = ctx;
  const params = new URL(url, 'http://localhost').searchParams;
  const query = (params.get('q') || '').trim();
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '20', 10) || 20, 1), 100);
  if (!query) {
    jsonResponse(res, 400, { error: 'Missing q' });
    return true;
  }

  const memoryUrl = memoryServerUrl || process.env.META_MEMORY_URL || 'http://localhost:8100';
  const response = await fanOutFederatedSearch({
    query,
    limit,
    memoryUrl,
    memoryAuthToken,
    peerManager,
    logger,
  });
  jsonResponse(res, 200, response);
  return true;
}

interface FanOutOptions {
  query: string;
  limit: number;
  memoryUrl: string;
  memoryAuthToken?: string;
  peerManager?: PeerManager;
  logger: RouteContext['logger'];
}

/**
 * Server-side fan-out for `mm search`:
 *   1. local memory-server
 *   2. live peers (healthy + cached reader token from Stage 2 handshake)
 *   3. cache-stale entries for peers that did NOT respond live
 *
 * Each hit is tagged with `source: 'local' | 'peer' | 'cache-stale'`. The
 * caller gets a single merged + sorted payload (newest-first by updated_at).
 * Peer reads are auth-gated by their handshake reader token; memory-server
 * still applies the Pragmatic v1 folder-visibility filter on the remote side
 * (PR #298 fixed the proxy header so this actually works cross-instance).
 */
export async function fanOutFederatedSearch(opts: FanOutOptions): Promise<FederatedSearchResponse> {
  const { query, limit, memoryUrl, memoryAuthToken, peerManager, logger } = opts;
  const encodedQ = encodeURIComponent(query);
  const remoteLimit = limit; // cap each shard at the requested limit; we re-sort/slice

  const localTask = (async (): Promise<{ ok: boolean; hits: FederatedSearchHit[]; error?: string }> => {
    try {
      const headers: Record<string, string> = {};
      if (memoryAuthToken) headers['Authorization'] = `Bearer ${memoryAuthToken}`;
      const resp = await proxyFetch(`${memoryUrl}/api/search?q=${encodedQ}&limit=${remoteLimit}`, {
        headers,
        signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return { ok: false, hits: [], error: `HTTP ${resp.status}` };
      }
      const raw = (await resp.json()) as LocalSearchHit[] | { results?: LocalSearchHit[] };
      const arr = Array.isArray(raw) ? raw : raw.results || [];
      const hits: FederatedSearchHit[] = arr.map((r) => ({ source: 'local', ...r }));
      return { ok: true, hits };
    } catch (err: any) {
      return { ok: false, hits: [], error: err?.message || String(err) };
    }
  })();

  const livePeers = peerManager ? peerManager.getLivePeersWithSecret() : [];
  const peerTasks = livePeers.map((peer) => livePeerSearch(peer, encodedQ, remoteLimit));
  const [localOutcome, ...peerOutcomes] = await Promise.all([localTask, ...peerTasks]);

  const livePeerNames = new Set<string>();
  const peerSummaries: FederatedSearchResponse['peers'] = [];
  const peerHits: FederatedSearchHit[] = [];
  for (const outcome of peerOutcomes) {
    peerSummaries.push({
      peerName: outcome.peerName,
      peerUrl: outcome.peerUrl,
      ok: outcome.ok,
      count: outcome.hits.length,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.ok) {
      livePeerNames.add(outcome.peerName);
      peerHits.push(...outcome.hits);
    } else {
      logger.debug({ peerName: outcome.peerName, err: outcome.error }, 'Peer search failed; will fall back to cache-stale');
    }
  }

  const staleHits: FederatedSearchHit[] = [];
  if (peerManager) {
    const cached = peerManager.searchCachedPeerMemory(query, limit);
    for (const c of cached) {
      // Dedup by peerName: if we got a live response from this peer (even
      // an empty one), suppress the stale rows so we don't show conflicting
      // data. Filter is by peerName (peers can rotate URLs).
      if (livePeerNames.has(c.peerName)) continue;
      staleHits.push({
        source: 'cache-stale',
        id: c.id,
        title: c.title,
        path: c.path,
        snippet: c.snippet,
        tags: c.tags,
        created_by: c.created_by,
        updated_at: c.updated_at,
        peerName: c.peerName,
        peerUrl: c.peerUrl,
        lastSeenAt: c.lastSeenAt,
        cachedAt: c.cachedAt,
      });
    }
  }

  const merged = [...localOutcome.hits, ...peerHits, ...staleHits]
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, limit);

  return {
    query,
    results: merged,
    local: {
      ok: localOutcome.ok,
      count: localOutcome.hits.length,
      ...(localOutcome.error ? { error: localOutcome.error } : {}),
    },
    peers: peerSummaries,
    cacheStaleCount: staleHits.length,
  };
}

interface LivePeerOutcome {
  peerName: string;
  peerUrl: string;
  ok: boolean;
  hits: FederatedSearchHit[];
  error?: string;
}

async function livePeerSearch(
  peer: { name: string; url: string; secret: string },
  encodedQ: string,
  limit: number,
): Promise<LivePeerOutcome> {
  try {
    const resp = await proxyFetch(`${peer.url}/memory/api/search?q=${encodedQ}&limit=${limit}`, {
      headers: {
        Authorization: `Bearer ${peer.secret}`,
        'X-MetaBot-Origin': 'peer',
      },
      signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { peerName: peer.name, peerUrl: peer.url, ok: false, hits: [], error: `HTTP ${resp.status}` };
    }
    const raw = (await resp.json()) as LocalSearchHit[] | { results?: LocalSearchHit[] };
    const arr = Array.isArray(raw) ? raw : raw.results || [];
    const hits: FederatedSearchHit[] = arr.map((r) => ({
      source: 'peer',
      ...r,
      peerName: peer.name,
      peerUrl: peer.url,
    }));
    return { peerName: peer.name, peerUrl: peer.url, ok: true, hits };
  } catch (err: any) {
    return {
      peerName: peer.name,
      peerUrl: peer.url,
      ok: false,
      hits: [],
      error: err?.message || String(err),
    };
  }
}
