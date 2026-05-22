/**
 * Cookie-based auth for /api/manager/* routes.
 *
 * - bcrypt-verifies the password against `MANAGER_ADMIN_PASSWORD_HASH`.
 * - Issues a HS256 JWT (hand-rolled — no dep) stored in the `mb_mgr_session`
 *   HttpOnly cookie. 7-day TTL.
 * - `requireAuth(req)` returns the decoded session or null. Routes that need
 *   auth call it up-front and return 401 if null.
 *
 * Lifted the JWT helper shape from src/feishu/oauth.ts.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import bcrypt from 'bcryptjs';
import type { ManagerCredentials } from './credentials.js';

const SESSION_COOKIE = 'mb_mgr_session';
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

export interface ManagerSession {
  username: string;
  iat:      number;  // issued at  (seconds, epoch)
  exp:      number;  // expires at (seconds, epoch)
}

function b64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function sign(payload: Record<string, unknown>, secret: string): string {
  const header  = { alg: 'HS256', typ: 'JWT' };
  const h       = b64url(Buffer.from(JSON.stringify(header)));
  const p       = b64url(Buffer.from(JSON.stringify(payload)));
  const data    = `${h}.${p}`;
  const sig     = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verify(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(b64urlDecode(p).toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function signManagerSession(username: string, secret: string): string {
  const now: number = Math.floor(Date.now() / 1000);
  const payload: ManagerSession = { username, iat: now, exp: now + SESSION_TTL_SEC };
  return sign(payload as unknown as Record<string, unknown>, secret);
}

export function verifyManagerSession(token: string, secret: string): ManagerSession | null {
  const payload = verify(token, secret);
  if (!payload) return null;
  const username = typeof payload.username === 'string' ? payload.username : null;
  const exp      = typeof payload.exp      === 'number' ? payload.exp      : null;
  const iat      = typeof payload.iat      === 'number' ? payload.iat      : null;
  if (!username || exp == null || iat == null) return null;
  if (Math.floor(Date.now() / 1000) > exp) return null;
  return { username, iat, exp };
}

export function buildSessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `HttpOnly`,
    `Path=/`,
    `SameSite=Lax`,
    `Max-Age=${SESSION_TTL_SEC}`,
  ].join('; ');
}

export function buildClearCookie(): string {
  return [
    `${SESSION_COOKIE}=`,
    `HttpOnly`,
    `Path=/`,
    `SameSite=Lax`,
    `Max-Age=0`,
  ].join('; ');
}

export function requireAuth(req: http.IncomingMessage, secret: string): ManagerSession | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw     = cookies[SESSION_COOKIE];
  if (!raw) return null;
  return verifyManagerSession(raw, secret);
}

export async function verifyPassword(password: string, hashBcrypt: string): Promise<boolean> {
  if (!password || !hashBcrypt) return false;
  try {
    return await bcrypt.compare(password, hashBcrypt);
  } catch {
    return false;
  }
}

export function describeCreds(creds: ManagerCredentials): string {
  return `user=${creds.username} secret=${creds.sessionSecret.slice(0, 8)}…`;
}
