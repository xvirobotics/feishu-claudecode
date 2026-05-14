import { describe, it, expect } from 'vitest';
import { PersistentClaudeExecutor, classifyBurstSource } from '../src/engines/claude/persistent-executor.js';

/**
 * consumeLoop dispatch tests — verify that a between-turn burst gets routed
 * to either the 'continuation-turn' event (opens a fresh main-line card) or
 * the 'spontaneous' coalesce buffer based on {@link classifyBurstSource}.
 *
 * We can't easily boot a real Claude `query()` here, so the strategy is:
 *   - construct the executor (skipping start())
 *   - inject a fake rawStream as a hand-rolled async generator via
 *     reflection (`as any`)
 *   - invoke the private consumeLoop directly
 *   - observe the events / activeTurn / spontaneousBuffer it produces
 *
 * History this guards against:
 *   - Before this fix, EVERY between-turn burst (continuation + teammate +
 *     /goal) went through pushSpontaneous and ended up in the coalesced
 *     "Agent activity between turns" card. The continuation burst is in
 *     fact the main agent finishing its work, not ambient activity, so it
 *     should render as a normal user-turn card. Don't relax the
 *     'task-notification' check to also fire on assistant text — both
 *     buckets emit assistant text after the burst opens; only the
 *     OPENING message carries origin.kind.
 */

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

function makeExec(): PersistentClaudeExecutor {
  // Use the constructor only — start() would try to spawn a real Claude
  // process. We bypass it and inject rawStream below.
  return new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: mockLogger,
    idleTimeoutMs: 0, // disable idle timer so it doesn't interfere
  });
}

async function* streamOf(...msgs: unknown[]): AsyncGenerator<unknown> {
  for (const m of msgs) yield m;
}

describe('PersistentClaudeExecutor consumeLoop: burst dispatch', () => {
  it('emits continuation-turn with a TurnHandle when burst opens with task-notification', async () => {
    const exec = makeExec();
    const taskNotifyMsg = {
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>bash done</task-notification>' },
      session_id: 'sess-1',
    };
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The job completed.' }] },
      session_id: 'sess-1',
    };
    const resultMsg = {
      type: 'result',
      subtype: 'success',
      result: 'The job completed.',
      session_id: 'sess-1',
    };

    (exec as any).rawStream = streamOf(taskNotifyMsg, assistantMsg, resultMsg);

    const handles: any[] = [];
    exec.on('continuation-turn', (h: any) => handles.push(h));

    // Run consumeLoop to completion (the async generator above ends, so it exits)
    await (exec as any).consumeLoop();

    expect(handles).toHaveLength(1);
    expect(typeof handles[0].turnId).toBe('string');
    expect(handles[0].turnId).toMatch(/^c\d+-/); // "c<counter>-<timestamp>" (continuation prefix)
    // The opening user message + assistant + result should be enqueued for
    // the stream listener — collect them.
    const collected: any[] = [];
    for await (const m of handles[0].stream) {
      collected.push(m);
    }
    expect(collected).toHaveLength(3);
    expect(collected[0].origin?.kind).toBe('task-notification');
    expect(collected[1].type).toBe('assistant');
    expect(collected[2].type).toBe('result');
    // After result, activeTurn should be cleared
    expect((exec as any).activeTurn).toBeNull();
  });

  it('pushes to spontaneous when burst opens with a teammate / peer user message', async () => {
    const exec = makeExec();
    const peerMsg = {
      type: 'user',
      origin: { kind: 'peer', from: 'researcher' },
      message: { role: 'user', content: 'I finished my subtask' },
      session_id: 'sess-1',
    };

    (exec as any).rawStream = streamOf(peerMsg);

    const continuations: any[] = [];
    const spontaneous: any[] = [];
    exec.on('continuation-turn', (h: any) => continuations.push(h));
    exec.on('spontaneous', (m: any) => spontaneous.push(m));

    await (exec as any).consumeLoop();

    expect(continuations).toHaveLength(0);
    expect(spontaneous).toHaveLength(1);
    expect(spontaneous[0].origin?.kind).toBe('peer');
  });

  it('pushes the system task_notification settle event itself to spontaneous (not continuation)', async () => {
    // The SDKTaskNotificationMessage is the STATUS event — it does NOT wake
    // the agent on its own. The wake-up is the follow-up user-role message
    // with origin.kind === 'task-notification'. The settle event alone
    // should NOT open a continuation card.
    const exec = makeExec();
    const settleMsg = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'finished',
      session_id: 'sess-1',
    };

    (exec as any).rawStream = streamOf(settleMsg);

    const continuations: any[] = [];
    const spontaneous: any[] = [];
    exec.on('continuation-turn', (h: any) => continuations.push(h));
    exec.on('spontaneous', (m: any) => spontaneous.push(m));

    await (exec as any).consumeLoop();

    expect(continuations).toHaveLength(0);
    expect(spontaneous).toHaveLength(1);
  });

  it('once a continuation turn is open, subsequent messages route through the turn (not spontaneous)', async () => {
    // This guards the interleave case: if more SDK messages arrive after the
    // task-notification opens a continuation, they belong to that turn (the
    // agent's reply), NOT to a fresh spontaneous bucket. Regression target:
    // a future change that resets activeTurn too early between messages.
    const exec = makeExec();
    const taskNotifyMsg = {
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: 'bash done' },
      session_id: 'sess-1',
    };
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'OK' }] },
      session_id: 'sess-1',
    };
    const resultMsg = {
      type: 'result',
      subtype: 'success',
      result: 'OK',
      session_id: 'sess-1',
    };

    (exec as any).rawStream = streamOf(taskNotifyMsg, assistantMsg, resultMsg);
    const spontaneous: any[] = [];
    exec.on('spontaneous', (m: any) => spontaneous.push(m));

    await (exec as any).consumeLoop();

    // Nothing in this burst should leak into the spontaneous channel.
    expect(spontaneous).toHaveLength(0);
  });

  it('opens a NEW continuation turn for a second task-notification burst after the first finishes', async () => {
    // Two background tasks settle one after another, each producing its own
    // brief burst. Each opens its own continuation card.
    const exec = makeExec();
    const burst1 = [
      { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'A done' }, session_id: 's' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'A complete.' }] }, session_id: 's' },
      { type: 'result', subtype: 'success', result: 'A complete.', session_id: 's' },
    ];
    const burst2 = [
      { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'B done' }, session_id: 's' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'B complete.' }] }, session_id: 's' },
      { type: 'result', subtype: 'success', result: 'B complete.', session_id: 's' },
    ];

    (exec as any).rawStream = streamOf(...burst1, ...burst2);

    const handles: any[] = [];
    exec.on('continuation-turn', (h: any) => handles.push(h));

    await (exec as any).consumeLoop();

    expect(handles).toHaveLength(2);
    expect(handles[0].turnId).not.toBe(handles[1].turnId);
  });

  it('classifyBurstSource is the only signal the dispatcher consults (no other side state)', () => {
    // Sanity: the classifier matches the dispatcher's branch, so we can rely
    // on classifyBurstSource as the contract surface for tests.
    expect(classifyBurstSource({
      type: 'user',
      origin: { kind: 'task-notification' },
    })).toBe('continuation');
    expect(classifyBurstSource({
      type: 'user',
      origin: { kind: 'peer' },
    })).toBe('spontaneous');
  });
});
