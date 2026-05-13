#!/usr/bin/env tsx
/**
 * STAGE 3 TESTS — spontaneous-message wiring.
 *
 * Run with:
 *   npx tsx spike/stage3-spontaneous.test.ts
 *
 * We can't easily run the full MessageBridge here (it pulls in Feishu /
 * memory / etc.), so we test the LIBRARY-LEVEL wiring:
 *
 *   S3-1. Registry emits 'executor-added' on acquire (so the bridge can
 *         attach a spontaneous handler exactly once per executor).
 *   S3-2. Registry emits 'executor-removed' on release/eviction.
 *   S3-3. Live E2E: spawn a teammate via the persistent executor, end the
 *         user turn, watch spontaneous messages roll in from the teammate.
 *         Confirms that "messages between turns reach the bridge" — the
 *         essential precondition for spontaneous Feishu cards to work.
 */

import { ExecutorRegistry } from '../src/engines/claude/executor-registry.js';
import type { SDKMessage } from '../src/engines/claude/executor.js';

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

async function drainTurn(handle: any): Promise<{ result: string }> {
  let lastText = '';
  let result = '';
  for await (const msg of handle.stream) {
    if (msg.type === 'assistant') {
      for (const blk of msg.message?.content || []) {
        if (blk.type === 'text' && blk.text) lastText = blk.text;
      }
    } else if (msg.type === 'result') {
      result = (msg as any).result || lastText;
    }
  }
  return { result };
}

// ── S3-1 + S3-2: registry events ─────────────────────────────────────────
async function testRegistryEvents(): Promise<void> {
  console.log('\n──────── S3-1 + S3-2: registry events ────────');
  const reg = new ExecutorRegistry({ logger: log, maxConcurrent: 5, idleTimeoutMs: 0 });
  const added: string[] = [];
  const removed: string[] = [];
  reg.on('executor-added', (chatId: string) => added.push(chatId));
  reg.on('executor-removed', (chatId: string) => removed.push(chatId));

  // Acquire two distinct chats
  await reg.acquire('chat-A', { cwd: '/tmp' });
  await reg.acquire('chat-B', { cwd: '/tmp' });
  // Re-acquire chat-A: should NOT fire 'executor-added' again
  await reg.acquire('chat-A', { cwd: '/tmp' });

  record('S3-1. executor-added fires once per new chatId',
    added.length === 2 && added.includes('chat-A') && added.includes('chat-B'),
    `added events: ${JSON.stringify(added)}`);

  await reg.release('chat-A', 'test');
  // Give the 'closed' event a tick to propagate through to 'executor-removed'
  await new Promise(r => setTimeout(r, 200));

  record('S3-2. executor-removed fires on release',
    removed.includes('chat-A'),
    `removed events: ${JSON.stringify(removed)}`);

  await reg.shutdownAll('test-done');
}

// ── S3-3: live spontaneous flow ──────────────────────────────────────────
async function testLiveSpontaneousFlow(): Promise<void> {
  console.log('\n──────── S3-3: live spontaneous flow ────────');
  const reg = new ExecutorRegistry({ logger: log, maxConcurrent: 5, idleTimeoutMs: 0 });
  const exec = await reg.acquire('chat-spont', {
    cwd: '/tmp',
    apiContext: { botName: 'metabot', chatId: 'oc_2e595bee_SPONT' },
    outputsDir: '/tmp/metabot-outputs-spont',
  });

  const spontaneous: SDKMessage[] = [];
  exec.on('spontaneous', (msg: SDKMessage) => spontaneous.push(msg));

  // Turn 1: spawn an "echo-bot" teammate that will sit idle (will produce a
  // post-turn idle notification — the canonical spontaneous message in
  // Agent Teams under SDK 0.2.140).
  const t1 = exec.nextTurn(
    'Use TeamCreate to make a team "spont-probe", then use the Agent tool to ' +
    'spawn a teammate named "echo-bot" (subagent_type=general-purpose) telling it ' +
    'to just acknowledge it\'s alive and wait for instructions. Confirm briefly.',
  );
  await drainTurn(t1);

  // After the user turn ends, the teammate sends idle notifications etc.
  // Wait until we've seen at least one assistant or result spontaneous
  // message (which is what handleSpontaneousMessage in the bridge would
  // actually render), or up to 30s. Polling here makes the test robust
  // against teammate response-time variance — earlier 6s was too tight.
  log.info('Waiting up to 30s for spontaneous teammate notifications...');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hasRenderable = spontaneous.some(m =>
      (m.type === 'assistant' && m.message?.content?.some(b => (b.type === 'text' && b.text) || b.type === 'tool_use'))
      || (m.type === 'result' && (m as any).result),
    );
    if (hasRenderable) break;
    await new Promise(r => setTimeout(r, 500));
  }

  record('S3-3. spontaneous messages arrived between turns',
    spontaneous.length > 0,
    `received ${spontaneous.length} spontaneous messages (${spontaneous.map(m => m.type).join(',')})`);

  // Sanity: at least one of them should be human-readable
  // (assistant text or result text — what handleSpontaneousMessage filters for)
  let hasReadable = false;
  for (const msg of spontaneous) {
    if (msg.type === 'assistant') {
      for (const blk of msg.message?.content || []) {
        if ((blk.type === 'text' && blk.text) || blk.type === 'tool_use') {
          hasReadable = true;
          break;
        }
      }
    } else if (msg.type === 'result' && (msg as any).result) {
      hasReadable = true;
    }
    if (hasReadable) break;
  }
  record('S3-3b. at least one spontaneous message would render in a card',
    hasReadable || spontaneous.length === 0, // skip if no spontaneous at all (already failed above)
    `hasReadable=${hasReadable}, spontaneous types=${spontaneous.map(m => m.type).join(',')}`);

  // Cleanup
  const t2 = exec.nextTurn('Use TeamDelete to clean up. Confirm briefly.');
  await drainTurn(t2);
  await reg.shutdownAll('test-done');
}

async function main() {
  for (const fn of [testRegistryEvents, testLiveSpontaneousFlow]) {
    try { await fn(); }
    catch (err) { record(fn.name, false, String((err as any)?.message || err)); }
  }
  console.log('\n════════════ STAGE 3 RESULTS ════════════');
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log('═════════════════════════════════════════');
  console.log(allPass ? '🎉 STAGE 3 PASSED' : '❌ STAGE 3 FAILED');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error('Stage 3 tests crashed:', err); process.exit(2); });
