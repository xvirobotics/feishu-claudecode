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

  it('member without publishSkill cannot publish', async () => {
    kit = await startTestServer('e2e-publish');
    const { baseUrl, adminToken } = kit;

    const issueRes = await call(baseUrl, 'POST', '/admin/credentials/issue', adminToken, {
      botName: 'no-pub', ownerName: 'np', role: 'member',
    });
    const token = issueRes.body.token as string;
    const denied = await call(baseUrl, 'POST', '/api/skills/x/publish', token, {
      skillMd: '---\nname: x\n---\nbody',
    });
    expect(denied.status).toBe(403);
  });
});
