import { describe, it, expect, afterEach } from 'vitest';
import { makeKit, type TestKit } from './helpers.js';
import {
  canPublishSkill, canOverwriteSkill, visibilityFilter, filterSkillsForCred, isVisibleToCred,
} from '../src/skills/publish-acl.js';
import * as skillRoutes from '../src/skills/skill-routes.js';
import type { Credential } from '../src/auth/credentials.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function issue(kit: TestKit, name: string, role: 'admin' | 'member', publishSkill?: boolean): Credential {
  const { credential } = kit.credentials.issue({
    botName: name, ownerName: name, role,
    publishSkill,
  });
  return kit.credentials.findById(credential.id)!;
}

function issueWithOwner(
  kit: TestKit, botName: string, ownerName: string, role: 'admin' | 'member', publishSkill?: boolean,
): Credential {
  const { credential } = kit.credentials.issue({
    botName, ownerName, role, publishSkill,
  });
  return kit.credentials.findById(credential.id)!;
}

const SKILL_MD = `---
name: my-cool-skill
description: A test skill
tags: a, b
---

# My cool skill

Body content here.
`;

describe('SkillStore + publish-acl', () => {
  it('publish + get + list', () => {
    kit = makeKit('skill-basic');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({
      name: 'my-cool-skill',
      skillMd: SKILL_MD,
      author: admin.botName,
      ownerCredentialId: admin.id,
      ownerBotName: admin.botName,
      visibility: 'published',
    });
    const got = kit.skills.get('my-cool-skill')!;
    expect(got.name).toBe('my-cool-skill');
    expect(got.description).toBe('A test skill');
    expect(got.tags.sort()).toEqual(['a', 'b']);
    expect(got.version).toBe(1);

    const list = kit.skills.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('my-cool-skill');
  });

  it('republish increments version', () => {
    kit = makeKit('skill-version');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({ name: 'x', skillMd: SKILL_MD, ownerCredentialId: admin.id });
    kit.skills.publish({ name: 'x', skillMd: SKILL_MD + '\nv2', ownerCredentialId: admin.id });
    expect(kit.skills.get('x')!.version).toBe(2);
  });

  it('search returns matched + scoped to visibility', () => {
    kit = makeKit('skill-search');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({ name: 'pub', skillMd: SKILL_MD, visibility: 'published', ownerCredentialId: admin.id });
    kit.skills.publish({ name: 'priv', skillMd: SKILL_MD, visibility: 'private', ownerCredentialId: admin.id });

    const allHits = kit.skills.search('cool');
    expect(allHits.length).toBe(2);

    const publicOnly = kit.skills.search('cool', { visibility: ['published', 'shared'] });
    expect(publicOnly.length).toBe(1);
    expect(publicOnly[0].name).toBe('pub');
  });

  it('canPublishSkill: admin always; member only with publishSkill flag', () => {
    kit = makeKit('skill-publish-acl');
    const admin = issue(kit, 'admin', 'admin');
    const m1 = issue(kit, 'm1', 'member', false);
    const m2 = issue(kit, 'm2', 'member', true);
    expect(canPublishSkill(admin)).toBe(true);
    expect(canPublishSkill(m1)).toBe(false);
    expect(canPublishSkill(m2)).toBe(true);
  });

  it('canOverwriteSkill: admin always; same ownerName ok; cross-owner denied; legacy admin-only', () => {
    kit = makeKit('skill-overwrite-acl');
    const admin = issue(kit, 'admin', 'admin');
    const alice1 = issueWithOwner(kit, 'alice-bot-1', 'alice', 'member');
    const alice2 = issueWithOwner(kit, 'alice-bot-2', 'alice', 'member');
    const bob = issueWithOwner(kit, 'bob-bot', 'bob', 'member');
    const noOwner = issueWithOwner(kit, 'lonely', '', 'member');

    const aliceSkill = { ownerName: 'alice' };
    const legacySkill = { ownerName: undefined };

    expect(canOverwriteSkill(aliceSkill, admin)).toBe(true);
    expect(canOverwriteSkill(aliceSkill, alice1)).toBe(true);
    expect(canOverwriteSkill(aliceSkill, alice2)).toBe(true);  // same human, other machine
    expect(canOverwriteSkill(aliceSkill, bob)).toBe(false);
    expect(canOverwriteSkill(legacySkill, alice1)).toBe(false); // legacy: admin only
    expect(canOverwriteSkill(legacySkill, admin)).toBe(true);
    expect(canOverwriteSkill(aliceSkill, noOwner)).toBe(false); // empty-owner cred never matches
  });

  it('visibilityFilter: admin sees all (undefined), member sees published+shared', () => {
    kit = makeKit('skill-vis');
    const admin = issue(kit, 'admin', 'admin');
    const m = issue(kit, 'm', 'member');
    expect(visibilityFilter(admin)).toBeUndefined();
    expect(visibilityFilter(m)).toEqual(['published', 'shared']);
  });

  it('isVisibleToCred: owner sees own private skill (same ownerName, different botName)', () => {
    kit = makeKit('skill-owner-bypass-visible');
    const aliceM1 = issueWithOwner(kit, 'alice-machine-1', 'alice', 'member', true);
    kit.skills.publish({
      name: 'alice-private',
      skillMd: SKILL_MD,
      visibility: 'private',
      author: aliceM1.botName,
      ownerCredentialId: aliceM1.id,
      ownerBotName: aliceM1.botName,
      ownerName: aliceM1.ownerName,
    });
    const aliceM2 = issueWithOwner(kit, 'alice-machine-2', 'alice', 'member', true);
    const rec = kit.skills.get('alice-private')!;
    expect(isVisibleToCred(rec, aliceM2)).toBe(true);
    // And the bulk filter agrees.
    expect(filterSkillsForCred([rec], aliceM2).length).toBe(1);
  });

  it('isVisibleToCred: non-owner does NOT see another user\'s private skill', () => {
    kit = makeKit('skill-owner-bypass-hidden');
    const alice = issueWithOwner(kit, 'alice-bot', 'alice', 'member', true);
    kit.skills.publish({
      name: 'alice-private',
      skillMd: SKILL_MD,
      visibility: 'private',
      author: alice.botName,
      ownerCredentialId: alice.id,
      ownerBotName: alice.botName,
      ownerName: alice.ownerName,
    });
    const bob = issueWithOwner(kit, 'bob-bot', 'bob', 'member', true);
    const rec = kit.skills.get('alice-private')!;
    expect(isVisibleToCred(rec, bob)).toBe(false);
    expect(filterSkillsForCred([rec], bob).length).toBe(0);
  });

  it('isVisibleToCred: admin always sees everything; published/shared always visible', () => {
    kit = makeKit('skill-owner-bypass-admin');
    const admin = issue(kit, 'admin', 'admin');
    const member = issueWithOwner(kit, 'm-bot', 'm-owner', 'member', true);
    kit.skills.publish({
      name: 'priv', skillMd: SKILL_MD, visibility: 'private',
      ownerCredentialId: admin.id, ownerName: admin.ownerName,
    });
    kit.skills.publish({
      name: 'pub', skillMd: SKILL_MD, visibility: 'published',
      ownerCredentialId: admin.id, ownerName: admin.ownerName,
    });
    const priv = kit.skills.get('priv')!;
    const pub = kit.skills.get('pub')!;
    expect(isVisibleToCred(priv, admin)).toBe(true);
    expect(isVisibleToCred(pub, member)).toBe(true);
    // Member can NOT see the admin's private skill (different ownerName).
    expect(isVisibleToCred(priv, member)).toBe(false);
  });

  it('isVisibleToCred: empty ownerName on the skill never grants access to a member', () => {
    // Legacy rows (pre-2026-05-25) have NULL owner_name. They must NOT
    // accidentally pass the bypass for an empty-ownerName cred — otherwise
    // any unaligned legacy state would grant cross-user access.
    kit = makeKit('skill-owner-bypass-legacy');
    const member = issueWithOwner(kit, 'm-bot', '', 'member', true);
    const legacyPrivate = {
      visibility: 'private' as const,
      ownerName: undefined,
    };
    expect(isVisibleToCred(legacyPrivate, member)).toBe(false);
  });

  it('remove deletes by name', () => {
    kit = makeKit('skill-remove');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({ name: 'to-remove', skillMd: SKILL_MD, ownerCredentialId: admin.id });
    expect(kit.skills.remove('to-remove')).toBe(true);
    expect(kit.skills.remove('to-remove')).toBe(false);
    expect(kit.skills.get('to-remove')).toBeUndefined();
  });
});

