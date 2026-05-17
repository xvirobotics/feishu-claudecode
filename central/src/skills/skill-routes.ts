import type { SkillStore } from './skill-store.js';
import type { Credential } from '../auth/credentials.js';
import { canPublishSkill, canUnpublishSkill, visibilityFilter } from './publish-acl.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

export function listSkills(store: SkillStore, cred: Credential): RouteResult {
  const filter = visibilityFilter(cred);
  const skills = store.list(filter ? { visibility: filter } : undefined);
  return { status: 200, body: { skills } };
}

export function searchSkills(store: SkillStore, query: URLSearchParams, cred: Credential): RouteResult {
  const q = query.get('q') || '';
  const filter = visibilityFilter(cred);
  const skills = store.search(q, filter ? { visibility: filter } : undefined);
  return { status: 200, body: { skills } };
}

export function getSkill(store: SkillStore, name: string, cred: Credential): RouteResult {
  const record = store.get(name);
  if (!record) return err(404, 'skill_not_found');
  const filter = visibilityFilter(cred);
  if (filter && !filter.includes(record.visibility)) {
    return err(404, 'skill_not_found');
  }
  return { status: 200, body: record };
}

export function publishSkill(
  store: SkillStore,
  name: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  if (!canPublishSkill(cred)) return err(403, 'publish_skill_forbidden');

  const skillMd = body.skillMd as string | undefined;
  if (!skillMd) return err(400, 'skillMd_required');

  const referencesTar = body.referencesTar
    ? Buffer.from(body.referencesTar as string, 'base64')
    : undefined;

  const record = store.publish({
    name,
    skillMd,
    referencesTar,
    author: cred.botName,
    ownerBotName: cred.botName,
    ownerCredentialId: cred.id,
    visibility: (body.visibility as 'private' | 'published' | 'shared') || 'published',
  });

  return { status: 201, body: { name: record.name, version: record.version, published: true } };
}

export function deleteSkill(store: SkillStore, name: string, cred: Credential): RouteResult {
  if (!canUnpublishSkill(cred)) return err(403, 'unpublish_skill_forbidden');
  const removed = store.remove(name);
  if (!removed) return err(404, 'skill_not_found');
  return { status: 200, body: { name, removed: true } };
}
