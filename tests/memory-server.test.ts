import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMemoryServer } from '../src/memory/memory-server.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('MetaMemory server request limits', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }
  });

  async function startTestServer() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      logger: createLogger(),
    });

    cleanups.push(() => storage.close());
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${address.port}`,
    };
  }

  async function startAuthenticatedTestServer() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-auth-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      secret: 'test-secret',
      logger: createLogger(),
    });

    cleanups.push(() => storage.close());
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${address.port}`,
    };
  }

  async function startNamespaceTestServer() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-namespace-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      adminToken: 'admin-token',
      instanceToken: 'instance-token',
      instanceId: 'alice',
      memoryNamespace: '/instances/alice',
      logger: createLogger(),
    });

    cleanups.push(() => storage.close());
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${address.port}`,
    };
  }

  async function startMultiNamespaceTestServer() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-namespace-list-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      adminToken: 'admin-token',
      instanceToken: 'instance-token',
      instanceId: 'alice',
      memoryNamespaces: ['/instances/alice', '/projects/metabot'],
      logger: createLogger(),
    });

    cleanups.push(() => storage.close());
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${address.port}`,
    };
  }

  it('returns 400 for invalid JSON bodies', async () => {
    const { url } = await startTestServer();

    const response = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      detail: 'Invalid JSON in request body',
    });
  });

  it('returns 413 for oversized JSON bodies', async () => {
    const { url } = await startTestServer();
    const oversizedPayload = JSON.stringify({
      name: 'x',
      description: 'a'.repeat(10 * 1024 * 1024),
    });

    const response = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      detail: 'Request body too large (max 10 MB)',
    });
  });

  it('allows unauthenticated health checks while keeping other API routes protected', async () => {
    const { url } = await startAuthenticatedTestServer();

    const healthResponse = await fetch(`${url}/api/health`);
    expect(healthResponse.status).toBe(200);

    const foldersResponse = await fetch(`${url}/api/folders`);
    expect(foldersResponse.status).toBe(401);
    await expect(foldersResponse.json()).resolves.toEqual({
      detail: 'Unauthorized',
    });
  });

  it('allows instance tokens to write only their own namespace', async () => {
    const { url } = await startNamespaceTestServer();
    const instanceHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer instance-token',
    };

    const instancesResponse = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'instances' }),
    });
    expect(instancesResponse.status).toBe(201);
    const instances = await instancesResponse.json() as { id: string };

    const aliceResponse = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'alice', parent_id: instances.id }),
    });
    expect(aliceResponse.status).toBe(201);
    const alice = await aliceResponse.json() as { id: string };

    const docResponse = await fetch(`${url}/api/documents`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({
        title: 'Alice Notes',
        folder_id: alice.id,
        content: 'owned by alice',
      }),
    });
    expect(docResponse.status).toBe(201);

    const bobResponse = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'bob', parent_id: instances.id }),
    });
    expect(bobResponse.status).toBe(400);
    await expect(bobResponse.json()).resolves.toEqual({
      detail: 'Access denied: cannot create folder outside writable namespace',
    });
  });

  it('allows instance tokens to write all configured namespaces', async () => {
    const { url } = await startMultiNamespaceTestServer();
    const instanceHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer instance-token',
    };

    const projectsResponse = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'projects' }),
    });
    expect(projectsResponse.status).toBe(201);
    const projects = await projectsResponse.json() as { id: string };

    const metabotResponse = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'metabot', parent_id: projects.id }),
    });
    expect(metabotResponse.status).toBe(201);
    const metabot = await metabotResponse.json() as { id: string };

    const docResponse = await fetch(`${url}/api/documents`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({
        title: 'Project Notes',
        folder_id: metabot.id,
        content: 'owned by project',
      }),
    });
    expect(docResponse.status).toBe(201);
  });

  // --- Pragmatic v1 peer-token regression coverage ---

  async function startPeerTokenTestServer(peerTokenLookup: (token: string) => { instanceId?: string; peerName: string } | undefined) {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-peer-token-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      adminToken: 'admin-token',
      peerTokenLookup,
      logger: createLogger(),
    });

    cleanups.push(() => storage.close());
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}` };
  }

  it('peer-token lookup authenticates known peer as reader, rejects unknown tokens', async () => {
    const { url } = await startPeerTokenTestServer((token) =>
      token === 'alice-reader-token' ? { peerName: 'alice', instanceId: 'alice-id' } : undefined,
    );

    const reject = await fetch(`${url}/api/folders`, {
      headers: { Authorization: 'Bearer not-a-peer' },
    });
    expect(reject.status).toBe(401);

    const accept = await fetch(`${url}/api/folders`, {
      headers: { Authorization: 'Bearer alice-reader-token' },
    });
    expect(accept.status).toBe(200);
  });

  it('peer-token reader cannot read folders marked visibility=private (Pragmatic v1 read ACL)', async () => {
    const { url } = await startPeerTokenTestServer((token) =>
      token === 'alice-reader-token' ? { peerName: 'alice', instanceId: 'alice-id' } : undefined,
    );

    // Admin creates a private folder + doc inside it.
    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer admin-token',
    };
    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'drafts', visibility: 'private' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string };

    const docResp = await fetch(`${url}/api/documents`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ title: 'Private', folder_id: folder.id, content: 'secret' }),
    });
    expect(docResp.status).toBe(201);
    const doc = await docResp.json() as { id: string };

    // Peer-token reader sees the folder list but the private folder is omitted.
    const foldersResp = await fetch(`${url}/api/folders`, {
      headers: { Authorization: 'Bearer alice-reader-token' },
    });
    expect(foldersResp.status).toBe(200);
    const folderTree = await foldersResp.json();
    expect(JSON.stringify(folderTree)).not.toContain('drafts');

    // Direct doc fetch by the peer-token reader is denied / not found.
    const docFetch = await fetch(`${url}/api/documents/${doc.id}`, {
      headers: { Authorization: 'Bearer alice-reader-token' },
    });
    expect([401, 403, 404]).toContain(docFetch.status);
  });

  it('peer-token reader can read shared folders (default visibility)', async () => {
    const { url } = await startPeerTokenTestServer((token) =>
      token === 'alice-reader-token' ? { peerName: 'alice', instanceId: 'alice-id' } : undefined,
    );

    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer admin-token',
    };
    // Default folder visibility is 'shared'.
    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'public-notes' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string };

    await fetch(`${url}/api/documents`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ title: 'Hello peer', folder_id: folder.id, content: 'visible' }),
    });

    const foldersResp = await fetch(`${url}/api/folders`, {
      headers: { Authorization: 'Bearer alice-reader-token' },
    });
    expect(foldersResp.status).toBe(200);
    expect(JSON.stringify(await foldersResp.json())).toContain('public-notes');
  });

  it('peer-token reader cannot write (Pragmatic v1 — reads only)', async () => {
    const { url } = await startPeerTokenTestServer((token) =>
      token === 'alice-reader-token' ? { peerName: 'alice', instanceId: 'alice-id' } : undefined,
    );

    const writeAttempt = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer alice-reader-token',
      },
      body: JSON.stringify({ name: 'should-fail' }),
    });
    expect([400, 401, 403]).toContain(writeAttempt.status);
  });
});
