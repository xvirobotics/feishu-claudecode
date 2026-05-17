import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMemoryServer } from '../src/memory/memory-server.js';
import { proxyMemoryRequest } from '../src/api/routes/memory-proxy.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('memory proxy Authorization passthrough (Pragmatic v1)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  async function startStack(opts: {
    peerTokenLookup: (token: string) => { instanceId?: string; peerName: string } | undefined;
    memoryAuthToken?: string;
  }): Promise<{ proxyUrl: string; memoryUrl: string }> {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memproxy-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server: memServer, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      adminToken: 'admin-token',
      peerTokenLookup: opts.peerTokenLookup,
      logger: createLogger(),
    });
    cleanups.push(() => storage.close());
    cleanups.push(() => memServer.close());
    await new Promise<void>((resolve) => memServer.once('listening', resolve));
    const memAddr = memServer.address() as AddressInfo;
    const memoryUrl = `http://127.0.0.1:${memAddr.port}`;

    const proxyServer = http.createServer((req, res) => {
      const url = req.url || '/';
      if (!url.startsWith('/memory')) {
        res.writeHead(404).end();
        return;
      }
      proxyMemoryRequest(req, res, url, req.method || 'GET', {
        memoryUrl,
        ...(opts.memoryAuthToken ? { memoryAuthToken: opts.memoryAuthToken } : {}),
        logger: createLogger(),
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    proxyServer.listen(0);
    cleanups.push(() => proxyServer.close());
    await new Promise<void>((resolve) => proxyServer.once('listening', resolve));
    const proxyAddr = proxyServer.address() as AddressInfo;
    const proxyUrl = `http://127.0.0.1:${proxyAddr.port}`;

    return { proxyUrl, memoryUrl };
  }

  it('forwards a peer reader token verbatim so private folders stay hidden through the proxy', async () => {
    const { proxyUrl, memoryUrl } = await startStack({
      peerTokenLookup: (token) =>
        token === 'alice-reader-token' ? { peerName: 'alice', instanceId: 'alice-id' } : undefined,
      memoryAuthToken: 'admin-token',
    });

    // Admin (going direct to memory-server) creates a private folder + doc.
    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer admin-token',
    };
    const folderResp = await fetch(`${memoryUrl}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'drafts', visibility: 'private' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string };

    const docResp = await fetch(`${memoryUrl}/api/documents`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ title: 'private-secret', folder_id: folder.id, content: 'topsecret' }),
    });
    expect(docResp.status).toBe(201);

    // Peer hits the bridge proxy with its reader token. Pre-fix this was
    // rewritten to admin-token and the peer saw everything; post-fix the
    // header is forwarded verbatim and folder-visibility filters it.
    const proxiedFolders = await fetch(`${proxyUrl}/memory/api/folders`, {
      headers: { Authorization: 'Bearer alice-reader-token' },
    });
    expect(proxiedFolders.status).toBe(200);
    const proxiedTree = await proxiedFolders.json();
    expect(JSON.stringify(proxiedTree)).not.toContain('drafts');

    const proxiedSearch = await fetch(`${proxyUrl}/memory/api/search?q=topsecret`, {
      headers: { Authorization: 'Bearer alice-reader-token' },
    });
    expect(proxiedSearch.status).toBe(200);
    const searchHits = await proxiedSearch.json() as { results?: Array<{ title: string }> };
    const hits = searchHits.results || (searchHits as any).documents || [];
    expect(JSON.stringify(hits)).not.toContain('private-secret');
  });

  it('returns 401 when peer presents an unknown token, even though admin fallback is configured', async () => {
    const { proxyUrl } = await startStack({
      peerTokenLookup: (token) =>
        token === 'alice-reader-token' ? { peerName: 'alice' } : undefined,
      memoryAuthToken: 'admin-token',
    });

    const resp = await fetch(`${proxyUrl}/memory/api/folders`, {
      headers: { Authorization: 'Bearer not-a-known-peer' },
    });
    expect(resp.status).toBe(401);
  });

  it('falls back to the configured admin token when caller sends no Authorization (web UI use case)', async () => {
    const { proxyUrl } = await startStack({
      peerTokenLookup: () => undefined,
      memoryAuthToken: 'admin-token',
    });

    // No Authorization header — admin fallback should kick in so the local
    // web UI keeps working unauthenticated against the bridge.
    const resp = await fetch(`${proxyUrl}/memory/api/folders`);
    expect(resp.status).toBe(200);
  });
});
