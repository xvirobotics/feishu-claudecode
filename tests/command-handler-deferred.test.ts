import { describe, it, expect } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';

/**
 * `/<N> <message>` queues `<message>` to fire N minutes from now. The
 * bridge enforces a **per-chat single-slot rule**: at most one pending
 * deferred message per (bot, chat) — a second `/<N>` while one is queued
 * is rejected with the existing entry's details, and `/0` drops it
 * without needing an ID. The whole feature lives in the numeric
 * `/<digits>` namespace so it can never collide with a word command.
 *
 * These tests cover the command-handler layer in isolation: the scheduler
 * is a hand-rolled fake so the suite stays a pure unit test (no disk I/O,
 * no timers).
 */

interface RecordedNotice {
  chatId:   string;
  title:    string;
  content:  string;
  color?:   string;
}

interface FakeTask {
  id:        string;
  botName:   string;
  chatId:    string;
  prompt:    string;
  executeAt: number;
  createdAt: number;
  status:    'pending' | 'cancelled';
}

class FakeScheduler {
  tasks:        FakeTask[] = [];
  scheduleSpy:  Array<{ delaySeconds: number; prompt: string }> = [];
  cancelSpy:    string[] = [];
  nextId        = 1;

  scheduleTask(input: { botName: string; chatId: string; prompt: string; delaySeconds: number; sendCards?: boolean; label?: string }): FakeTask {
    const now = Date.now();
    const task: FakeTask = {
      id:        `task-${this.nextId++}`,
      botName:   input.botName,
      chatId:    input.chatId,
      prompt:    input.prompt,
      executeAt: now + input.delaySeconds * 1000,
      createdAt: now,
      status:    'pending',
    };
    this.tasks.push(task);
    this.scheduleSpy.push({ delaySeconds: input.delaySeconds, prompt: input.prompt });
    return task;
  }

  getChatTask(botName: string, chatId: string): FakeTask | undefined {
    return this.tasks
      .filter((t) => t.status === 'pending' && t.botName === botName && t.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.status !== 'pending') return false;
    task.status = 'cancelled';
    this.cancelSpy.push(id);
    return true;
  }
}

function buildHandler(opts: { withScheduler?: boolean } = {}) {
  const notices:   RecordedNotice[] = [];
  const sender    = {
    sendCard:        async () => undefined,
    updateCard:      async () => true,
    sendTextNotice:  async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText:        async () => {},
    sendImageFile:   async () => true,
    sendLocalFile:   async () => true,
    downloadImage:   async () => true,
    downloadFile:    async () => true,
  };
  const sessionManager = {
    getSession:        () => ({ workingDirectory: '/tmp', sessionId: undefined, engine: undefined, model: undefined }),
    resetSession:      () => {},
    setSessionEngine:  () => {},
    setSessionModel:   () => {},
  };
  const audit = { log: () => {} } as any;
  const handler = new CommandHandler(
    { name: 'sa', claude: { model: 'claude-sonnet-4-6' } } as any,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender as any,
    sessionManager as any,
    {} as any,
    audit,
    () => undefined,
    () => {},
    () => 0,
    async () => {},
  );
  const scheduler = opts.withScheduler === false ? null : new FakeScheduler();
  if (scheduler) handler.setScheduler(scheduler as any);
  return { handler, notices, scheduler };
}

function msg(text: string): IncomingMessage {
  return {
    messageId:      'm1',
    chatId:         'chat-1',
    chatType:       'p2p',
    userId:         'u1',
    text,
    timestamp:      Date.now(),
    isBotMentioned: true,
  } as IncomingMessage;
}

