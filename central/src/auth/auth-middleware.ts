import type * as http from 'node:http';
import type { Credential } from './credentials.js';
import type { CredentialsStore } from './credentials-store.js';

export interface AuthFailure {
  status: number;
  error: string;
}

export interface AuthSuccess {
  credential: Credential;
}

export type AuthResult = AuthSuccess | AuthFailure;

export function isAuthFailure(r: AuthResult): r is AuthFailure {
  return (r as AuthFailure).status !== undefined;
}

export function extractBearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  if (h.startsWith('Bearer ')) return h.slice('Bearer '.length).trim();
  if (h.startsWith('bearer ')) return h.slice('bearer '.length).trim();
  return null;
}

/**
 * Resolve a request to a credential. Returns either {credential} or
 * {status, error} suitable for sending as a JSON response.
 *
 * Side effects: on success, queues a lastUsedAt update (non-blocking).
 */
export function authenticate(req: http.IncomingMessage, store: CredentialsStore): AuthResult {
  const token = extractBearer(req);
  if (!token) return { status: 401, error: 'missing_token' };
  const cred = store.lookupByToken(token);
  if (!cred) return { status: 401, error: 'invalid_token' };
  if (cred.revokedAt !== null) return { status: 401, error: 'credential_revoked' };
  store.touchLastUsed(cred.id);
  return { credential: cred };
}

export function requireAdmin(cred: Credential): AuthFailure | null {
  if (cred.role !== 'admin') return { status: 403, error: 'admin_required' };
  return null;
}
