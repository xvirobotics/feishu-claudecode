import { afterEach, describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import { call, startTestServer, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;

afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});

const SKILL_MD = `---
name: refs-skill
description: A skill with references payload
tags: x
---

# Body
`;

function gzipFiles(files: Array<{ path: string; content: string }>): string {
  const json = JSON.stringify({ files });
  return zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

describe('GET /api/skills/:name/references', () => {
  it('returns the unpacked file list when the skill has references', async () => {
    kit = await startTestServer('skill-refs');

    const issue = await call(kit.baseUrl, 'POST', '/admin/credentials/issue', kit.adminToken, {
      botName: 'refs-bot', ownerName: 'refs-owner', role: 'member', publishSkill: true,
    });
    expect(issue.status).toBe(201);
    const memberToken = issue.body.token as string;

    const referencesTar = gzipFiles([
      { path: 'README.md', content: '# refs readme' },
      { path: 'inner/note.txt', content: 'hello' },
    ]);
    const pub = await call(kit.baseUrl, 'POST', '/api/skills/refs-skill/publish', memberToken, {
      skillMd: SKILL_MD,
      referencesTar,
      visibility: 'private',
    });
    expect(pub.status).toBe(201);

    const refs = await call(kit.baseUrl, 'GET', '/api/skills/refs-skill/references', memberToken);
    expect(refs.status).toBe(200);
    expect(refs.body.name).toBe('refs-skill');
    expect(refs.body.version).toBe(1);
    expect(Array.isArray(refs.body.files)).toBe(true);
    expect(refs.body.files).toEqual([
      { path: 'README.md', content: '# refs readme' },
      { path: 'inner/note.txt', content: 'hello' },
    ]);
  });

  it('returns 404 no_references when the skill has no references payload', async () => {
    kit = await startTestServer('skill-refs-none');

    const issue = await call(kit.baseUrl, 'POST', '/admin/credentials/issue', kit.adminToken, {
      botName: 'refs-bot', ownerName: 'refs-owner', role: 'member', publishSkill: true,
    });
    const memberToken = issue.body.token as string;

    await call(kit.baseUrl, 'POST', '/api/skills/bare-skill/publish', memberToken, {
      skillMd: `---\nname: bare-skill\ndescription: bare\n---\nbody`,
      visibility: 'private',
    });

    const refs = await call(kit.baseUrl, 'GET', '/api/skills/bare-skill/references', memberToken);
    expect(refs.status).toBe(404);
    expect(refs.body.error).toBe('no_references');
  });

  it('returns 404 skill_not_found for a missing skill', async () => {
    kit = await startTestServer('skill-refs-missing');
    const refs = await call(kit.baseUrl, 'GET', '/api/skills/nope/references', kit.adminToken);
    expect(refs.status).toBe(404);
    expect(refs.body.error).toBe('skill_not_found');
  });

  it('rejects references that expand beyond the decompressed size limit', async () => {
    kit = await startTestServer('skill-refs-too-large');

    const issue = await call(kit.baseUrl, 'POST', '/admin/credentials/issue', kit.adminToken, {
      botName: 'refs-bot', ownerName: 'refs-owner', role: 'member', publishSkill: true,
    });
    const memberToken = issue.body.token as string;

    // Highly compressible input keeps the request fixture small while crossing
    // the 10 MiB decompressed-output boundary by a single byte.
    const referencesTar = zlib
      .gzipSync(Buffer.alloc(10 * 1024 * 1024 + 1))
      .toString('base64');
    const pub = await call(kit.baseUrl, 'POST', '/api/skills/oversized-refs/publish', memberToken, {
      skillMd: `---\nname: oversized-refs\ndescription: oversized refs\n---\nbody`,
      referencesTar,
      visibility: 'private',
    });
    expect(pub.status).toBe(201);

    const refs = await call(kit.baseUrl, 'GET', '/api/skills/oversized-refs/references', memberToken);
    expect(refs.status).toBe(413);
    expect(refs.body.error).toBe('references_too_large');
  });

  it('keeps reporting malformed gzip payloads as corrupt references', async () => {
    kit = await startTestServer('skill-refs-corrupt');

    const issue = await call(kit.baseUrl, 'POST', '/admin/credentials/issue', kit.adminToken, {
      botName: 'refs-bot', ownerName: 'refs-owner', role: 'member', publishSkill: true,
    });
    const memberToken = issue.body.token as string;
    const referencesTar = Buffer.from('not a gzip payload').toString('base64');

    const pub = await call(kit.baseUrl, 'POST', '/api/skills/corrupt-refs/publish', memberToken, {
      skillMd: `---\nname: corrupt-refs\ndescription: corrupt refs\n---\nbody`,
      referencesTar,
      visibility: 'private',
    });
    expect(pub.status).toBe(201);

    const refs = await call(kit.baseUrl, 'GET', '/api/skills/corrupt-refs/references', memberToken);
    expect(refs.status).toBe(500);
    expect(refs.body.error).toBe('references_corrupt');
  });
});
