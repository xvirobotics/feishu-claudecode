import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMemoryServer } from '../src/memory/memory-server.js';
import { proxyMemoryRequest } from '../src/api/routes/memory-proxy.js';
import { fanOutFederatedSearch } from '../src/api/routes/search-routes.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('fanOutFederatedSearch (Stage 3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  async function startMemoryWithBridge(opts: {
    label: string;
    adminToken: string;
    peerTokenLookup?: (token: string) => { instanceId?: string; peerName: string } | undefined;
  }): Promise<{ memoryUrl: string; bridgeUrl: string }> {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), `fed-search-${opts.label}-`));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const memOpts: any = {
      port: 0,
      databaseDir,
      adminToken: opts.adminToken,
      logger: createLogger(),
    };
    if (opts.peerTokenLookup) memOpts.peerTokenLookup = opts.peerTokenLookup;
    const { server: memServer, storage } = startMemoryServer(memOpts);
    cleanups.push(() => storage.close());
    cleanups.push(() => memServer.close());
    await new Promise<void>((resolve) => memServer.once('listening', resolve));
    const memAddr = memServer.address() as AddressInfo;
    const memoryUrl = `http://127.0.0.1:${memAddr.port}`;

    const bridge = http.createServer((req, res) => {
      const url = req.url || '/';
      if (!url.startsWith('/memory')) {
        res.writeHead(404).end();
        return;
      }
      proxyMemoryRequest(req, res, url, req.method || 'GET', {
        memoryUrl,
        memoryAuthToken: opts.adminToken,
        logger: createLogger(),
      }).catch((err) => {
        res.writeHead(500).end(err.message);
      });
    });
    bridge.listen(0);
    cleanups.push(() => bridge.close());
    await new Promise<void>((resolve) => bridge.once('listening', resolve));
    const bridgeAddr = bridge.address() as AddressInfo;
    const bridgeUrl = `http://127.0.0.1:${bridgeAddr.port}`;
    return { memoryUrl, bridgeUrl };
  }

  async function seedDoc(memoryUrl: string, adminToken: string, title: string, content: string) {
    const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };
    const folderResp = await fetch(`${memoryUrl}/api/folders`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: `f-${title}` }),
    });
    const folder = await folderResp.json() as { id: string };
    await fetch(`${memoryUrl}/api/documents`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ title, folder_id: folder.id, content }),
    });
  }

  it('merges local + live-peer hits and tags each by source', async () => {
    const local = await startMemoryWithBridge({ label: 'local', adminToken: 'local-admin' });
    const peer = await startMemoryWithBridge({
      label: 'peer',
      adminToken: 'peer-admin',
      peerTokenLookup: (t) => (t === 'A-reader-token' ? { peerName: 'A', instanceId: 'A-id' } : undefined),
    });
    await seedDoc(local.memoryUrl, 'local-admin', 'localhit', 'shared term unicorn');
    await seedDoc(peer.memoryUrl, 'peer-admin', 'peerhit', 'shared term unicorn');

    const fakePeerMgr = {
      getLivePeersWithSecret: () => [
        { name: 'bobs-bot', url: peer.bridgeUrl, secret: 'A-reader-token' },
      ],
      searchCachedPeerMemory: () => [],
    };

    const response = await fanOutFederatedSearch({
      query: 'unicorn',
      limit: 20,
      memoryUrl: local.memoryUrl,
      memoryAuthToken: 'local-admin',
      peerManager: fakePeerMgr as any,
      logger: createLogger(),
    });

    expect(response.local.ok).toBe(true);
    expect(response.peers).toHaveLength(1);
    expect(response.peers[0].ok).toBe(true);

    const sources = response.results.map((r) => `${r.source}:${r.title}`).sort();
    expect(sources).toContain('local:localhit');
    expect(sources).toContain('peer:peerhit');
    const peerHit = response.results.find((r) => r.source === 'peer');
    expect(peerHit?.peerName).toBe('bobs-bot');
  });

  it('falls back to cache-stale for peers that are unreachable; suppresses cache when peer responded live', async () => {
    const local = await startMemoryWithBridge({ label: 'local2', adminToken: 'local-admin' });
    await seedDoc(local.memoryUrl, 'local-admin', 'localonly', 'rare term zebra');

    // alpha is unreachable → cache-stale should be emitted.
    // beta is live with zero hits → cache-stale must NOT be emitted (dedup).
    const peer = await startMemoryWithBridge({
      label: 'peer2',
      adminToken: 'peer-admin',
      peerTokenLookup: (t) => (t === 'B-reader-token' ? { peerName: 'B' } : undefined),
    });

    const fakePeerMgr = {
      getLivePeersWithSecret: () => [
        // beta points at a live (empty) memory-server
        { name: 'beta', url: peer.bridgeUrl, secret: 'B-reader-token' },
      ],
      searchCachedPeerMemory: () => [
        {
          id: 'alpha-doc-1', title: 'cached-alpha-zebra', path: '/alpha/zebra',
          snippet: 'cached snippet zebra', tags: ['z'],
          created_by: 'alpha-bot', updated_at: '2026-05-16T00:00:00Z',
          peerName: 'alpha', peerUrl: 'http://offline.invalid',
          stale: true, cachedAt: 1, lastSeenAt: 1,
        },
        {
          // Should be dedup'd: beta returned live (with zero hits), so its
          // stale entry must be suppressed.
          id: 'beta-doc-1', title: 'cached-beta-zebra', path: '/beta/zebra',
          snippet: 'cached beta zebra', tags: ['z'],
          created_by: 'beta-bot', updated_at: '2026-05-16T00:00:00Z',
          peerName: 'beta', peerUrl: peer.bridgeUrl,
          stale: false, cachedAt: 1, lastSeenAt: 1,
        },
      ],
    };

    const response = await fanOutFederatedSearch({
      query: 'zebra',
      limit: 20,
      memoryUrl: local.memoryUrl,
      memoryAuthToken: 'local-admin',
      peerManager: fakePeerMgr as any,
      logger: createLogger(),
    });

    expect(response.local.ok).toBe(true);
    expect(response.peers.find((p) => p.peerName === 'beta')?.ok).toBe(true);
    expect(response.cacheStaleCount).toBe(1);

    const titles = response.results.map((r) => r.title);
    expect(titles).toContain('localonly');
    expect(titles).toContain('cached-alpha-zebra');
    expect(titles).not.toContain('cached-beta-zebra');
    const alphaHit = response.results.find((r) => r.title === 'cached-alpha-zebra');
    expect(alphaHit?.source).toBe('cache-stale');
    expect(alphaHit?.peerName).toBe('alpha');
  });

  it('returns local-only when peerManager has no live peers (standalone deployment)', async () => {
    const local = await startMemoryWithBridge({ label: 'local3', adminToken: 'local-admin' });
    await seedDoc(local.memoryUrl, 'local-admin', 'solo', 'flamingo');

    const fakePeerMgr = {
      getLivePeersWithSecret: () => [],
      searchCachedPeerMemory: () => [],
    };

    const response = await fanOutFederatedSearch({
      query: 'flamingo',
      limit: 20,
      memoryUrl: local.memoryUrl,
      memoryAuthToken: 'local-admin',
      peerManager: fakePeerMgr as any,
      logger: createLogger(),
    });

    expect(response.peers).toEqual([]);
    expect(response.cacheStaleCount).toBe(0);
    expect(response.results).toHaveLength(1);
    expect(response.results[0].source).toBe('local');
  });

  it('records peer error in the per-peer summary when the live fetch fails (timeout / network)', async () => {
    const local = await startMemoryWithBridge({ label: 'local4', adminToken: 'local-admin' });
    const fakePeerMgr = {
      // 127.0.0.1:1 is reliably unreachable.
      getLivePeersWithSecret: () => [
        { name: 'gone', url: 'http://127.0.0.1:1', secret: 'doesntmatter' },
      ],
      searchCachedPeerMemory: () => [],
    };

    const response = await fanOutFederatedSearch({
      query: 'whatever',
      limit: 20,
      memoryUrl: local.memoryUrl,
      memoryAuthToken: 'local-admin',
      peerManager: fakePeerMgr as any,
      logger: createLogger(),
    });

    expect(response.local.ok).toBe(true);
    expect(response.peers).toHaveLength(1);
    expect(response.peers[0].ok).toBe(false);
    expect(response.peers[0].error).toBeTruthy();
  });
});
