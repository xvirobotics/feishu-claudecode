import type { Credential } from '../auth/credentials.js';
import { canPublishSkill as credCanPublish } from '../auth/credentials.js';

export function canPublishSkill(cred: Credential): boolean {
  return credCanPublish(cred);
}

export function canUnpublishSkill(cred: Credential): boolean {
  return cred.role === 'admin';
}

/**
 * Members see only `published` + `shared`. Admins see everything (return
 * undefined to skip the visibility filter).
 */
export function visibilityFilter(cred: Credential): ('published' | 'shared' | 'private')[] | undefined {
  if (cred.role === 'admin') return undefined;
  return ['published', 'shared'];
}
