import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEventDispatcher, createMessageDeduper } from '../src/feishu/event-handler.js';
import type { IncomingMessage } from '../src/types.js';

describe('createMessageDeduper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a first delivery and drops an immediate retry', () => {
    const deduper = createMessageDeduper();
    expect(deduper.isDuplicate('om_1')).toBe(false);
    expect(deduper.isDuplicate('om_1')).toBe(true);
  });

  it('tracks message ids independently', () => {
    const deduper = createMessageDeduper();
    expect(deduper.isDuplicate('om_1')).toBe(false);
    expect(deduper.isDuplicate('om_2')).toBe(false);
    expect(deduper.isDuplicate('om_1')).toBe(true);
    expect(deduper.isDuplicate('om_2')).toBe(true);
  });

  it('keeps dedupers independent across dispatchers (one per bot)', () => {
    // Two bots in the same group each receive an event for the same
    // message_id; one bot's delivery must not suppress the other's.
    const botA = createMessageDeduper();
    const botB = createMessageDeduper();
    expect(botA.isDuplicate('om_shared')).toBe(false);
    expect(botB.isDuplicate('om_shared')).toBe(false);
  });

  it('forgets a message id after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deduper = createMessageDeduper(1000);
    expect(deduper.isDuplicate('om_1')).toBe(false);
    vi.setSystemTime(500);
    expect(deduper.isDuplicate('om_1')).toBe(true);
    vi.setSystemTime(1100);
    expect(deduper.isDuplicate('om_1')).toBe(false);
  });

  it('enforces maxEntries as a hard cap, evicting oldest first', () => {
    const deduper = createMessageDeduper(60_000, 3);
    deduper.isDuplicate('om_1');
    deduper.isDuplicate('om_2');
    deduper.isDuplicate('om_3');
    // Nothing has expired; inserting a 4th id must evict the oldest (om_1),
    // not grow past the cap.
    deduper.isDuplicate('om_4');
    expect(deduper.isDuplicate('om_4')).toBe(true); // newest still tracked
    expect(deduper.isDuplicate('om_2')).toBe(true); // survivor still tracked
    expect(deduper.isDuplicate('om_1')).toBe(false); // evicted → treated as new
  });

  it('sweeps expired entries before evicting live ones when full', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deduper = createMessageDeduper(1000, 2);
    deduper.isDuplicate('om_old');
    vi.setSystemTime(1500); // om_old expired
    deduper.isDuplicate('om_a');
    deduper.isDuplicate('om_b'); // full: expired om_old swept, om_a must survive
    expect(deduper.isDuplicate('om_a')).toBe(true);
    expect(deduper.isDuplicate('om_b')).toBe(true);
  });

  it('release() forgets an id so its redelivery is processed again', () => {
    const deduper = createMessageDeduper();
    expect(deduper.isDuplicate('om_1')).toBe(false);
    deduper.release('om_1');
    expect(deduper.isDuplicate('om_1')).toBe(false);
    expect(deduper.isDuplicate('om_1')).toBe(true); // re-recorded normally
  });
});

// --- Dispatcher-level coverage: duplicate delivery and retry-after-failure ---
// Events go through the public dispatcher entry (no internals), mirroring
// tests/post-image-text-ordering.test.ts.

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

function makeDispatcher(onMessage: (m: IncomingMessage) => void) {
  const config = { groupNoMention: false } as any;
  return createEventDispatcher(config, silentLogger, onMessage);
}

/** Feed one p2p text im.message.receive_v1 event (schema 2.0) through the dispatcher. */
function invokeText(dispatcher: any, msgId: string, text = 'hello') {
  return dispatcher.invoke(
    {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: 'ou_user' } },
        message: {
          message_id: msgId,
          chat_id: 'oc_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text }),
        },
      },
    },
    { needCheck: false },
  );
}

describe('dispatcher dedup: duplicate delivery', () => {
  it('processes a message once when Feishu redelivers it', async () => {
    const received: IncomingMessage[] = [];
    const dispatcher = makeDispatcher(m => received.push(m));
    await invokeText(dispatcher, 'om_1');
    await invokeText(dispatcher, 'om_1'); // at-least-once redelivery
    expect(received).toHaveLength(1);
    expect(received[0].messageId).toBe('om_1');
  });

  it('still processes distinct messages', async () => {
    const received: IncomingMessage[] = [];
    const dispatcher = makeDispatcher(m => received.push(m));
    await invokeText(dispatcher, 'om_1');
    await invokeText(dispatcher, 'om_2');
    expect(received.map(m => m.messageId)).toEqual(['om_1', 'om_2']);
  });
});

describe('dispatcher dedup: retry after downstream failure', () => {
  it('processes the redelivery when the first attempt failed downstream', async () => {
    let calls = 0;
    const dispatcher = makeDispatcher(() => {
      calls++;
      if (calls === 1) throw new Error('downstream boom');
    });
    await invokeText(dispatcher, 'om_1'); // fails; in-flight mark must be released
    await invokeText(dispatcher, 'om_1'); // redelivery gets a fresh attempt
    expect(calls).toBe(2);
  });

  it('dedups again after a failed-then-successful delivery', async () => {
    let calls = 0;
    const dispatcher = makeDispatcher(() => {
      calls++;
      if (calls === 1) throw new Error('downstream boom');
    });
    await invokeText(dispatcher, 'om_1'); // attempt 1: fails, released
    await invokeText(dispatcher, 'om_1'); // attempt 2: succeeds, re-marked
    await invokeText(dispatcher, 'om_1'); // attempt 3: duplicate, dropped
    expect(calls).toBe(2);
  });
});
