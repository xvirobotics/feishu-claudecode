#!/usr/bin/env tsx
/**
 * STAGE 1 TESTS for PersistentClaudeExecutor.
 *
 * Run with:
 *   npx tsx spike/persistent-executor-stage1.test.ts
 *
 * Validates production-hardening features added in Stage 1:
 *   S1. Idle timeout auto-shutdown
 *   S2. Per-turn abort doesn't kill the process
 *   S3. nextTurn while another in-flight throws (don't silently drop)
 *   S4. Team hooks observability — confirms Bug #1 (do they actually fire?)
 *
 * Each sub-test starts and shuts down its own executor.
 */

import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';
import type { TeamEvent } from '../src/engines/claude/executor.js';

const log = {
  info: (...args: any[]) => console.log('[I]', ...args),
  warn: (...args: any[]) => console.warn('[W]', ...args),
  error: (...args: any[]) => console.error('[E]', ...args),
  debug: (...args: any[]) => console.log('[D]', ...args),
} as any;

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}\n     ${detail}`);
}

async function drainTurn(handle: any): Promise<{ messageCount: number; resultText: string }> {
  let messageCount = 0;
  let resultText = '';
  let lastText = '';
  for await (const msg of handle.stream) {
    messageCount++;
    if (msg.type === 'assistant') {
      for (const blk of msg.message?.content || []) {
        if (blk.type === 'text' && blk.text) lastText = blk.text;
      }
    } else if (msg.type === 'result') {
      resultText = (msg as any).result || lastText;
    }
  }
  return { messageCount, resultText };
}

// ── S1: Idle timeout ──────────────────────────────────────────────────────
async function testIdleTimeout(): Promise<void> {
  console.log('\n──────── S1: idle timeout ────────');
  const executor = new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: log,
    idleTimeoutMs: 3000, // 3 seconds
  });
  const closedPromise = new Promise<void>((resolve) => executor.once('closed', () => resolve()));
  await executor.start();
  // One quick turn so the executor has work history
  const handle = executor.nextTurn('Reply with "OK"');
  await drainTurn(handle);
  log.info('Turn done; sleeping 5s to observe idle timeout');
  const startWait = Date.now();
  await Promise.race([
    closedPromise,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('did not close within 8s')), 8000)),
  ]).then(() => {
    const elapsed = Date.now() - startWait;
    record('S1. idle timeout fires shutdown', elapsed >= 2500 && elapsed <= 7000,
      `closed after ${elapsed}ms (target ~3000ms idle)`);
  }, (err) => {
    record('S1. idle timeout fires shutdown', false, String(err?.message || err));
  });
  // executor should be closed already; ensure clean
  if (executor.getState() !== 'closed') await executor.shutdown('test-cleanup');
}

// ── S2: Per-turn abort ────────────────────────────────────────────────────
async function testTurnAbort(): Promise<void> {
  console.log('\n──────── S2: per-turn abort ────────');
  const executor = new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: log,
    idleTimeoutMs: 0, // disable for this test
  });
  await executor.start();

  // Start a turn and abort it almost immediately (before result)
  const turn1 = executor.nextTurn('Count slowly from 1 to 100, one number per line, with a brief comment about each.');
  let msgsRead = 0;
  // Run iterator + abort+drain concurrently; iterator finishes when queue closes.
  const drainListener = (async () => {
    for await (const _ of turn1.stream) msgsRead++;
  })();
  await new Promise(r => setTimeout(r, 800)); // let some progress happen
  // abort() is now async — it waits until the SDK has fully drained the
  // interrupted turn, so the next turn won't inherit stragglers.
  await turn1.abort();
  await drainListener;
  const aborted1 = turn1.isAborted();
  const state1 = executor.getState();
  record('S2a. abort terminates iterator + flips isAborted', aborted1 && state1 === 'ready',
    `messagesRead=${msgsRead}, isAborted=${aborted1}, state=${state1}`);

  // Process is still alive: next turn should work normally
  const turn2 = executor.nextTurn('Reply with literal "OK".');
  const r2 = await drainTurn(turn2);
  record('S2b. process alive after abort: next turn produces result',
    r2.messageCount > 0 && /OK/.test(r2.resultText),
    `messageCount=${r2.messageCount}, result="${r2.resultText.slice(0, 60)}"`);

  await executor.shutdown('test-done');
}

// ── S3: Concurrent nextTurn rejected ──────────────────────────────────────
async function testConcurrentTurnRejected(): Promise<void> {
  console.log('\n──────── S3: concurrent nextTurn rejected ────────');
  const executor = new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: log,
    idleTimeoutMs: 0,
  });
  await executor.start();
  const t1 = executor.nextTurn('Reply with "ABC".');
  let threw = false;
  try {
    executor.nextTurn('Reply with "DEF".');
  } catch (err: any) {
    threw = err?.message?.includes('in flight');
  }
  // Drain t1 so we don't leak
  await drainTurn(t1);
  record('S3. concurrent nextTurn throws (Stage 1 invariant)', threw,
    `second nextTurn ${threw ? 'correctly threw' : 'did NOT throw — invariant broken'}`);
  await executor.shutdown('test-done');
}

// ── S4: Team hook observability (Bug #1 investigation) ────────────────────
async function testHookObservability(): Promise<void> {
  console.log('\n──────── S4: team hook observability ────────');
  const teamEvents: TeamEvent[] = [];
  const executor = new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: log,
    idleTimeoutMs: 0,
    onTeamEvent: (e) => {
      log.info('  >>> onTeamEvent received:', e.kind, (e as any).teammate, (e as any).teamName);
      teamEvents.push(e);
    },
  });
  await executor.start();
  const handle = executor.nextTurn(
    'Use TeamCreate to make a team called "hook-probe", then use TaskCreate (search if you need to load it) to add ' +
    'one task subject "ping the world", then immediately use TaskUpdate to mark that task completed. ' +
    'Reply briefly when done.',
  );
  const r = await drainTurn(handle);
  log.info(`Turn done. result preview: ${r.resultText.slice(0, 200)}`);

  // Wait a bit for any post-turn hook firings (TeammateIdle might come later)
  await new Promise(res => setTimeout(res, 4000));

  record('S4a. TeamCreate executed (turn produced result)', r.resultText.length > 0,
    `result preview: "${r.resultText.slice(0, 100)}"`);
  record('S4b. INVESTIGATION: did any team hook fire?',
    teamEvents.length > 0,
    `total hook firings: ${teamEvents.length} ` +
    `(kinds: ${teamEvents.map(e => e.kind).join(',') || 'none'})`);
  // This is informational, not pass/fail-blocking — Bug #1 is about whether
  // the hooks fire at all under SDK 0.2.140. If S4b shows 0 firings even
  // after a TaskCreate + TaskUpdate, we've reproduced Bug #1.

  // Cleanup the team
  try {
    const cleanupHandle = executor.nextTurn('Use TeamDelete to clean up the hook-probe team. Confirm briefly.');
    await drainTurn(cleanupHandle);
  } catch { /* best-effort */ }
  await executor.shutdown('test-done');
}

async function main() {
  const tests = [
    ['S1', testIdleTimeout],
    ['S2', testTurnAbort],
    ['S3', testConcurrentTurnRejected],
    ['S4', testHookObservability],
  ] as const;

  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (err) {
      record(`${name}. test threw`, false, String(err));
    }
  }

  console.log('\n════════════ STAGE 1 RESULTS ════════════');
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log('═════════════════════════════════════════');
  // Note: S4b is informational; failure there means Bug #1 is real but
  // doesn't block Stage 1 (hooks not firing isn't worse than they did before).
  const blockingFailures = results.filter(r => !r.pass && !r.name.startsWith('S4b.'));
  if (blockingFailures.length === 0) {
    console.log(allPass
      ? '🎉 ALL STAGE 1 TESTS PASSED'
      : '⚠️  STAGE 1 PASSED with informational failure(s) (S4b expected — Bug #1)');
    process.exit(0);
  } else {
    console.log(`❌ STAGE 1 FAILED — ${blockingFailures.length} blocking failure(s)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Stage 1 tests crashed:', err);
  process.exit(2);
});
