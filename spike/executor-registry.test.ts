#!/usr/bin/env tsx
/**
 * STAGE 2 TESTS for ExecutorRegistry + bridge wiring readiness.
 *
 * Run with:
 *   npx tsx spike/executor-registry.test.ts
 *
 * Validates:
 *   R1. acquire() reuses existing healthy executor for same chatId
 *   R2. LRU eviction kicks in past maxConcurrent
 *   R3. release() shuts down the executor and removes it from the pool
 *   R4. shutdownAll() drains everything
 *   R5. apiContext + outputsDir get baked into system prompt
 *       (verified by asking the bot what it knows about its env)
 */

import { ExecutorRegistry } from '../src/engines/claude/executor-registry.js';
import type { TurnHandle } from '../src/engines/claude/persistent-executor.js';

const log = {
  info: (...args: any[]) => console.log('[I]', ...args),
  warn: (...args: any[]) => console.warn('[W]', ...args),
  error: (...args: any[]) => console.error('[E]', ...args),
  debug: (...args: any[]) => console.log('[D]', ...args),
} as any;

interface TestResult { name: string; pass: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}\n     ${detail}`);
}

async function drainTurn(handle: TurnHandle): Promise<{ resultText: string; messageCount: number }> {
  let messageCount = 0;
  let lastText = '';
  let resultText = '';
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
  return { resultText, messageCount };
}

// ── R1+R2+R3: pool semantics (no real Claude needed) ─────────────────────
async function testPoolSemantics(): Promise<void> {
  console.log('\n──────── R1-R4: pool semantics ────────');
  const reg = new ExecutorRegistry({
    logger: log,
    maxConcurrent: 2,
    idleTimeoutMs: 0, // disable for these
  });

  // R1: same chatId reuses
  const e1 = await reg.acquire('chatA', { cwd: '/tmp' });
  const e2 = await reg.acquire('chatA', { cwd: '/tmp' });
  record('R1. same chatId returns same executor', e1 === e2,
    `pool size after re-acquire chatA: ${reg.size()}`);

  // R2: LRU eviction at capacity
  // chatA is now LRU. Acquire chatB and chatC: chatA should be evicted.
  await reg.acquire('chatB', { cwd: '/tmp' });
  // bump chatB so chatA is oldest, then push chatC
  await reg.acquire('chatB', { cwd: '/tmp' });
  await reg.acquire('chatC', { cwd: '/tmp' });
  // wait a tick for the async shutdown of evicted to settle
  await new Promise(r => setTimeout(r, 200));
  const list = reg.list();
  const chatIds = list.map(e => e.chatId);
  record('R2. LRU evicts oldest at capacity', !chatIds.includes('chatA') && chatIds.includes('chatB') && chatIds.includes('chatC'),
    `pool: ${chatIds.join(',')} (expected chatB+chatC, no chatA)`);

  // R3: release shuts down
  await reg.release('chatB', 'test');
  const peek = reg.peek('chatB');
  record('R3. release removes from pool', peek === undefined,
    `peek('chatB') = ${peek === undefined ? 'undefined' : 'still present'}`);

  // R4: shutdownAll
  await reg.shutdownAll('test-cleanup');
  record('R4. shutdownAll drains everything', reg.size() === 0,
    `pool size after shutdownAll: ${reg.size()}`);
}

// ── R5: system-prompt baking ─────────────────────────────────────────────
async function testSystemPromptBaking(): Promise<void> {
  console.log('\n──────── R5: system-prompt baking ────────');
  const reg = new ExecutorRegistry({
    logger: log,
    maxConcurrent: 5,
    idleTimeoutMs: 0,
  });
  const exec = await reg.acquire('chatBaked', {
    cwd: '/tmp',
    apiContext: { botName: 'metabot', chatId: 'oc_2e595bee_TEST' },
    outputsDir: '/tmp/outputs-test-baking',
  });
  const handle = exec.nextTurn(
    'In one short paragraph, tell me: (1) the bot name you are running as, ' +
    '(2) the chat id, and (3) the outputs directory you would put files into. ' +
    'Just state the values.',
  );
  const r = await drainTurn(handle);
  log.info('R5 result:', r.resultText.slice(0, 300));
  const lower = r.resultText.toLowerCase();
  const hasBotName  = lower.includes('metabot');
  const hasChatId   = lower.includes('oc_2e595bee') || lower.includes('test');
  const hasOutDir   = lower.includes('/tmp/outputs-test-baking');
  record('R5. system prompt includes botName+chatId+outputsDir',
    hasBotName && hasChatId && hasOutDir,
    `botName=${hasBotName} chatId=${hasChatId} outputsDir=${hasOutDir}`);

  await reg.shutdownAll('test-done');
}

async function main() {
  for (const fn of [testPoolSemantics, testSystemPromptBaking]) {
    try { await fn(); }
    catch (err) { record(fn.name, false, String((err as any)?.message || err)); }
  }
  console.log('\n════════════ STAGE 2 RESULTS ════════════');
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log('═════════════════════════════════════════');
  console.log(allPass ? '🎉 STAGE 2 PASSED' : '❌ STAGE 2 FAILED');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error('Stage 2 tests crashed:', err); process.exit(2); });
