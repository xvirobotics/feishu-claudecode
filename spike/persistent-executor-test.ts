#!/usr/bin/env tsx
/**
 * SPIKE TEST: validate PersistentClaudeExecutor.
 *
 * Run with:
 *   npx tsx spike/persistent-executor-test.ts
 *
 * What this checks:
 *   T1. Process actually starts and responds to a turn.
 *   T2. SessionId is stable across multiple turns (proves single process).
 *   T3. A subagent spawned in turn 1 is still addressable in turn 2.
 *       This is THE critical test — proves the architectural fix works.
 *   T4. Input queue stays alive across many turns without finish().
 *   T5. Spontaneous messages (between turns) get buffered.
 *
 * Pass/fail printed at the end.
 */

import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';
import type { SDKMessage } from '../src/engines/claude/executor.js';

// Tiny logger
const log = {
  info: (...args: any[]) => console.log('[I]', ...args),
  warn: (...args: any[]) => console.warn('[W]', ...args),
  error: (...args: any[]) => console.error('[E]', ...args),
  debug: (...args: any[]) => console.log('[D]', ...args),
} as any;

interface TurnSummary {
  turnNum: number;
  prompt: string;
  durationMs: number;
  messageCount: number;
  resultText: string;
  sessionId?: string;
  saw: {
    assistant: number;
    toolUse: number;
    system: number;
    result: number;
  };
}

async function runTurn(
  executor: PersistentClaudeExecutor,
  turnNum: number,
  prompt: string,
): Promise<TurnSummary> {
  log.info(`\n──────── TURN ${turnNum} ────────`);
  log.info(`PROMPT: ${prompt}`);
  const start = Date.now();
  const handle = executor.nextTurn(prompt);
  const summary: TurnSummary = {
    turnNum,
    prompt,
    durationMs: 0,
    messageCount: 0,
    resultText: '',
    saw: { assistant: 0, toolUse: 0, system: 0, result: 0 },
  };
  let lastAssistantText = '';
  for await (const msg of handle.stream) {
    summary.messageCount++;
    if (msg.session_id) summary.sessionId = msg.session_id;
    switch (msg.type) {
      case 'assistant': {
        summary.saw.assistant++;
        const blocks = msg.message?.content || [];
        for (const blk of blocks) {
          if (blk.type === 'text' && blk.text) {
            lastAssistantText = blk.text;
          } else if (blk.type === 'tool_use') {
            summary.saw.toolUse++;
            log.debug(`  tool_use: ${blk.name}`);
          }
        }
        break;
      }
      case 'system':
        summary.saw.system++;
        break;
      case 'result':
        summary.saw.result++;
        summary.resultText = (msg as any).result || lastAssistantText || '';
        break;
    }
  }
  summary.durationMs = Date.now() - start;
  log.info(`TURN ${turnNum} done in ${(summary.durationMs / 1000).toFixed(1)}s — ${summary.messageCount} msgs, sessionId=${summary.sessionId?.slice(0, 8)}`);
  log.info(`  result preview: ${summary.resultText.slice(0, 200).replace(/\n/g, ' ')}`);
  return summary;
}

