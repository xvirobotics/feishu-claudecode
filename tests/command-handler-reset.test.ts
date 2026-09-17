import { describe, it, expect } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';

interface RecordedNotice {
  chatId: string;
  title: string;
  content: string;
  color?: string;
}

interface HandlerOpts {
  hasRunningTask?: boolean;
  queueDepth?: number;
}

function buildHandler(opts: HandlerOpts = {}) {
  const notices: RecordedNotice[] = [];
  let stopTaskCalls = 0;
  let clearQueueCalls = 0;
  let resetSessionCalls = 0;
  let releaseExecutorCalls = 0;
  let queueDepth = opts.queueDepth ?? 0;

  const sender = {
    sendCard: async () => undefined,
    updateCard: async () => true,
    sendTextNotice: async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText: async () => {},
    sendImageFile: async () => true,
    sendLocalFile: async () => true,
    downloadImage: async () => true,
    downloadFile: async () => true,
  };
  const audit = { log: () => {} } as any;

  const handler = new CommandHandler(
    { name: 'test-bot' } as any,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender as any,
    { resetSession: () => { resetSessionCalls++; } } as any,
    {} as any,
    audit,
    () => (opts.hasRunningTask ? { startTime: Date.now() - 1000 } : undefined),
    () => { stopTaskCalls++; },
    () => {
      clearQueueCalls++;
      const cleared = queueDepth;
      queueDepth = 0;
      return cleared;
    },
    async () => { releaseExecutorCalls++; },
    () => [],
    async () => {},
  );

  return {
    handler,
    notices,
    counters: () => ({ stopTaskCalls, clearQueueCalls, resetSessionCalls, releaseExecutorCalls }),
  };
}

function resetMessage(command = '/reset'): IncomingMessage {
  return {
    messageId: 'm1',
    chatId: 'c1',
    chatType: 'p2p',
    userId: 'u1',
    text: command,
    timestamp: Date.now(),
    isBotMentioned: true,
  } as IncomingMessage;
}

describe('CommandHandler /reset', () => {
  it('aborts a running task, clears queued messages, resets session, and releases executor', async () => {
    const { handler, notices, counters } = buildHandler({ hasRunningTask: true, queueDepth: 2 });

    await handler.handle(resetMessage());

    expect(counters()).toEqual({
      stopTaskCalls: 1,
      clearQueueCalls: 1,
      resetSessionCalls: 1,
      releaseExecutorCalls: 1,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Session Reset');
    expect(notices[0].color).toBe('green');
  });

  it('clears queued messages even when no task is currently running', async () => {
    const { handler, counters } = buildHandler({ hasRunningTask: false, queueDepth: 1 });

    await handler.handle(resetMessage());

    expect(counters().stopTaskCalls).toBe(0);
    expect(counters().clearQueueCalls).toBe(1);
    expect(counters().resetSessionCalls).toBe(1);
    expect(counters().releaseExecutorCalls).toBe(1);
  });

  it('/new is an alias with the same reset behavior', async () => {
    const { handler, notices, counters } = buildHandler({ hasRunningTask: true, queueDepth: 2 });

    const handled = await handler.handle(resetMessage('/new'));

    expect(handled).toBe(true);
    expect(counters()).toEqual({
      stopTaskCalls: 1,
      clearQueueCalls: 1,
      resetSessionCalls: 1,
      releaseExecutorCalls: 1,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Session Reset');
  });
});
