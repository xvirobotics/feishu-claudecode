import { describe, it, expect, beforeAll } from 'vitest';
import {
  signSession,
  verifySession,
  signState,
  verifyState,
  parseCookies,
  loadOrCreateSessionSecret,
} from '../src/feishu/oauth.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

const TEST_SECRET = 'test-secret-key-of-acceptable-length-12345';

describe('signSession / verifySession', () => {
  it('round-trips and recovers the payload', () => {
    const token = signSession({ open_id: 'ou_xxx', name: 'Aragorn' }, TEST_SECRET);
    const decoded = verifySession(token, TEST_SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.open_id).toBe('ou_xxx');
    expect(decoded?.name).toBe('Aragorn');
    expect(decoded?.exp).toBeGreaterThan(decoded!.iat);
  });

  it('rejects a tampered signature', () => {
    const token = signSession({ open_id: 'ou_xxx', name: 'A' }, TEST_SECRET);
    const parts = token.split('.');
    parts[2] = 'tamperedsig';
    expect(verifySession(parts.join('.'), TEST_SECRET)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signSession({ open_id: 'ou_legit', name: 'A' }, TEST_SECRET);
    const parts = token.split('.');
    // Re-encode a different open_id while keeping the original signature.
    const bad = Buffer.from(JSON.stringify({ open_id: 'ou_evil', name: 'A', iat: 1, exp: 9999999999 }))
      .toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    parts[1] = bad;
    expect(verifySession(parts.join('.'), TEST_SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    // Manually craft an expired token with the correct signature so we can
    // assert the exp check fires.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const body = Buffer.from(JSON.stringify({ open_id: 'ou_a', name: 'a', iat: 0, exp: 1 })).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = crypto.createHmac('sha256', TEST_SECRET).update(`${header}.${body}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifySession(`${header}.${body}.${sig}`, TEST_SECRET)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifySession('not-a-jwt', TEST_SECRET)).toBeNull();
    expect(verifySession('a.b', TEST_SECRET)).toBeNull();
  });
});

describe('signState / verifyState', () => {
  it('round-trips returnUrl + botName', () => {
    const s = signState({ returnUrl: '/web/transcript/abc?turn=2', botName: 'metabot' }, TEST_SECRET);
    const decoded = verifyState(s, TEST_SECRET);
    expect(decoded?.returnUrl).toBe('/web/transcript/abc?turn=2');
    expect(decoded?.botName).toBe('metabot');
    expect(decoded?.nonce.length).toBeGreaterThan(0);
  });

  it('rejects tampered state', () => {
    const s = signState({ returnUrl: '/safe', botName: 'x' }, TEST_SECRET);
    expect(verifyState(s + 'x', TEST_SECRET)).toBeNull();
  });
});

describe('parseCookies', () => {
  it('parses standard cookie header', () => {
    const r = parseCookies('mb_session=abc.def.ghi; other=1');
    expect(r.mb_session).toBe('abc.def.ghi');
    expect(r.other).toBe('1');
  });

  it('returns empty when header is undefined', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('handles URL-encoded values', () => {
    const r = parseCookies('mb_session=' + encodeURIComponent('a/b+c='));
    expect(r.mb_session).toBe('a/b+c=');
  });
});

describe('loadOrCreateSessionSecret', () => {
  beforeAll(() => {
    delete process.env.METABOT_SESSION_SECRET;
  });

  it('mints, persists, and re-reads the secret from .env.local', () => {
    const tmpFile = path.join(os.tmpdir(), `mb-test-env-${Date.now()}`);
    try {
      const secret = loadOrCreateSessionSecret(tmpFile);
      expect(secret.length).toBeGreaterThanOrEqual(32);
      const body = fs.readFileSync(tmpFile, 'utf-8');
      expect(body).toContain('METABOT_SESSION_SECRET=');
      // Second call should be a noop (process.env now wins).
      const secret2 = loadOrCreateSessionSecret(tmpFile);
      expect(secret2).toBe(secret);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});
