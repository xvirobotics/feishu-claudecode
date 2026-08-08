import * as zlib from 'node:zlib';
import type { SkillStore } from './skill-store.js';
import type { Credential } from '../auth/credentials.js';
import {
  canPublishSkill, canUnpublishSkill, canOverwriteSkill, filterSkillsForCred, isVisibleToCred,
} from './publish-acl.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

const MAX_REFERENCES_DECOMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 256 * 1024;
const VISIBILITIES = new Set(['private', 'published', 'shared']);

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

function isBufferTooLargeError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ERR_BUFFER_TOO_LARGE';
}

function validateSkillMd(skillMd: string): string | null {
  if (Buffer.byteLength(skillMd, 'utf8') > MAX_SKILL_MD_BYTES) return 'skillMd_too_large';
  const frontmatter = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) return 'skillMd_frontmatter_required';
  if (!/^name:\s*\S+/m.test(frontmatter[1])) return 'skillMd_name_required';
  return null;
}

function parseVisibility(value: unknown, cred: Credential): 'private' | 'published' | 'shared' | null {
  const visibility = typeof value === 'string' ? value : cred.role === 'admin' ? 'published' : 'private';
  if (!VISIBILITIES.has(visibility)) return null;
  return visibility as 'private' | 'published' | 'shared';
}

export function listSkills(store: SkillStore, cred: Credential): RouteResult {
  // Don't pre-filter at the SQL layer — `filterSkillsForCred` needs private
  // rows owned by `cred.ownerName` to come through. The post-filter handles
  // both visibility-list AND owner-bypass in one place.
  const skills = filterSkillsForCred(store.list(), cred);
  return { status: 200, body: { skills } };
}

export function searchSkills(store: SkillStore, query: URLSearchParams, cred: Credential): RouteResult {
  const q = query.get('q') || '';
  const skills = filterSkillsForCred(store.search(q), cred);
  return { status: 200, body: { skills } };
}

export function getSkill(store: SkillStore, name: string, cred: Credential): RouteResult {
  const record = store.get(name);
  if (!record) return err(404, 'skill_not_found');
  if (!isVisibleToCred(record, cred)) return err(404, 'skill_not_found');
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
  const skillMdError = validateSkillMd(skillMd);
  if (skillMdError) return err(400, skillMdError);

  const visibility = parseVisibility(body.visibility, cred);
  if (!visibility) return err(400, 'visibility_invalid');
  if (cred.role !== 'admin' && visibility !== 'private') return err(403, 'public_skill_publish_admin_required');

  const existing = store.get(name);
  if (existing && !canOverwriteSkill(existing, cred)) {
    return err(403, 'skill_owned_by_other');
  }

  // Tristate: field absent = preserve existing, null = explicit clear,
  // string = new base64-encoded pack. Without this, CLI publishes that omit
  // --from would silently wipe the stored references.
  let referencesTar: Buffer | null | undefined;
  if (!('referencesTar' in body)) {
    referencesTar = undefined;
  } else if (body.referencesTar === null) {
    referencesTar = null;
  } else if (typeof body.referencesTar === 'string') {
    referencesTar = Buffer.from(body.referencesTar, 'base64');
  } else {
    return err(400, 'referencesTar_invalid_type');
  }

  const record = store.publish({
    name,
    skillMd,
    referencesTar,
    author: cred.botName,
    ownerBotName: cred.botName,
    ownerCredentialId: cred.id,
    ownerName: cred.ownerName || undefined,
    visibility,
  });

  return { status: 201, body: { name: record.name, version: record.version, published: true } };
}

export function getSkillReferences(store: SkillStore, name: string, cred: Credential): RouteResult {
  const record = store.get(name);
  if (!record) return err(404, 'skill_not_found');
  if (!isVisibleToCred(record, cred)) return err(404, 'skill_not_found');
  if (!record.hasReferences) return err(404, 'no_references');
  const content = store.getContent(name);
  if (!content?.referencesTar) return err(404, 'no_references');
  let parsed: { files?: unknown };
  try {
    const unpacked = zlib.gunzipSync(content.referencesTar, {
      maxOutputLength: MAX_REFERENCES_DECOMPRESSED_BYTES,
    });
    parsed = JSON.parse(unpacked.toString('utf8')) as { files?: unknown };
  } catch (error) {
    if (isBufferTooLargeError(error)) return err(413, 'references_too_large');
    return err(500, 'references_corrupt');
  }
  if (!Array.isArray(parsed.files)) return err(500, 'references_corrupt');
  return { status: 200, body: { name, version: record.version, files: parsed.files } };
}

export function deleteSkill(store: SkillStore, name: string, cred: Credential): RouteResult {
  if (!canUnpublishSkill(cred)) return err(403, 'unpublish_skill_forbidden');
  const removed = store.remove(name);
  if (!removed) return err(404, 'skill_not_found');
  return { status: 200, body: { name, removed: true } };
}