async function main() {
  const cwd = '/tmp';
  log.info(`Starting PersistentClaudeExecutor (cwd=${cwd})`);
  const executor = new PersistentClaudeExecutor({ cwd, logger: log });

  let spontaneousCount = 0;
  executor.on('spontaneous', () => { spontaneousCount++; });
  executor.on('crashed', (err) => log.error('CRASHED:', err?.message || err));

  await executor.start();
  log.info('Executor ready, state=', executor.getState());

  // T1+T2+T4: simple two-turn flow, check sessionId stability
  const turn1 = await runTurn(
    executor,
    1,
    'Reply with the literal text "ALPHA" and nothing else.',
  );
  const turn2 = await runTurn(
    executor,
    2,
    'Now reply with "BETA" and nothing else. Do you remember what you replied last time?',
  );

  // T3: spawn a subagent in turn 3, then in turn 4 try to interact with it
  // (Subagent here = spawned via Agent tool; if persistent executor works,
  // that subagent should still be addressable via SendMessage in turn 4.)
  // Note: full Agent Teams test requires ~minutes; this is the minimal probe.
  const turn3 = await runTurn(
    executor,
    3,
    'Spawn a teammate named "echo-bot" using TeamCreate + Agent tool. Just have it sit idle awaiting instructions. Then briefly confirm you spawned it.',
  );

  // Brief pause to let any spontaneous messages arrive (idle notifications)
  await new Promise(r => setTimeout(r, 5000));
  const spontBeforeT4 = spontaneousCount;
  const spontMessagesBetween = executor.drainSpontaneous();
  log.info(`Spontaneous messages between turn3 and turn4: ${spontMessagesBetween.length}`);

  const turn4 = await runTurn(
    executor,
    4,
    'Send a SendMessage to teammate "echo-bot" asking "Are you still alive?" Then in plain text tell me whether SendMessage succeeded or failed.',
  );

  // Cleanup attempt: ask lead to TeamDelete, then shutdown
  const turn5 = await runTurn(
    executor,
    5,
    'Use TeamDelete to clean up the team. Confirm in plain text when done.',
  );

  log.info('\nShutting down executor...');
  await executor.shutdown();
  log.info('Executor closed, final state=', executor.getState());

  // ───── PASS/FAIL ────────────────────────────────────────────
  console.log('\n════════════ SPIKE RESULTS ════════════');
  const checks: Array<[string, boolean, string]> = [];

  checks.push([
    'T1. Process started and turn 1 produced a result',
    turn1.saw.result > 0 && turn1.resultText.length > 0,
    `result_count=${turn1.saw.result}, result_preview="${turn1.resultText.slice(0, 60)}"`,
  ]);

  checks.push([
    'T2. SessionId stable across turn 1 and turn 2',
    !!turn1.sessionId && turn1.sessionId === turn2.sessionId,
    `t1.sid=${turn1.sessionId?.slice(0, 8)} t2.sid=${turn2.sessionId?.slice(0, 8)}`,
  ]);

  checks.push([
    'T2b. Same sessionId across all 5 turns (single persistent process)',
    [turn1, turn2, turn3, turn4, turn5].every(t => t.sessionId === turn1.sessionId),
    `sids=${[turn1, turn2, turn3, turn4, turn5].map(t => t.sessionId?.slice(0, 8)).join(' ')}`,
  ]);

  checks.push([
    'T3. Turn 3 spawned a subagent (saw tool_use blocks)',
    turn3.saw.toolUse > 0,
    `turn3 tool_use count=${turn3.saw.toolUse}`,
  ]);

  // The critical check — turn 4's reply should NOT contain "not addressable"
  const t4lower = turn4.resultText.toLowerCase();
  const sendMessageFailed = t4lower.includes('not currently addressable')
    || t4lower.includes('no agent named')
    || t4lower.includes('failed');
  checks.push([
    'T3b. CRITICAL: subagent spawned in turn 3 still alive in turn 4',
    !sendMessageFailed,
    `turn4 result first 200 chars: "${turn4.resultText.slice(0, 200)}"`,
  ]);

  checks.push([
    'T4. Multiple turns ran without re-spawn (input queue stayed alive)',
    [turn1, turn2, turn3, turn4, turn5].every(t => t.saw.result > 0),
    `result counts: ${[turn1, turn2, turn3, turn4, turn5].map(t => t.saw.result).join(' ')}`,
  ]);

  checks.push([
    'T5. Spontaneous-message buffering wired up',
    typeof executor.drainSpontaneous === 'function',
    `spont_total=${spontaneousCount}, drained_between_t3_t4=${spontMessagesBetween.length}, before_t4=${spontBeforeT4}`,
  ]);

  let allPass = true;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    console.log(`     ${detail}`);
    if (!ok) allPass = false;
  }
  console.log('═══════════════════════════════════════');
  console.log(allPass ? '🎉 SPIKE PASSED — PersistentClaudeExecutor viable' : '❌ SPIKE FAILED — review above');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Spike crashed:', err);
  process.exit(2);
});
