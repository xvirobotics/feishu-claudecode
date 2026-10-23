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
  let stop!: () => void;
  const hooks: PtyHookBridge = {
    writeSettings: async () => '/unused-settings',
    onTurnComplete: cb => { stop = cb; },
    onTeamEvent() {}, dispose: async () => {},
  };
  const query = ptyQuery({ prompt: input, options: { cwd: '/unused', logger: createLogger('silent'), hookBridge: hooks } });
  queries.push(query);
  input.enqueue({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' });
  await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith(prompt));
  return { query, stop: () => stop() };
}
describe('Claude Code native controls', () => {
  it('submits steering to the live composer without opening another turn or interrupting', async () => {
    const ctx = await start('initial task');
    expect(ctx.query.canSteer?.()).toBe(true);
    expect(await ctx.query.steer?.('new direction')).toBe('steered');
    expect(fake.session.steerPrompt).toHaveBeenCalledWith('new direction');
    expect(fake.session.typePrompt).toHaveBeenCalledTimes(1);
    expect(fake.session.interrupt).not.toHaveBeenCalled();
    ctx.stop();
    expect(await ctx.query.steer?.('late')).toBe('no-active-turn');
  });

});
