import { describe, expect, it } from 'vitest';
import {
  isStaleSessionError,
  normalizePromptForEngine,
  extractSpontaneousSnippet,
  formatSpontaneousCardBody,
  resolvePersistentExecutorEnvDefault,
  SPONTANEOUS_CARD_HEADER,
} from '../src/bridge/message-bridge.js';
import { classifyBurstSource } from '../src/engines/claude/persistent-executor.js';

describe('isStaleSessionError', () => {
  it('matches the GitHub issue error text', () => {
    expect(
      isStaleSessionError('Error: No conversation found with session ID: d0cfbde2-1357-4da0-acd6-ee36d1da056c'),
    ).toBe(true);
  });

  it('matches other stale session variants', () => {
    expect(isStaleSessionError('invalid session provided')).toBe(true);
    expect(isStaleSessionError('Conversation not found')).toBe(true);
  });

  it('matches Codex stale thread resume errors', () => {
    expect(
      isStaleSessionError('Error: Codex exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id ea0dd6d2-7418-4545-8427-63cc8aed81f2'),
    ).toBe(true);
  });

  it('matches conversation corruption errors (duplicate tool_result)', () => {
    expect(
      isStaleSessionError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.148.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_01TPsHXcmpuz5cAY97fM5vXv"}}'),
    ).toBe(true);
    expect(
      isStaleSessionError('each tool_use must have a single result'),
    ).toBe(true);
    expect(
      isStaleSessionError('Found multiple tool_result blocks with id: toolu_abc'),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isStaleSessionError('Task timed out (24 hour limit)')).toBe(false);
    expect(isStaleSessionError('permission denied')).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

describe('normalizePromptForEngine', () => {
  it('converts slash skill invocations to Codex explicit skill syntax', () => {
    expect(normalizePromptForEngine('/metaskill ios app', 'codex')).toBe('$metaskill ios app');
    expect(normalizePromptForEngine('/skill-name', 'codex')).toBe('$skill-name');
  });

  it('leaves non-Codex and non-skill prompts unchanged', () => {
    expect(normalizePromptForEngine('/metaskill ios app', 'claude')).toBe('/metaskill ios app');
    expect(normalizePromptForEngine('/metaskill ios app', 'kimi')).toBe('/metaskill ios app');
    expect(normalizePromptForEngine('hello /metaskill', 'codex')).toBe('hello /metaskill');
    expect(normalizePromptForEngine('/bad/path', 'codex')).toBe('/bad/path');
  });
});

/**
 * Spontaneous-card helpers — extracted so the snippet generator and card
 * title are unit-testable without booting a real MessageBridge.
 *
 * The history these tests guard against: an earlier version included a
 * `msg.type === 'result'` branch in the snippet generator, which produced
 * a `🤖 ...` snippet on top of the assistant text snippet for the same
 * underlying agent reply — flooding the card with duplicates. And the
 * card title used to say "Background activity from your agent team /
 * long-running task", which made users think the agent was *still*
 * running when in fact the card is emitted at the END of a quiet burst.
 */
describe('extractSpontaneousSnippet', () => {
  it('returns assistant text as snippet', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  Weather is sunny  ' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBe('Weather is sunny');
  });

  it('returns 🔧 prefixed tool name for tool_use blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBe('🔧 Bash');
  });

  it('prefers the first usable block (text wins over later tool_use)', () => {
    const msg = {
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    };
    expect(extractSpontaneousSnippet(msg)).toBe('hello');
  });

  it('truncates very long text to 400 chars', () => {
    const long = 'x'.repeat(800);
    const out = extractSpontaneousSnippet({
      type: 'assistant',
      message: { content: [{ type: 'text', text: long }] },
    });
    expect(out).toHaveLength(400);
  });

  // Regression for Bug B (duplicate snippets): result-type messages MUST be
  // ignored. SDK's `result.result` is a verbatim echo of the last assistant
  // text block — including it produced two snippets for the same content.
  it('returns null for result-type messages (regression: no duplicate result snippet)', () => {
    expect(extractSpontaneousSnippet({ type: 'result', result: 'Weather is sunny' })).toBeNull();
    expect(extractSpontaneousSnippet({ type: 'result', result: 'anything' })).toBeNull();
  });

  it('returns null for user/system/other message types', () => {
    expect(extractSpontaneousSnippet({ type: 'user', message: { content: [] } })).toBeNull();
    expect(extractSpontaneousSnippet({ type: 'system' })).toBeNull();
    expect(extractSpontaneousSnippet(null)).toBeNull();
    expect(extractSpontaneousSnippet({})).toBeNull();
  });

  it('returns null for assistant messages with no text/tool_use content', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', text: 'silent' }, { type: 'image' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });

  it('skips empty text blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });
});

describe('formatSpontaneousCardBody', () => {
  it('renders snippets as a numbered list under the header', () => {
    const body = formatSpontaneousCardBody(['🔧 Bash', 'Weather is sunny']);
    expect(body).toContain(SPONTANEOUS_CARD_HEADER);
    expect(body).toMatch(/\*\*1\.\*\*\s+🔧 Bash/);
    expect(body).toMatch(/\*\*2\.\*\*\s+Weather is sunny/);
  });

  // Regression for Bug A (misleading title): the header used to say
  // "Background activity from your agent team / long-running task".
  // Users read "long-running task" as "still running" — but the card is
  // emitted at the END of a quiet burst, so the agent is in fact idle by
  // the time it lands. Header now describes WHAT happened, not an ongoing
  // task. Don't relax these substring checks without re-evaluating the
  // user mental model.
  it('header does not claim a long-running task is in progress (regression)', () => {
    expect(SPONTANEOUS_CARD_HEADER).not.toMatch(/long-running/i);
    expect(SPONTANEOUS_CARD_HEADER).toMatch(/between turns/i);
  });

  it('renders even with empty snippets array (header still present)', () => {
    const body = formatSpontaneousCardBody([]);
    expect(body).toContain(SPONTANEOUS_CARD_HEADER);
  });
});

/**
 * Burst-source classifier — distinguishes SDK-initiated continuation turns
 * (the agent waking up to summarise a `run_in_background` Bash return) from
 * everything else that arrives between user turns (teammate pings, /goal
 * Stop-hook user messages, system status events).
 *
 * The classification matters for UX:
 *   - continuation → render as a fresh streaming card (looks like a user
 *     turn) so the user reads the burst as "the agent continued its work"
 *   - spontaneous  → coalesce into the "Agent activity between turns" card
 *     so multiple ambient pings don't spam the chat
 *
 * The signal we key on is the SDK's `origin.kind === 'task-notification'`
 * field on the FIRST message of a between-turn burst. Don't relax the
 * classifier to also fire on assistant text alone — both buckets see
 * assistant messages after the burst opens; only the OPENING message
 * carries the origin marker.
 */
describe('classifyBurstSource', () => {
  it('returns continuation for a user message with task-notification origin', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'background task finished' },
      origin: { kind: 'task-notification' },
    };
    expect(classifyBurstSource(msg)).toBe('continuation');
  });

  it('returns spontaneous for a user message with no origin (e.g. /goal Stop hook synthesis)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'Goal evaluator says: continue' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for a user message with peer origin (teammate SendMessage)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'hi from teammate' },
      origin: { kind: 'peer', from: 'researcher' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for human-origin user message (manual injection, defensive)', () => {
    // Shouldn't happen in the consumeLoop path (humans go through nextTurn),
    // but the classifier must be conservative — anything not explicitly a
    // task-notification falls back to the coalesced bucket.
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      origin: { kind: 'human' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for assistant text (e.g. teammate burst opening with assistant)', () => {
    // origin is on USER messages, not assistant. An assistant-led burst is
    // either a continuation already in progress (handled by activeTurn) or
    // a teammate ping (spontaneous).
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'doing the thing' }] },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for system task_notification system message (the SDK status event itself)', () => {
    // The SDKTaskNotificationMessage (type:'system' subtype:'task_notification')
    // is the SETTLE event, NOT the wake-up. The wake-up is the follow-up
    // user-role message with origin.kind === 'task-notification'. Keep this
    // routed to spontaneous so the status doesn't accidentally open a card
    // by itself.
    const msg = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'done',
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('handles malformed input defensively (null / missing fields → spontaneous)', () => {
    expect(classifyBurstSource(null)).toBe('spontaneous');
    expect(classifyBurstSource(undefined)).toBe('spontaneous');
    expect(classifyBurstSource({})).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user' })).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user', origin: {} })).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user', origin: { kind: 'unknown-future' } })).toBe('spontaneous');
  });

  it('requires BOTH type==="user" AND origin.kind to fire continuation (not type alone)', () => {
    // Defensive: don't open a continuation just because origin happens to be
    // present on a non-user message — origin lives on user/result types per
    // the SDK type defs, and assistants/system never carry task-notification.
    expect(classifyBurstSource({
      type: 'assistant',
      origin: { kind: 'task-notification' },
    })).toBe('spontaneous');
    expect(classifyBurstSource({
      type: 'result',
      origin: { kind: 'task-notification' },
    })).toBe('spontaneous');
  });
});

