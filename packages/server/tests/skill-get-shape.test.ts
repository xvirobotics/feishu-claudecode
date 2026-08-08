import { afterEach, describe, expect, it } from 'vitest';
import { call, startTestServer, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;

afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});

const SKILL_MD = `---
name: shape-skill
description: A skill used to assert GET /api/skills/:name shape
tags: alpha, beta
---

# Shape skill

This is the body of the skill, which must be returned verbatim as skillMd.
`;

describe('GET /api/skills/:name returns full SkillRecord (gap-check for Web UI)', () => {
  it('includes skillMd plus full metadata fields', async () => {
    kit = await startTestServer('skill-shape');

    // Mint a member with publishSkill capability.
    const issue = await call(kit.baseUrl, 'POST', '/admin/credentials/issue', kit.adminToken, {
      botName: 'shape-bot',
      ownerName: 'shape-owner',
      role: 'member',
      publishSkill: true,
    });
    expect(issue.status).toBe(201);
    const memberToken = issue.body.token as string;

    const pub = await call(kit.baseUrl, 'POST', '/api/skills/shape-skill/publish', memberToken, {
      skillMd: SKILL_MD,
      visibility: 'private',
    });
    expect(pub.status).toBe(201);

    const got = await call(kit.baseUrl, 'GET', '/api/skills/shape-skill', memberToken);
    expect(got.status).toBe(200);

    const record = got.body;
    // Identity / addressing
    expect(typeof record.id).toBe('string');
    expect(record.name).toBe('shape-skill');
    expect(record.version).toBe(1);
    // Description + tags pulled from frontmatter
    expect(record.description).toBe('A skill used to assert GET /api/skills/:name shape');
    expect(Array.isArray(record.tags)).toBe(true);
    expect(record.tags.sort()).toEqual(['alpha', 'beta']);
    // Authorship / ownership
    expect(record.author).toBe('shape-bot');
    expect(record.ownerBotName).toBe('shape-bot');
    expect(typeof record.ownerCredentialId).toBe('string');
    // Distribution
    expect(record.visibility).toBe('private');
    expect(typeof record.contentHash).toBe('string');
    expect(record.contentHash.length).toBeGreaterThan(0);
    // Boolean flags
    expect(typeof record.userInvocable).toBe('boolean');
    expect(record.hasReferences).toBe(false);
    // Timestamps
    expect(typeof record.publishedAt).toBe('string');
    expect(typeof record.updatedAt).toBe('string');
    // The critical Web-UI-load-bearing field:
    expect(record.skillMd).toBe(SKILL_MD);
  });
});
