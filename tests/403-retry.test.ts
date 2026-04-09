import { describe, expect, it } from 'vitest';
import { is403Error, getRetryDelay } from '../src/bridge/message-bridge.js';

describe('is403Error', () => {
  it('detects numeric status 403', () => {
    expect(is403Error({ status: 403, message: 'Forbidden' })).toBe(true);
  });

  it('detects string status "403"', () => {
    expect(is403Error({ statusCode: '403' })).toBe(true);
  });

  it('detects 403 in error message', () => {
    expect(is403Error({ message: 'API Error: 403 Forbidden' })).toBe(true);
    expect(is403Error(new Error('Request failed with status 403'))).toBe(true);
  });

  it('detects "forbidden" in message', () => {
    expect(is403Error({ message: 'Access Forbidden' })).toBe(true);
  });

  it('detects "rate limit" in message', () => {
    expect(is403Error({ message: 'Rate limit exceeded' })).toBe(true);
    expect(is403Error({ message: 'rate_limit_error' })).toBe(true);
  });

  it('rejects non-403 errors', () => {
    expect(is403Error({ status: 500, message: 'Internal Server Error' })).toBe(false);
    expect(is403Error({ message: 'Task timed out' })).toBe(false);
    expect(is403Error(new Error('permission denied'))).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(is403Error(null)).toBe(false);
    expect(is403Error(undefined)).toBe(false);
    expect(is403Error('403')).toBe(false);
    expect(is403Error(403)).toBe(false);
  });
});

describe('getRetryDelay', () => {
  // Tier 1: attempts 0,1,2 → 60s each
  it('returns 60s for tier 1 attempts (0, 1, 2)', () => {
    expect(getRetryDelay(0)).toBe(60_000);
    expect(getRetryDelay(1)).toBe(60_000);
    expect(getRetryDelay(2)).toBe(60_000);
  });

  // Tier 2: attempts 3,4 → 300s each
  it('returns 300s for tier 2 attempts (3, 4)', () => {
    expect(getRetryDelay(3)).toBe(300_000);
    expect(getRetryDelay(4)).toBe(300_000);
  });

  // Exhausted: attempt 5+ → null
  it('returns null when all retries exhausted', () => {
    expect(getRetryDelay(5)).toBeNull();
    expect(getRetryDelay(10)).toBeNull();
  });
});
