/**
 * Cloud-side Feishu session verification + cookie parsing.
 *
 * TODO(post-PR-5): hoist this into `@metabot/shared/auth/session-jwt` (along
 * with `signSession` from `src/feishu/oauth.ts`) so cloud + local share one
 * implementation. For PR-5a we copy the *minimum* surface — cookie parsing,
 * verifySession, and the helpers verifySession depends on — to keep the
 * cloud workspace independent of local code. The wire format (HS256 JWT,
 * base64url, 7-day `exp`) is identical, so cookies minted by local
 * `signSession` verify here byte-for-byte against the same
 * `METABOT_SESSION_SECRET`.
 */
import crypto from 'node:crypto';

const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days — kept for reference; verify only reads `exp`.
void SESSION_TTL_SEC;

export interface SessionPayload {
  open_id: string;
  name: string;
  iat: number;
  exp: number;
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Verify an `mb_session` HS256 JWT. Returns the decoded payload on success,
 * `null` on any failure (bad shape, signature mismatch, missing fields,
 * expired). Never throws — callers branch on the result.
 */
export function verifySession(token: string, secret: string): SessionPayload | null {
  if (!secret || secret.length < 16) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64urlEncode(
    crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest(),
  );
  if (!timingSafeEqualStr(sig, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf-8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.open_id !== 'string' || !payload.open_id) return null;
  return payload;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