describe('publishSkill route — explicit publish grant + overwrite protection', () => {
  it('member with publish grant can publish a brand-new private skill (201)', () => {
    kit = makeKit('skill-route-member-new');
    const alice = issueWithOwner(kit, 'alice-bot', 'alice', 'member', true);
    const res = skillRoutes.publishSkill(
      kit.skills, 'my-cool-skill',
      { skillMd: SKILL_MD },
      alice,
    );
    expect(res.status).toBe(201);
    const rec = kit.skills.get('my-cool-skill')!;
    expect(rec.ownerName).toBe('alice');
    expect(rec.visibility).toBe('private');
    expect(rec.version).toBe(1);
  });

  it('member can republish their own skill (version bumps)', () => {
    kit = makeKit('skill-route-member-own-republish');
    const alice1 = issueWithOwner(kit, 'alice-bot-1', 'alice', 'member', true);
    const alice2 = issueWithOwner(kit, 'alice-bot-2', 'alice', 'member', true);

    expect(skillRoutes.publishSkill(kit.skills, 'foo', { skillMd: SKILL_MD }, alice1).status).toBe(201);
    // Same owner, different machine → still allowed (user-level bypass).
    const res2 = skillRoutes.publishSkill(kit.skills, 'foo', { skillMd: SKILL_MD + '\nv2' }, alice2);
    expect(res2.status).toBe(201);
    expect(kit.skills.get('foo')!.version).toBe(2);
  });

  it('member B cannot overwrite member A\'s skill (403 skill_owned_by_other)', () => {
    kit = makeKit('skill-route-member-cross-owner');
    const alice = issueWithOwner(kit, 'alice-bot', 'alice', 'member', true);
    const bob = issueWithOwner(kit, 'bob-bot', 'bob', 'member', true);

    expect(skillRoutes.publishSkill(kit.skills, 'foo', { skillMd: SKILL_MD }, alice).status).toBe(201);
    const res = skillRoutes.publishSkill(kit.skills, 'foo', { skillMd: SKILL_MD + '\nbob' }, bob);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('skill_owned_by_other');
    // Alice's content untouched.
    expect(kit.skills.get('foo')!.version).toBe(1);
    expect(kit.skills.get('foo')!.ownerName).toBe('alice');
  });

  it('admin can overwrite any skill', () => {
    kit = makeKit('skill-route-admin-overwrite');
    const alice = issueWithOwner(kit, 'alice-bot', 'alice', 'member', true);
    const admin = issue(kit, 'root', 'admin');
    expect(skillRoutes.publishSkill(kit.skills, 'foo', { skillMd: SKILL_MD }, alice).status).toBe(201);
    const res = skillRoutes.publishSkill(kit.skills, 'foo', { skillMd: SKILL_MD + '\nadmin' }, admin);
    expect(res.status).toBe(201);
    expect(kit.skills.get('foo')!.version).toBe(2);
  });

  it('legacy skill (no ownerName) is admin-only to overwrite', () => {
    kit = makeKit('skill-route-legacy');
    // Seed a legacy row directly (no ownerName).
    kit.skills.publish({ name: 'legacy', skillMd: SKILL_MD });
    const member = issueWithOwner(kit, 'm-bot', 'm-owner', 'member', true);
    const admin = issue(kit, 'root', 'admin');

    const res1 = skillRoutes.publishSkill(kit.skills, 'legacy', { skillMd: SKILL_MD + '\nclaim' }, member);
    expect(res1.status).toBe(403);
    expect(kit.skills.get('legacy')!.version).toBe(1);

    const res2 = skillRoutes.publishSkill(kit.skills, 'legacy', { skillMd: SKILL_MD + '\nadmin' }, admin);
    expect(res2.status).toBe(201);
    expect(kit.skills.get('legacy')!.version).toBe(2);
  });

  it('member can only publish private skills', () => {
    kit = makeKit('skill-route-member-visibilities');
    const alice = issueWithOwner(kit, 'alice-bot', 'alice', 'member', true);
    const privateRes = skillRoutes.publishSkill(
      kit.skills, 'skill-private', { skillMd: SKILL_MD, visibility: 'private' }, alice,
    );
    expect(privateRes.status).toBe(201);
    for (const v of ['shared', 'published'] as const) {
      const res = skillRoutes.publishSkill(
        kit.skills, `skill-${v}`, { skillMd: SKILL_MD, visibility: v }, alice,
      );
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toBe('public_skill_publish_admin_required');
    }
  });

  it('admin can publish all three visibilities', () => {
    kit = makeKit('skill-route-admin-visibilities');
    const admin = issueWithOwner(kit, 'root', 'root', 'admin');
    for (const v of ['private', 'shared', 'published'] as const) {
      const res = skillRoutes.publishSkill(
        kit.skills, `skill-${v}`, { skillMd: SKILL_MD, visibility: v }, admin,
      );
      expect(res.status).toBe(201);
      expect(kit.skills.get(`skill-${v}`)!.visibility).toBe(v);
    }
  });

  it('rejects invalid or oversized skill markdown', () => {
    kit = makeKit('skill-route-content-validation');
    const admin = issue(kit, 'root', 'admin');
    expect(skillRoutes.publishSkill(kit.skills, 'bad', { skillMd: '# no frontmatter' }, admin).status).toBe(400);
    const noName = '---\ndescription: missing name\n---\n# Body\n';
    const res = skillRoutes.publishSkill(kit.skills, 'bad2', { skillMd: noName }, admin);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('skillMd_name_required');
  });
});
