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
  /**
   * True for in-memory synthetic credentials minted from a browser SSO
   * identity (oauth2-proxy → X-Forwarded-Email). Never persisted, no token.
   * Optional → zero behavior change for the Bearer/persisted path.
   */
  synthetic?: true;
  /**
   * Discriminates browser-SSO traffic from CLI/bot Bearer traffic in the
   * audit log. Optional; nothing ACL-keyed reads this.
   */
  authSource?: 'web' | 'bearer';
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
  if (matchesOwnerNamespace(cred, path)) return true;
  return cred.readableNamespaces.some((ns) => pathMatchesNamespace(path, ns));
}

export function canWrite(cred: Credential, path: string): boolean {
  if (cred.role === 'admin') return true;
  if (pathMatchesNamespace(path, selfNamespace(cred))) return true;
  return cred.writableNamespaces.some((ns) => pathMatchesNamespace(path, ns));
}

/**
 * Document-level read check — the sharing primitive under the path-constrained
 * write model. A doc is readable when EITHER the path-based rules grant access
 * (admin, own namespace, legacy `/shared/`, or an explicit readable namespace)
 * OR the doc is explicitly marked `shared`.
 *
 * This decouples *where* a doc lives (always its author's own namespace, since
 * `canWrite` confines writes to `selfNamespace`) from *who* may read it (anyone,
 * once shared). The `shared` flag defaults from the owning agent's
 * `memoryPublic` config and is overridable per document. See
 * [[decision-memory-share-flag]].
 */
export function canReadDoc(cred: Credential, path: string, shared: boolean): boolean {
  if (shared) return true;
  return canRead(cred, path);
}

/**
 * The single subtree a credential is allowed to write to by virtue of being
 * itself (admin and explicit writableNamespaces are separate paths).
 *
 *   user-kind   (botName === ownerName, e.g. SSO / self-service web token):
 *     /users/<ownerName>
 *
 *   agent-kind  (botName !== ownerName, e.g. bot token issued via
 *               `metabot agents create`):
 *     /users/<ownerName>/agents/<botName>
 *
 * Reads stay broader — `canRead` keeps `matchesOwnerNamespace` so an agent
 * can see sibling agents and user-level docs under the same human.
 *
 * Empty `ownerName` (legacy creds, or bootstrap admin) → returns a string
 * that `pathMatchesNamespace` rejects, so no accidental blanket grant.
 */
export function selfNamespace(cred: Credential): string {
  if (!cred.ownerName) return '';
  if (cred.botName === cred.ownerName) {
    return `/users/${cred.ownerName}`;
  }
  return `/users/${cred.ownerName}/agents/${cred.botName}`;
}

/**
 * User-level owner-bypass: any `/users/<ownerName>/...` path is always
 * readable by a credential whose `ownerName` matches. Used only by `canRead`
 * now — writes are narrowed to `selfNamespace`. This is what lets the same
 * human's CLI cred on machine A and cred on machine B share visibility into
 * a private namespace.
 *
 * Empty `ownerName` (legacy creds, or bootstrap admin) → no bypass.
 */
function matchesOwnerNamespace(cred: Credential, path: string): boolean {
  if (!cred.ownerName) return false;
  return pathMatchesNamespace(path, `/users/${cred.ownerName}`);
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
