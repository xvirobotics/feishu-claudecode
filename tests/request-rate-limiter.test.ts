import { describe, it, expect } from 'vitest';
import {
  RequestRateLimiter,
  rateLimiterFromEnv,
  resolveClientIp,
} from '../src/api/request-rate-limiter.js';
import {
  bearerTokenFromWebSocketProtocol,
  isWebSocketSecretAuthorized,
  timingSafeStrEqual,
} from '../src/web/ws-server.js';

/** A controllable clock for deterministic time-based assertions. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe('RequestRateLimiter — global request ceiling', () => {
  it('allows up to maxRequests then 429s within the window', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxRequests: 5, windowMs: 60_000, now: c.now });
    for (let i = 0; i < 5; i++) expect(rl.check('1.2.3.4')).toBeNull();
    const decision = rl.check('1.2.3.4');
    expect(decision?.limited).toBe(true);
    expect(decision?.status).toBe(429);
    expect(decision?.reason).toBe('global');
  });

  it('refills as the sliding window advances', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxRequests: 2, windowMs: 1_000, now: c.now });
    expect(rl.check('ip')).toBeNull();
    expect(rl.check('ip')).toBeNull();
    expect(rl.check('ip')?.reason).toBe('global');
    c.advance(1_001); // old timestamps fall out of the window
    expect(rl.check('ip')).toBeNull();
  });

  it('tracks IPs independently', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: c.now });
    expect(rl.check('a')).toBeNull();
    expect(rl.check('a')?.reason).toBe('global');
    expect(rl.check('b')).toBeNull(); // separate bucket
  });
});

describe('RequestRateLimiter — failed-auth lockout', () => {
  it('locks out an IP after maxAuthFails failures', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxAuthFails: 3, authLockoutMs: 60_000, now: c.now });
    expect(rl.recordAuthFailure('ip')).toBeNull();
    expect(rl.recordAuthFailure('ip')).toBeNull();
    const locked = rl.recordAuthFailure('ip'); // 3rd trips it
    expect(locked?.limited).toBe(true);
    expect(locked?.reason).toBe('auth-lockout');
    // Subsequent requests are rejected even before auth runs.
    const next = rl.check('ip');
    expect(next?.reason).toBe('auth-lockout');
  });

  it('cooldown expires and the IP is allowed again', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxAuthFails: 2, authLockoutMs: 30_000, now: c.now });
    rl.recordAuthFailure('ip');
    rl.recordAuthFailure('ip'); // locked
    expect(rl.check('ip')?.reason).toBe('auth-lockout');
    c.advance(30_001);
    expect(rl.check('ip')).toBeNull(); // cooldown elapsed
  });

  it('successful auth never triggers the lockout and clears the counter', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxAuthFails: 3, now: c.now });
    rl.recordAuthFailure('ip');
    rl.recordAuthFailure('ip'); // 2 fails, one short of lockout
    rl.recordAuthSuccess('ip'); // resets
    expect(rl.recordAuthFailure('ip')).toBeNull(); // counter restarted, no lockout
    expect(rl.recordAuthFailure('ip')).toBeNull();
    expect(rl.check('ip')).toBeNull(); // never locked
  });

  it('old failures age out of the window', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxAuthFails: 3, windowMs: 1_000, now: c.now });
    rl.recordAuthFailure('ip');
    rl.recordAuthFailure('ip');
    c.advance(1_001); // first two expire
    expect(rl.recordAuthFailure('ip')).toBeNull(); // only 1 in-window
  });
});

describe('RequestRateLimiter — disabled flag', () => {
  it('allows everything when disabled', () => {
    const rl = new RequestRateLimiter({ disabled: true, maxRequests: 1, maxAuthFails: 1 });
    for (let i = 0; i < 100; i++) expect(rl.check('ip')).toBeNull();
    expect(rl.recordAuthFailure('ip')).toBeNull();
    expect(rl.recordAuthFailure('ip')).toBeNull();
    expect(rl.check('ip')).toBeNull();
  });
});

describe('RequestRateLimiter — bounded memory', () => {
  it('evicts the oldest entry past the cap (LRU)', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ maxEntries: 3, now: c.now });
    rl.check('a'); c.advance(1);
    rl.check('b'); c.advance(1);
    rl.check('c'); c.advance(1);
    expect(rl.size()).toBe(3);
    rl.check('d'); // over cap → evicts least-recently-seen ('a')
    expect(rl.size()).toBe(3);
  });

  it('sweep drops idle entries', () => {
    const c = clock();
    const rl = new RequestRateLimiter({ windowMs: 1_000, now: c.now });
    rl.check('ip');
    expect(rl.size()).toBe(1);
    c.advance(5_000); // well past 2 windows
    rl.sweep();
    expect(rl.size()).toBe(0);
  });
});

describe('rateLimiterFromEnv', () => {
  it('honours METABOT_RATE_LIMIT_DISABLED=1', () => {
    const rl = rateLimiterFromEnv({ METABOT_RATE_LIMIT_DISABLED: '1' } as NodeJS.ProcessEnv);
    for (let i = 0; i < 1000; i++) expect(rl.check('ip')).toBeNull();
  });

  it('reads METABOT_RATE_LIMIT_MAX and AUTH_FAILS', () => {
    const rl = rateLimiterFromEnv({
      METABOT_RATE_LIMIT_MAX: '2',
      METABOT_RATE_LIMIT_AUTH_FAILS: '2',
    } as NodeJS.ProcessEnv);
    expect(rl.check('ip')).toBeNull();
    expect(rl.check('ip')).toBeNull();
    expect(rl.check('ip')?.reason).toBe('global');
  });

  it('falls back to defaults on invalid env values', () => {
    const rl = rateLimiterFromEnv({ METABOT_RATE_LIMIT_MAX: 'nonsense' } as NodeJS.ProcessEnv);
    // default 300 — 250 requests should all pass
    for (let i = 0; i < 250; i++) expect(rl.check('ip')).toBeNull();
  });
});

describe('resolveClientIp', () => {
  it('defaults to remoteAddress and ignores XFF without trust', () => {
    expect(resolveClientIp('5.6.7.8', '1.1.1.1', false)).toBe('5.6.7.8');
  });

  it('honours the first XFF hop only when proxy is trusted', () => {
    expect(resolveClientIp('5.6.7.8', '1.1.1.1, 2.2.2.2', true)).toBe('1.1.1.1');
  });

  it('falls back to "unknown" when remoteAddress is missing', () => {
    expect(resolveClientIp(undefined, undefined, false)).toBe('unknown');
  });
});

describe('timingSafeStrEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeStrEqual('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('returns false for different strings (incl. different lengths)', () => {
    expect(timingSafeStrEqual('s3cr3t', 's3cr3X')).toBe(false);
    expect(timingSafeStrEqual('short', 'a-much-longer-secret')).toBe(false);
  });

  it('returns false for nullish inputs', () => {
    expect(timingSafeStrEqual(undefined, 'x')).toBe(false);
    expect(timingSafeStrEqual('x', null)).toBe(false);
    expect(timingSafeStrEqual(null, null)).toBe(false);
  });
});

describe('WebSocket secret auth helpers', () => {
  it('extracts bearer credentials from the metabot WebSocket subprotocol', () => {
    expect(bearerTokenFromWebSocketProtocol('metabot-bearer.secret')).toBe('secret');
    expect(bearerTokenFromWebSocketProtocol('chat, metabot-bearer.secret')).toBe('secret');
    expect(bearerTokenFromWebSocketProtocol('other')).toBeUndefined();
  });

  it('does not accept query-string tokens for WebSocket auth', () => {
    const req = {
      headers: {
        authorization: undefined,
        'sec-websocket-protocol': undefined,
      },
    } as any;
    expect(isWebSocketSecretAuthorized('secret', req)).toBe(false);
  });

  it('accepts WebSocket credentials through Authorization or subprotocol only', () => {
    expect(isWebSocketSecretAuthorized('secret', {
      headers: { authorization: 'Bearer secret' },
    } as any)).toBe(true);
    expect(isWebSocketSecretAuthorized('secret', {
      headers: { 'sec-websocket-protocol': 'metabot-bearer.secret' },
    } as any)).toBe(true);
    expect(isWebSocketSecretAuthorized(undefined, {
      headers: { authorization: 'Bearer secret' },
    } as any)).toBe(false);
  });
});
