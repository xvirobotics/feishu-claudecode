import { describe, it, expect, afterEach } from 'vitest';
import { startTestServer, call, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;

afterEach(async () => {
  if (kit) {
    await kit.cleanup();
    kit = undefined;
  }
});

describe('E2E flow', () => {
  it('admin issues member, member can read/write own ns, gets 403 elsewhere', async () => {
    kit = await startTestServer('e2e');
    const { baseUrl, adminToken } = kit;

    // Health is open
    expect((await call(baseUrl, 'GET', '/health', null)).status).toBe(200);
    // Manifest is open
    expect((await call(baseUrl, 'GET', '/api/manifest', null)).status).toBe(200);
    // Memory list without auth → 401
    expect((await call(baseUrl, 'GET', '/api/memory/folders', null)).status).toBe(401);

    // Admin issues a member credential
    const issueRes = await call(baseUrl, 'POST', '/admin/credentials/issue', adminToken, {
      botName: 'dkj-laptop',
      ownerName: 'dkj',
      role: 'member',
      publishSkill: true,
    });
    expect(issueRes.status).toBe(201);
    const memberToken = issueRes.body.token as string;
    expect(memberToken).toMatch(/^mt_/);
    const memberId = issueRes.body.credential.id as string;

    // Member creates doc in own namespace
    const createRes = await call(baseUrl, 'POST', '/api/memory/documents', memberToken, {
      path: '/users/dkj-laptop/private/note',
      title: 'note',
      content: 'hello world',
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.path).toBe('/users/dkj-laptop/private/note');

    // Member reads back via path
    const getRes = await call(baseUrl, 'GET', '/api/memory/documents/%2Fusers%2Fdkj-laptop%2Fprivate%2Fnote', memberToken);
    expect(getRes.status).toBe(200);
    expect(getRes.body.content).toBe('hello world');

    // Member writes to /shared → 403
    const forbiddenWrite = await call(baseUrl, 'POST', '/api/memory/documents', memberToken, {
      path: '/shared/notes/sneaky',
      title: 'sneaky',
      content: 'x',
    });
    expect(forbiddenWrite.status).toBe(403);

    // Member writes to another user's ns → 403
    const otherUser = await call(baseUrl, 'POST', '/api/memory/documents', memberToken, {
      path: '/users/floodsung/private/spy',
      title: 'spy',
      content: 'x',
    });
    expect(otherUser.status).toBe(403);

    // Admin creates /shared doc; member can read
    const sharedCreate = await call(baseUrl, 'POST', '/api/memory/documents', adminToken, {
      path: '/shared/notes/welcome',
      title: 'welcome',
      content: 'team rules',
    });
    expect(sharedCreate.status).toBe(201);
    const sharedRead = await call(baseUrl, 'GET', '/api/memory/documents/%2Fshared%2Fnotes%2Fwelcome', memberToken);
    expect(sharedRead.status).toBe(200);
    expect(sharedRead.body.content).toBe('team rules');

    // Member publishes a skill (has publishSkill: true)
    const publishRes = await call(baseUrl, 'POST', '/api/skills/dkj-favorite-skill/publish', memberToken, {
      skillMd: `---\nname: dkj-favorite-skill\ndescription: dkj's skill\n---\n# Hi`,
    });
    expect(publishRes.status).toBe(201);

    // Anyone with credentials can list skills
    const listRes = await call(baseUrl, 'GET', '/api/skills', memberToken);
    expect(listRes.status).toBe(200);
    expect(listRes.body.skills.find((s: any) => s.name === 'dkj-favorite-skill')).toBeTruthy();

    // Member cannot delete a skill (admin only)
    const memberDelete = await call(baseUrl, 'DELETE', '/api/skills/dkj-favorite-skill', memberToken);
    expect(memberDelete.status).toBe(403);

    // Admin revokes the member; subsequent calls 401
    const revokeRes = await call(baseUrl, 'POST', '/admin/credentials/revoke', adminToken, {
      credentialId: memberId,
    });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await call(baseUrl, 'GET', '/api/memory/folders', memberToken);
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.error).toBe('credential_revoked');
  });

  it('member without publishSkill flag cannot publish skills', async () => {
    kit = await startTestServer('e2e-publish');
    const { baseUrl, adminToken } = kit;

    const issueRes = await call(baseUrl, 'POST', '/admin/credentials/issue', adminToken, {
      botName: 'no-pub', ownerName: 'np', role: 'member',
    });
    const token = issueRes.body.token as string;
    const ok = await call(baseUrl, 'POST', '/api/skills/x/publish', token, {
      skillMd: '---\nname: x\n---\nbody',
    });
    expect(ok.status).toBe(403);
    expect(ok.body.error).toBe('publish_skill_forbidden');

    const granted = await call(baseUrl, 'POST', '/admin/credentials/issue', adminToken, {
      botName: 'can-pub', ownerName: 'cp', role: 'member', publishSkill: true,
    });
    const publish = await call(baseUrl, 'POST', '/api/skills/x/publish', granted.body.token as string, {
      skillMd: '---\nname: x\n---\nbody',
    });
    expect(publish.status).toBe(201);

    // But a different member can NOT overwrite it.
    const other = await call(baseUrl, 'POST', '/admin/credentials/issue', adminToken, {
      botName: 'squatter', ownerName: 'someone-else', role: 'member', publishSkill: true,
    });
    const denied = await call(baseUrl, 'POST', '/api/skills/x/publish', other.body.token as string, {
      skillMd: '---\nname: x\n---\nhostile',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('skill_owned_by_other');
  });

  // Regression: oauth2-proxy v7 decodes %2F → / upstream, and Caddy collapses
  // // → /. Both layers strip the leading slash of a path-style lookup, so the
  // server must treat any slice containing an interior `/` as a path even
  // when the leading `/` is missing. CJK segments must also survive the
  // single decodeURIComponent at the route layer.
  it('memory routes resolve path-style lookups after oauth2-proxy/Caddy strip the leading slash', async () => {
    kit = await startTestServer('e2e-path-strip');
    const { baseUrl, adminToken } = kit;

    const ascii = await call(baseUrl, 'POST', '/api/memory/documents', adminToken, {
      path: '/shared/weekly-updates/2026-05-20',
      title: '2026-05-20',
      content: 'ascii body',
    });
    expect(ascii.status).toBe(201);
    const asciiFolder = await call(baseUrl, 'POST', '/api/memory/folders', adminToken, {
      path: '/shared/cjk-zone/技术文档',
    });
    expect(asciiFolder.status).toBe(201);
    const cjkDoc = await call(baseUrl, 'POST', '/api/memory/documents', adminToken, {
      path: '/shared/cjk-zone/技术文档/笔记',
      title: '笔记',
      content: 'cjk body',
    });
    expect(cjkDoc.status).toBe(201);

    // Browser path AFTER oauth2-proxy/Caddy stripped the leading slash.
    const docStripped = await call(baseUrl, 'GET', '/api/memory/documents/shared/weekly-updates/2026-05-20', adminToken);
    expect(docStripped.status).toBe(200);
    expect(docStripped.body.content).toBe('ascii body');

    const folderStripped = await call(baseUrl, 'GET', '/api/memory/folders/shared/cjk-zone', adminToken);
    expect(folderStripped.status).toBe(200);
    expect(folderStripped.body.path).toBe('/shared/cjk-zone');

    // Top-level folder: leading slash stripped AND no interior slash → must
    // still resolve as a path, not be mistaken for a UUID id.
    const topFolder = await call(baseUrl, 'GET', '/api/memory/folders/shared', adminToken);
    expect(topFolder.status).toBe(200);
    expect(topFolder.body.path).toBe('/shared');

    // CJK: single-encoded per segment, leading slash stripped → still resolves.
    const cjkEncoded = encodeURIComponent('技术文档');
    const cjkFolder = await call(baseUrl, 'GET', `/api/memory/folders/shared/cjk-zone/${cjkEncoded}`, adminToken);
    expect(cjkFolder.status).toBe(200);
    expect(cjkFolder.body.path).toBe('/shared/cjk-zone/技术文档');

    const cjkDocRes = await call(baseUrl, 'GET', `/api/memory/documents/shared/cjk-zone/${cjkEncoded}/${encodeURIComponent('笔记')}`, adminToken);
    expect(cjkDocRes.status).toBe(200);
    expect(cjkDocRes.body.content).toBe('cjk body');

    // UUID lookup (no interior slash) must NOT get a leading slash prepended.
    const byId = await call(baseUrl, 'GET', `/api/memory/documents/${ascii.body.id}`, adminToken);
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe(ascii.body.id);
  });
});
