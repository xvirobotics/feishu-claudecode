import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAppServerRun, type AppServerRun } from '../src/engines/codex/app-server.js';
import { createLogger } from '../src/utils/logger.js';
import type { SDKMessage } from '../src/engines/claude/executor.js';

const runs: AppServerRun[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.finish();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function start(scenario = '') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rpc-'));
  dirs.push(dir);
  const log = join(dir, 'rpc.jsonl');
  const controller = new AbortController();
  const run = startAppServerRun({
    command: process.execPath, args: [resolve('tests/fixtures/codex-app-server.mjs')],
    env: { ...process.env, SCENARIO: scenario, RPC_LOG: log }, cwd: dir,
    prompt: 'initial', sessionId: 'test-thread', model: 'test-model',
    approvalPolicy: 'never', sandbox: 'read-only', signal: controller.signal,
    logger: createLogger('silent'),
  });
  runs.push(run);
  const messages: SDKMessage[] = [];
  const drained = (async () => { for await (const m of run.stream) messages.push(m); })();
  return { run, messages, drained, controller, requests: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

describe('Codex app-server native controls', () => {
  it('steers the current turn with an exact turn precondition and ignores unrelated threads', async () => {
    const ctx = start();
    await vi.waitFor(() => expect(ctx.run.canSteer()).toBe(true));
    expect(ctx.messages.some(m => m.type === 'result')).toBe(false);
    expect(await ctx.run.steer('new direction')).toBe('steered');
    await ctx.drained;
    expect(ctx.messages.at(-1)).toMatchObject({ type: 'result', is_error: false, result: 'new direction' });
    expect(ctx.requests().find(r => r.method === 'turn/steer').params).toEqual({
      threadId: 'test-thread', expectedTurnId: 'test-turn', input: [{ type: 'text', text: 'new direction' }],
    });
    expect(ctx.requests().filter(r => r.method === 'turn/start')).toHaveLength(1);
    expect(await ctx.run.steer('too late')).toBe('no-active-turn');
  });

  it('does not claim a rejected steering request succeeded or queue another turn', async () => {
    const ctx = start('reject');
    await vi.waitFor(() => expect(ctx.run.canSteer()).toBe(true));
    await expect(ctx.run.steer('late')).rejects.toThrow('No active turn');
    expect(ctx.requests().filter(r => r.method === 'turn/start')).toHaveLength(1);
    ctx.controller.abort();
    await ctx.drained;
  });

  it('reports unexpected process exit as failure', async () => {
    const ctx = start('exit');
    await ctx.drained;
    expect(ctx.messages.at(-1)).toMatchObject({ is_error: true, errors: [expect.stringContaining('exited before completion')] });
  });
});
