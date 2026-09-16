import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/api/circuit-breaker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  child: () => logger,
} as any;

function createBreaker(): CircuitBreaker {
  return new CircuitBreaker(logger, {
    failureThreshold: 1,
    resetTimeoutMs: 1000,
    halfOpenMaxAttempts: 2,
  });
}

describe('CircuitBreaker half-open probing', () => {
  it('allows only one probe while recovering from an open circuit', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const breaker = createBreaker();

    expect(breaker.isAvailable('bot')).toBe(true);
    breaker.recordFailure('bot');
    // Open: nothing passes before the reset timeout.
    expect(breaker.isAvailable('bot')).toBe(false);

    now.mockReturnValue(1000);
    expect(breaker.isAvailable('bot')).toBe(true);
    expect(breaker.isAvailable('bot')).toBe(false);

    breaker.recordSuccess('bot');
    expect(breaker.isAvailable('bot')).toBe(true);
    breaker.recordSuccess('bot');
    expect(breaker.getStatus().bot).toMatchObject({ state: 'closed', failures: 0 });

    now.mockRestore();
  });

  it('re-opens after a failed probe and gates the next window again', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const breaker = createBreaker();

    breaker.isAvailable('bot');
    breaker.recordFailure('bot');

    now.mockReturnValue(1000);
    expect(breaker.isAvailable('bot')).toBe(true); // first probe
    expect(breaker.isAvailable('bot')).toBe(false); // burst blocked

    breaker.recordFailure('bot'); // the probe fails
    expect(breaker.getStatus().bot).toMatchObject({ state: 'open' });
    expect(breaker.isAvailable('bot')).toBe(false);

    now.mockReturnValue(2000);
    expect(breaker.isAvailable('bot')).toBe(true); // next window: one probe again
    expect(breaker.isAvailable('bot')).toBe(false);

    now.mockRestore();
  });
});
