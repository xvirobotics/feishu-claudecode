import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCodexCompaction } from '../src/engines/codex/compaction.js';
import type { ExecutionHandle, SDKMessage } from '../src/engines/claude/executor.js';

const runs: ExecutionHandle[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.finish();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function start(scenario = '') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-compact-'));
  dirs.push(dir);
  const log = join(dir, 'rpc.jsonl');
  const controller = new AbortController();
  const run = startCodexCompaction({
    command: process.execPath, args: [resolve('tests/fixtures/codex-compaction.mjs')],
    env: { ...process.env, SCENARIO: scenario, RPC_LOG: log }, cwd: dir,
    sessionId: 'test-thread', model: 'test-model',
    approvalPolicy: 'never', sandbox: 'read-only', signal: controller.signal,
  });
  runs.push(run);
  const messages: SDKMessage[] = [];
  const drained = (async () => { for await (const m of run.stream) messages.push(m); })();
  return { run, messages, drained, controller, requests: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

describe('Codex native compaction', () => {
  it('resumes and compacts the same thread without starting a user turn', async () => {
    const ctx = start();
    await ctx.drained;
    expect(ctx.messages.at(-1)).toMatchObject({ session_id: 'test-thread', is_error: false, result: expect.stringContaining('压缩完成') });
    expect(ctx.requests().find(r => r.method === 'thread/resume').params.threadId).toBe('test-thread');
    expect(ctx.requests().find(r => r.method === 'thread/compact/start').params).toEqual({ threadId: 'test-thread' });
    expect(ctx.requests().some(r => r.method === 'turn/start' || r.method === 'thread/start')).toBe(false);
  });

  it('does not treat acknowledgement or another thread completion as success and supports cancellation', async () => {
    const ctx = start('hold');
    await vi.waitFor(() => expect(ctx.requests().some(r => r.method === 'thread/compact/start')).toBe(true));
    expect(ctx.messages).toHaveLength(0);
    ctx.controller.abort();
    await ctx.drained;
    expect(ctx.messages.at(-1)).toMatchObject({ is_error: true, errors: ['Task was stopped'] });
  });

  it('requires a confirmed compaction item before reporting success', async () => {
    const ctx = start('no-compaction');
    await ctx.drained;
    expect(ctx.messages.at(-1)).toMatchObject({ is_error: true, errors: ['Codex did not confirm context compaction'] });
  });

  it('reports unexpected process exit as failure', async () => {
    const ctx = start('exit');
    await ctx.drained;
    expect(ctx.messages.at(-1)).toMatchObject({ is_error: true, errors: [expect.stringContaining('exited before compaction completed')] });
  });
});
