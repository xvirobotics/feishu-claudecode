import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncQueue } from '../src/utils/async-queue.js';
import { createLogger } from '../src/utils/logger.js';
import type { PtyUserMessage, PtyHookBridge, PtyQuery } from '../src/engines/claude/pty/contract.js';

const fake = vi.hoisted(() => ({
  session: {
    sessionId: 'claude-session', jsonlPath: '/unused',
    ready: vi.fn(async () => {}), typePrompt: vi.fn(async () => {}),
    steerPrompt: vi.fn(async () => {}), screen: vi.fn(() => '❯'),
    snapshot: vi.fn(() => '❯'), sendKeys: vi.fn(),
    interrupt: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
  },
}));
vi.mock('../src/engines/claude/pty/pty-session.js', () => ({ createPtyClaudeSession: () => fake.session }));
vi.mock('../src/engines/claude/pty/jsonl-scanner.js', () => ({
  createJsonlScanner: () => ({
    stop() {},
    async *[Symbol.asyncIterator]() { yield* []; await new Promise(() => {}); },
  }),
}));
import { ptyQuery } from '../src/engines/claude/pty/pty-query.js';

const queries: PtyQuery[] = [];
afterEach(async () => {
  for (const query of queries.splice(0)) await query.dispose?.();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function start(prompt: string) {
  const input = new AsyncQueue<PtyUserMessage>();
  let stop!: () => void, compact!: () => void;
  const hooks: PtyHookBridge = {
    writeSettings: async () => '/unused-settings',
    onTurnComplete: cb => { stop = cb; },
    onCompactComplete: cb => { compact = cb; },
    onTeamEvent() {}, dispose: async () => {},
  };
  const query = ptyQuery({ prompt: input, options: { cwd: '/unused', logger: createLogger('silent'), hookBridge: hooks } });
  queries.push(query);
  input.enqueue({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' });
  await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith(prompt));
  return { query, stop: () => stop(), compact: () => compact() };
}
describe('Claude Code native controls', () => {
  it('waits for PostCompact, never for the generic slash timeout or ordinary Stop', async () => {
    const ctx = await start('/compact');
    vi.useFakeTimers();
    const messages: unknown[] = [];
    void (async () => { for await (const m of ctx.query) messages.push(m); })();
    ctx.stop();
    await vi.advanceTimersByTimeAsync(7000);
    expect(messages).toHaveLength(0);
    ctx.compact();
    await vi.advanceTimersByTimeAsync(500);
    expect(messages).toEqual([expect.objectContaining({ type: 'result', is_error: false, session_id: 'claude-session' })]);
    ctx.compact();
    await vi.advanceTimersByTimeAsync(500);
    expect(messages).toHaveLength(1);
  });

  it('interrupts compaction and ignores late completion events', async () => {
    const ctx = await start('/compact');
    const iterator = ctx.query[Symbol.asyncIterator]();
    await ctx.query.interrupt();
    expect((await iterator.next()).value).toMatchObject({ type: 'result', is_error: true });
    ctx.compact();
  });
});