describe('CommandHandler defer-send (`/<N>` + `/0`)', () => {
  it('queues a deferred message and reports back', async () => {
    const { handler, notices, scheduler } = buildHandler();
    const handled = await handler.handle(msg('/60 写个总结'));
    expect(handled).toBe(true);
    expect(scheduler!.scheduleSpy).toEqual([{ delaySeconds: 3600, prompt: '写个总结' }]);
    expect(notices[0].title).toContain('Deferred Queued');
    expect(notices[0].content).toContain('写个总结');
  });

  it('rejects a second `/<N>` while one is already pending', async () => {
    const { handler, notices, scheduler } = buildHandler();
    await handler.handle(msg('/60 第一条'));
    await handler.handle(msg('/30 第二条'));
    // Only the first one queued
    expect(scheduler!.scheduleSpy).toHaveLength(1);
    expect(scheduler!.scheduleSpy[0].prompt).toBe('第一条');
    const second = notices[notices.length - 1];
    expect(second.title).toContain('Slot Taken');
    expect(second.content).toContain('第一条');
    expect(second.color).toBe('orange');
  });

  it('drops the pending deferred message on `/0`', async () => {
    const { handler, notices, scheduler } = buildHandler();
    await handler.handle(msg('/60 写诗'));
    await handler.handle(msg('/0'));
    expect(scheduler!.cancelSpy).toHaveLength(1);
    const last = notices[notices.length - 1];
    expect(last.title).toContain('Cancelled');
    expect(last.content).toContain('写诗');
  });

  it('`/0` with no pending task is a friendly no-op (blue notice, nothing scheduled/cancelled)', async () => {
    const { handler, notices, scheduler } = buildHandler();
    await handler.handle(msg('/0'));
    const last = notices[notices.length - 1];
    expect(last.title).toContain('Nothing to Cancel');
    expect(last.color).toBe('blue');
    // Truly a no-op — never touches the scheduler.
    expect(scheduler!.scheduleSpy).toHaveLength(0);
    expect(scheduler!.cancelSpy).toHaveLength(0);
  });

  it('`/0` cancels even when a trailing body is present (still treated as cancel)', async () => {
    const { handler, notices, scheduler } = buildHandler();
    await handler.handle(msg('/60 写诗'));
    await handler.handle(msg('/0 ignored body'));
    expect(scheduler!.cancelSpy).toHaveLength(1);
    expect(scheduler!.scheduleSpy).toHaveLength(1); // only the /60, never a /0 schedule
    const last = notices[notices.length - 1];
    expect(last.title).toContain('Cancelled');
  });

  it('rejects `/<N>` with no message body', async () => {
    const { handler, notices, scheduler } = buildHandler();
    await handler.handle(msg('/60'));
    expect(scheduler!.scheduleSpy).toHaveLength(0);
    expect(notices[0].title).toContain('Missing Message');
  });

  it('rejects defer longer than 7 days (>10080 min)', async () => {
    const { handler, notices, scheduler } = buildHandler();
    await handler.handle(msg('/10081 太远了'));
    expect(scheduler!.scheduleSpy).toHaveLength(0);
    expect(notices[0].title).toContain('Too Long');
  });

  it('accepts the boundary value 10080 (exactly 7 days)', async () => {
    const { handler, scheduler } = buildHandler();
    await handler.handle(msg('/10080 一周后'));
    expect(scheduler!.scheduleSpy).toEqual([{ delaySeconds: 10080 * 60, prompt: '一周后' }]);
  });

  it('reports gracefully when no scheduler is wired up', async () => {
    const { handler, notices } = buildHandler({ withScheduler: false });
    await handler.handle(msg('/60 hi'));
    expect(notices[0].title).toContain('Defer Unavailable');
    expect(notices[0].color).toBe('red');
  });

  it('`/status` shows the pending deferred entry', async () => {
    const { handler, notices } = buildHandler();
    await handler.handle(msg('/60 摘要任务'));
    await handler.handle(msg('/status'));
    const status = notices[notices.length - 1];
    expect(status.title).toContain('Status');
    expect(status.content).toMatch(/Deferred:/);
    expect(status.content).toContain('摘要任务');
  });

  it('`/status` shows `_None_` when nothing is queued', async () => {
    const { handler, notices } = buildHandler();
    await handler.handle(msg('/status'));
    const status = notices[notices.length - 1];
    expect(status.content).toMatch(/Deferred:.*None/);
  });
});
