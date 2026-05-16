import { describe, it, expect } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';

/**
 * /stop must (a) abort the running task AND (b) discard queued messages,
 * otherwise processQueue() immediately picks the next queued message and
 * the user's "stop" intent silently fails.
 *
 * If this test starts failing because someone changed the wiring back to
 * stop-only-no-clear, that's the regression — restore the clearQueue call,
 * don't relax the assertion.
 */

interface RecordedNotice {
  chatId: string;
  title:  string;
  content: string;
  color?: string;
}

interface HandlerOpts {
  hasRunningTask?: boolean;
  queueDepth?:     number;
}

function buildHandler(opts: HandlerOpts = {}) {
  const notices: RecordedNotice[] = [];
  let stopTaskCalls = 0;
  let clearQueueCalls = 0;
  let queueDepth = opts.queueDepth ?? 0;

  const sender = {
    sendCard:       async () => undefined,
    updateCard:     async () => true,
    sendTextNotice: async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText:      async () => {},
    sendImageFile: async () => true,
    sendLocalFile: async () => true,
    downloadImage: async () => true,
    downloadFile:  async () => true,
  };
  const audit = { log: () => {} } as any;

  const handler = new CommandHandler(
    { name: 'test-bot' } as any,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender as any,
    {} as any, // sessionManager — not touched by /stop
    {} as any, // memoryClient — not touched
    audit,
    () => (opts.hasRunningTask ? { startTime: Date.now() - 1000 } : undefined),
    () => { stopTaskCalls++; },
    () => {
      clearQueueCalls++;
      const cleared = queueDepth;
      queueDepth = 0;
      return cleared;
    },
    async () => {},
  );
  return {
    handler,
    notices,
    counters: () => ({ stopTaskCalls, clearQueueCalls }),
  };
}

function stopMessage(): IncomingMessage {
  return {
    messageId:      'm1',
    chatId:         'c1',
    chatType:       'p2p',
    userId:         'u1',
    text:           '/stop',
    timestamp:      Date.now(),
    isBotMentioned: true,
  } as IncomingMessage;
}

describe('CommandHandler /stop', () => {
  it('with running task and no queue → aborts and sends 🛑 Stopped', async () => {
    const { handler, notices, counters } = buildHandler({ hasRunningTask: true, queueDepth: 0 });
    await handler.handle(stopMessage());
    expect(counters().stopTaskCalls).toBe(1);
    expect(counters().clearQueueCalls).toBe(1);            // always called, no-op when empty
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Stopped');
    expect(notices[0].content).not.toMatch(/Discarded/);
  });

  it('with running task and N queued → aborts AND mentions discarded count (regression)', async () => {
    const { handler, notices, counters } = buildHandler({ hasRunningTask: true, queueDepth: 3 });
    await handler.handle(stopMessage());
    expect(counters().stopTaskCalls).toBe(1);
    expect(counters().clearQueueCalls).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Stopped');
    expect(notices[0].content).toContain('3');             // count surfaced
    expect(notices[0].content).toMatch(/[Dd]iscard/);
  });

  it('with running task and 1 queued → singular wording (no rogue plural "s")', async () => {
    const { handler, notices } = buildHandler({ hasRunningTask: true, queueDepth: 1 });
    await handler.handle(stopMessage());
    // Match the meaningful phrase ignoring markdown bolding around the count.
    expect(notices[0].content).toMatch(/queued message\./);  // singular form
    expect(notices[0].content).not.toMatch(/queued messages/);
  });

  it('with no running task but queue had messages → clears queue and reports it', async () => {
    const { handler, notices, counters } = buildHandler({ hasRunningTask: false, queueDepth: 2 });
    await handler.handle(stopMessage());
    expect(counters().stopTaskCalls).toBe(0);              // nothing to stop
    expect(counters().clearQueueCalls).toBe(1);
    expect(notices[0].title).toContain('Queue Cleared');
    expect(notices[0].content).toContain('2');
  });

  it('with no running task and no queue → "No Running Task" notice, no stop call', async () => {
    const { handler, notices, counters } = buildHandler({ hasRunningTask: false, queueDepth: 0 });
    await handler.handle(stopMessage());
    expect(counters().stopTaskCalls).toBe(0);
    expect(counters().clearQueueCalls).toBe(1);            // probed but found nothing
    expect(notices[0].title).toContain('No Running Task');
  });
});