/**
 * The persistent executor pool is the load-bearing piece behind background
 * tasks, Agent Teams continuity, and `/goal` multi-turn auto-drive. As of
 * 2026-05-13 it's the DEFAULT — installs that haven't set the env var still
 * get the right behaviour. Opt out with METABOT_PERSISTENT_EXECUTOR=false (or
 * '0').
 *
 * Don't flip the default back to off without a real reason: the card UI now
 * advertises background tasks, and silently disabling them would surprise
 * users who installed-and-went.
 */
describe('resolvePersistentExecutorEnvDefault', () => {
  it('returns true when env var is undefined (the new default)', () => {
    expect(resolvePersistentExecutorEnvDefault(undefined)).toBe(true);
  });

  it('returns true for empty string (env var present but unset value)', () => {
    expect(resolvePersistentExecutorEnvDefault('')).toBe(true);
  });

  it('returns true for explicit on values (back-compat with old opt-in syntax)', () => {
    expect(resolvePersistentExecutorEnvDefault('true')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('1')).toBe(true);
  });

  it('returns false for explicit opt-out values', () => {
    expect(resolvePersistentExecutorEnvDefault('false')).toBe(false);
    expect(resolvePersistentExecutorEnvDefault('0')).toBe(false);
  });

  it('returns true for unrecognised values (do not silently disable a load-bearing feature on a typo)', () => {
    // Anything that isn't an explicit opt-out should keep persistent on.
    // Better to leave a typo-set var on than to silently drop background
    // tasks; the symptom of "off" is much worse (silent breakage) than the
    // symptom of "on" (slightly more memory).
    expect(resolvePersistentExecutorEnvDefault('off')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('no')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('disabled')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('truee')).toBe(true);
  });
});
