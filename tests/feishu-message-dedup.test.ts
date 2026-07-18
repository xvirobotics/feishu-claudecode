import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMessageDeduper } from '../src/feishu/event-handler.js';

describe('createMessageDeduper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a first delivery and drops an immediate retry', () => {
    const isDuplicate = createMessageDeduper();
    expect(isDuplicate('om_1')).toBe(false);
    expect(isDuplicate('om_1')).toBe(true);
  });

  it('tracks message ids independently', () => {
    const isDuplicate = createMessageDeduper();
    expect(isDuplicate('om_1')).toBe(false);
    expect(isDuplicate('om_2')).toBe(false);
    expect(isDuplicate('om_1')).toBe(true);
    expect(isDuplicate('om_2')).toBe(true);
  });

  it('keeps dedupers independent across dispatchers (one per bot)', () => {
    // Two bots in the same group each receive an event for the same
    // message_id; one bot's delivery must not suppress the other's.
    const botA = createMessageDeduper();
    const botB = createMessageDeduper();
    expect(botA('om_shared')).toBe(false);
    expect(botB('om_shared')).toBe(false);
  });

  it('forgets a message id after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const isDuplicate = createMessageDeduper(1000);
    expect(isDuplicate('om_1')).toBe(false);
    vi.setSystemTime(500);
    expect(isDuplicate('om_1')).toBe(true);
    vi.setSystemTime(1100);
    expect(isDuplicate('om_1')).toBe(false);
  });
});
