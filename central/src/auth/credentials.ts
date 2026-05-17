import * as crypto from 'node:crypto';

export type Role = 'admin' | 'member';

export interface Credential {
  id: string;
  tokenHash: string;
  botName: string;
  ownerName: string;
  role: Role;
  writableNamespaces: string[];
  readableNamespaces: string[];
  publishSkill: boolean;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  notes: string;
}

export interface CredentialPublic {
  id: string;
  botName: string;
  ownerName: string;
  role: Role;
  writableNamespaces: string[];
  readableNamespaces: string[];
  publishSkill: boolean;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  notes: string;
}

export interface IssueInput {
  botName: string;
  ownerName: string;
  role: Role;
  writableNamespaces?: string[];
  readableNamespaces?: string[];
  publishSkill?: boolean;
  notes?: string;
}

export interface IssueResult {
  credential: CredentialPublic;
  token: string;
}

const TOKEN_PREFIX_ADMIN = 'mt_admin_';
const TOKEN_PREFIX_MEMBER = 'mt_';
const TOKEN_RANDOM_BYTES = 16; // 32 hex chars

export function generateToken(role: Role): string {
  const hex = crypto.randomBytes(TOKEN_RANDOM_BYTES).toString('hex');
  return (role === 'admin' ? TOKEN_PREFIX_ADMIN : TOKEN_PREFIX_MEMBER) + hex;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function toPublic(c: Credential): CredentialPublic {
  const { tokenHash: _hash, ...rest } = c;
  return rest;
}

export function canRead(cred: Credential, path: string): boolean {
  if (cred.role === 'admin') return true;
  if (path.startsWith('/shared/')) return true;
  return cred.readableNamespaces.some((ns) => pathMatchesNamespace(path, ns));
}

export function canWrite(cred: Credential, path: string): boolean {
  if (cred.role === 'admin') return true;
  return cred.writableNamespaces.some((ns) => pathMatchesNamespace(path, ns));
}

export function canPublishSkill(cred: Credential): boolean {
  return cred.role === 'admin' || cred.publishSkill;
}

function pathMatchesNamespace(p: string, ns: string): boolean {
  if (!ns) return false;
  const nsNorm = ns.endsWith('/') ? ns.slice(0, -1) : ns;
  if (nsNorm === '' || nsNorm === '/') return true;
  return p === nsNorm || p.startsWith(nsNorm + '/');
}
