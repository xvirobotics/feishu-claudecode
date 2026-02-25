import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../src/bridge/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('executes first call immediately', () => {
    const limiter = new RateLimiter(1000);
    const fn = vi.fn();
    limiter.schedule(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('delays second call within interval', () => {
    const limiter = new RateLimiter(1000);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    limiter.schedule(fn1);
    expect(fn1).toHaveBeenCalledOnce();

    limiter.schedule(fn2);
    expect(fn2).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('replaces pending call with latest', () => {
    const limiter = new RateLimiter(1000);
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const fn3 = vi.fn();

    limiter.schedule(fn1); // immediate
    limiter.schedule(fn2); // queued
    limiter.schedule(fn3); // replaces fn2

    vi.advanceTimersByTime(1000);
    expect(fn2).not.toHaveBeenCalled();
    expect(fn3).toHaveBeenCalledOnce();
  });

  it('flush executes pending immediately', async () => {
    vi.useRealTimers(); // flush uses real await
    const limiter = new RateLimiter(5000);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    limiter.schedule(fn1);
    limiter.schedule(fn2);

    await limiter.flush();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('cancel discards pending', () => {
    const limiter = new RateLimiter(1000);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    limiter.schedule(fn1);
    limiter.schedule(fn2);

    limiter.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn2).not.toHaveBeenCalled();
  });

  it('cancelAndWait waits for interval', async () => {
    vi.useRealTimers();
    const limiter = new RateLimiter(100);
    const fn = vi.fn();
    limiter.schedule(fn);

    const start = Date.now();
    await limiter.cancelAndWait();
    const elapsed = Date.now() - start;
    // Should have waited roughly the interval
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('allows call after interval passes', () => {
    const limiter = new RateLimiter(1000);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    limiter.schedule(fn1);
    vi.advanceTimersByTime(1000);

    limiter.schedule(fn2);
    expect(fn2).toHaveBeenCalledOnce();
  });
});
