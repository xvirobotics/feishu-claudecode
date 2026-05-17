import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMemoryServer } from '../src/memory/memory-server.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

/**
 * Phase 0 — Default-Private Folder semantics.
 *
 * Folders created without an explicit `visibility` now default to `private`,
 * meaning cross-instance peer-token readers cannot see them. `mm share`
 * (PUT /api/folders/<id> { visibility: 'shared' }) opts a folder in.
 *
 * These tests cover the new default + the share/unshare flip.
 */
describe('Phase 0 default-private folders', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }
  });

  async function startServerWithPeerToken() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-default-private-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const peerTokenLookup = (token: string) =>
      token === 'alice-reader-token' ? { peerName: 'alice', instanceId: 'alice-id' } : undefined;

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

  async function startInstanceTokenServer() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-default-private-inst-'));
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
    return { url: `http://127.0.0.1:${address.port}` };
  }

  const adminHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' };
  const peerHeaders = { Authorization: 'Bearer alice-reader-token' };

  it('folder created without visibility defaults to private', async () => {
    const { url } = await startServerWithPeerToken();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'unspecified' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string; visibility: string };
    expect(folder.visibility).toBe('private');
  });

  it('explicit visibility=shared is honored on create', async () => {
    const { url } = await startServerWithPeerToken();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'opt-in-shared', visibility: 'shared' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string; visibility: string };
    expect(folder.visibility).toBe('shared');
  });

  it('admin sees default-private folders in tree (local backward compat)', async () => {
    const { url } = await startServerWithPeerToken();

    await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'admin-visible' }),
    });

    const tree = await fetch(`${url}/api/folders`, { headers: { Authorization: 'Bearer admin-token' } });
    expect(tree.status).toBe(200);
    expect(JSON.stringify(await tree.json())).toContain('admin-visible');
  });

  it('peer-token reader cannot see default-private folder', async () => {
    const { url } = await startServerWithPeerToken();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'hidden-from-peer' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string };

    await fetch(`${url}/api/documents`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ title: 'Private doc', folder_id: folder.id, content: 'shh' }),
    });

    const peerTree = await fetch(`${url}/api/folders`, { headers: peerHeaders });
    expect(peerTree.status).toBe(200);
    expect(JSON.stringify(await peerTree.json())).not.toContain('hidden-from-peer');
  });

  it('mm share (PUT visibility=shared) makes a default-private folder peer-visible', async () => {
    const { url } = await startServerWithPeerToken();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'will-be-shared' }),
    });
    const folder = await folderResp.json() as { id: string };

    // Before share: invisible to peer.
    const before = await fetch(`${url}/api/folders`, { headers: peerHeaders });
    expect(JSON.stringify(await before.json())).not.toContain('will-be-shared');

    // Flip to shared.
    const shareResp = await fetch(`${url}/api/folders/${folder.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ visibility: 'shared' }),
    });
    expect(shareResp.status).toBe(200);

    // After share: visible to peer.
    const after = await fetch(`${url}/api/folders`, { headers: peerHeaders });
    expect(JSON.stringify(await after.json())).toContain('will-be-shared');
  });

  it('mm unshare (PUT visibility=private) hides a shared folder again', async () => {
    const { url } = await startServerWithPeerToken();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'will-be-unshared', visibility: 'shared' }),
    });
    const folder = await folderResp.json() as { id: string };

    // Initially shared, peer sees it.
    const before = await fetch(`${url}/api/folders`, { headers: peerHeaders });
    expect(JSON.stringify(await before.json())).toContain('will-be-unshared');

    const unshareResp = await fetch(`${url}/api/folders/${folder.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(unshareResp.status).toBe(200);

    const after = await fetch(`${url}/api/folders`, { headers: peerHeaders });
    expect(JSON.stringify(await after.json())).not.toContain('will-be-unshared');
  });

  it('instance-token can create default-private folders in its namespace', async () => {
    const { url } = await startInstanceTokenServer();

    // Build the namespace path /instances/alice using the instance token,
    // creating each folder default-private along the way.
    const instanceHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer instance-token' };

    const instancesResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'instances' }),
    });
    expect(instancesResp.status).toBe(201);
    const instances = await instancesResp.json() as { id: string; visibility: string };
    expect(instances.visibility).toBe('private');

    const aliceResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'alice', parent_id: instances.id }),
    });
    expect(aliceResp.status).toBe(201);
    const alice = await aliceResp.json() as { id: string; visibility: string };
    expect(alice.visibility).toBe('private');
  });
});
