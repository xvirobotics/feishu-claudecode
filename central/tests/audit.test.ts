import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startTestServer, call, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;

afterEach(async () => {
  if (kit) {
    await kit.cleanup();
    kit = undefined;
  }
});

describe('audit log', () => {
  it('appends entries with credential id + role + status', async () => {
    kit = await startTestServer('audit-basic');
    // Make a couple of requests
    await call(kit.baseUrl, 'GET', '/api/skills', kit.adminToken);
    await call(kit.baseUrl, 'GET', '/api/manifest', null);          // open route, not audited
    await call(kit.baseUrl, 'GET', '/api/memory/folders', kit.adminToken);
    await call(kit.baseUrl, 'GET', '/api/skills', 'mt_nope');       // bad token

    // wait a tick for finish handlers
    await new Promise((r) => setTimeout(r, 100));

    // Find today's audit file
    const auditDir = path.join(kit.dir, 'audit');
    const files = fs.readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);

    const raw = fs.readFileSync(path.join(auditDir, files[0]), 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const entries = lines.map((l) => JSON.parse(l));
    const ops = entries.map((e) => e.op);
    expect(ops).toContain('list');

    // Successful authed routes have non-anonymous credentialId.
    // /api/manifest is open (no auth) so it stays anonymous and is filtered.
    const authedOk = entries.filter(
      (e) => e.status >= 200 && e.status < 300 && e.path !== '/api/manifest',
    );
    expect(authedOk.length).toBeGreaterThan(0);
    for (const e of authedOk) {
      expect(e.credentialId).not.toBe('anonymous');
      expect(e.role).toBe('admin');
    }

    // 401 entries stay anonymous
    const denied = entries.filter((e) => e.status === 401);
    expect(denied.length).toBeGreaterThan(0);
    for (const e of denied) expect(e.credentialId).toBe('anonymous');
  });
});
