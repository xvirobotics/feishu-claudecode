import { describe, it, expect } from 'vitest';
import {
  PersistentClaudeExecutor,
  parseAskUserQuestionInput,
} from '../src/engines/claude/persistent-executor.js';

/**
 * Step 1 of the between-turn AskUserQuestion fix.
 *
 * The hook fires from the SDK whenever Claude invokes AskUserQuestion. When
 * it fires WHILE a user turn is in flight (the common case), the bridge sees
 * `state.pendingQuestion` on the streaming CardState and renders a dedicated
 * question card via the existing runOneTurn path.
 *
 * When the hook fires BETWEEN user turns (teammate / `/goal` / continuation
 * follow-up), `activeTurn` is null and there is no streaming CardState to
 * piggy-back on — the question text would otherwise only land in the
 * coalesced "Agent activity" body, and the user's typed reply would be
 * treated as a fresh user turn (which then blocks for 6 minutes on this
 * still-hanging hook). PersistentClaudeExecutor must emit
 * `between-turn-question` in that case so the bridge can mount a separate
 * question card and route the reply via resolveQuestion().
 *
 * These tests cover the executor side. The bridge wiring is covered by
 * exercising MessageBridge in integration; see the manual test plan in the
 * PR description.
 */

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

function makeExec(): PersistentClaudeExecutor {
  return new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: mockLogger,
    idleTimeoutMs: 0,
  });
}

describe('parseAskUserQuestionInput', () => {
  it('parses a well-formed tool_input', () => {
    const out = parseAskUserQuestionInput({
      questions: [
        {
          question: 'Pick one',
          header: 'choice',
          options: [
            { label: 'A', description: 'Alpha' },
            { label: 'B', description: 'Beta' },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(out).toEqual([
      {
        question: 'Pick one',
        header: 'choice',
        options: [
          { label: 'A', description: 'Alpha' },
          { label: 'B', description: 'Beta' },
        ],
        multiSelect: false,
      },
    ]);
  });

  it('coerces missing / malformed fields into safe defaults', () => {
    const out = parseAskUserQuestionInput({
      questions: [
        { /* no fields */ },
        { question: 'q', header: 'h', options: 'not-an-array' as any },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ question: '', header: '', options: [], multiSelect: false });
    expect(out[1].options).toEqual([]);
  });

  it('returns [] for non-object input', () => {
    expect(parseAskUserQuestionInput(null)).toEqual([]);
    expect(parseAskUserQuestionInput(undefined)).toEqual([]);
    expect(parseAskUserQuestionInput('nope')).toEqual([]);
    expect(parseAskUserQuestionInput({ questions: 'no' })).toEqual([]);
  });
});

describe('PersistentClaudeExecutor between-turn AskUserQuestion', () => {
  // Build the executor and invoke its private buildHooks() to grab the
  // AskUserQuestion PreToolUse hook directly. We don't need a real SDK
  // stream — only the hook itself is on the unit-test path.
  function getHook(exec: PersistentClaudeExecutor): (input: any, toolUseId: string | undefined, ctx: { signal: AbortSignal }) => Promise<Record<string, unknown>> {
    const hooks = (exec as any).buildHooks();
    const preToolUse = hooks.PreToolUse[0].hooks[0];
    return preToolUse;
  }

  it('emits `between-turn-question` when no activeTurn is in flight', async () => {
    const exec = makeExec();
    expect((exec as any).activeTurn).toBeNull();

    const hook = getHook(exec);
    const events: Array<{ toolUseId: string; questions: any[] }> = [];
    exec.on('between-turn-question', (payload) => events.push(payload));

    // Kick the hook and resolve it from "outside" via resolveQuestion.
    const ac = new AbortController();
    const hookPromise = hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_btw_1',
        tool_input: {
          questions: [
            {
              question: 'Continue?',
              header: 'cont',
              options: [
                { label: 'Yes', description: '' },
                { label: 'No', description: '' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
      undefined,
      { signal: ac.signal },
    );

    // The event should have fired synchronously inside the hook promise body.
    expect(events).toHaveLength(1);
    expect(events[0].toolUseId).toBe('toolu_btw_1');
    expect(events[0].questions).toHaveLength(1);
    expect(events[0].questions[0].header).toBe('cont');
    expect(events[0].questions[0].options).toEqual([
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ]);

    // Feed an answer back through the executor's resolveQuestion API —
    // this is what the bridge will do when the user replies in chat.
    exec.resolveQuestion('toolu_btw_1', { cont: 'Yes' });

    const result = await hookPromise;
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          questions: expect.any(Array),
          answers: { cont: 'Yes' },
        },
      },
    });
  });

  it('does NOT emit `between-turn-question` when an activeTurn is in flight', async () => {
    const exec = makeExec();
    // Simulate an active turn (the bridge would have started one via
    // nextTurn() — we don't need the real one for this assertion).
    (exec as any).activeTurn = { id: 't1', queue: { finish: () => {} }, detached: false, completed: false };

    const hook = getHook(exec);
    const events: Array<unknown> = [];
    exec.on('between-turn-question', (p) => events.push(p));

    const ac = new AbortController();
    const hookPromise = hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_in_turn_1',
        tool_input: { questions: [{ question: 'In-turn q', header: 'h', options: [], multiSelect: false }] },
      },
      undefined,
      { signal: ac.signal },
    );

    expect(events).toHaveLength(0);

    // Still resolves through the normal path
    exec.resolveQuestion('toolu_in_turn_1', { h: 'answer' });
    await hookPromise;
  });

  it('the resolver registration happens BEFORE the event fires (avoids race)', async () => {
    const exec = makeExec();
    const hook = getHook(exec);

    let resolverPresentWhenEventFired = false;
    exec.on('between-turn-question', (payload: { toolUseId: string }) => {
      // If the bridge handler tried to resolve as soon as the event arrived,
      // the resolver map must already have the id registered — otherwise
      // the bridge would hit the sendAnswer fallback path.
      resolverPresentWhenEventFired = (exec as any).pendingQuestionResolvers.has(payload.toolUseId);
    });

    const ac = new AbortController();
    const p = hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_race_1',
        tool_input: { questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] },
      },
      undefined,
      { signal: ac.signal },
    );

    expect(resolverPresentWhenEventFired).toBe(true);
    exec.resolveQuestion('toolu_race_1', { h: 'x' });
    await p;
  });

  it('signal abort cancels the hook cleanly without leaking the resolver', async () => {
    const exec = makeExec();
    const hook = getHook(exec);
    const ac = new AbortController();
    const p = hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_abort_1',
        tool_input: { questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] },
      },
      undefined,
      { signal: ac.signal },
    );
    expect((exec as any).pendingQuestionResolvers.has('toolu_abort_1')).toBe(true);
    ac.abort();
    const result = await p;
    expect(result.hookSpecificOutput).toBeDefined();
    expect((exec as any).pendingQuestionResolvers.has('toolu_abort_1')).toBe(false);
  });
});
