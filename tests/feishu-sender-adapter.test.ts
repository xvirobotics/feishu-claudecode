import { describe, it, expect } from 'vitest';
import { buildCardForState } from '../src/feishu/feishu-sender-adapter.js';
import type { CardState } from '../src/types.js';

/**
 * Schema-selection logic for Feishu cards.
 *
 * The adapter defaults to Card Schema 2.0 (native tables, lark_md headings,
 * grey footer) — but falls back to v1 whenever the card carries an
 * AskUserQuestion (`state.pendingQuestion`). Reason: Feishu mobile App
 * silently drops `tag: action` button blocks under Schema 2.0, making the
 * option buttons invisible on iOS/Android. v1 button rendering is verified
 * working on mobile (PR #199). Question cards don't use any v2-exclusive
 * feature, so the fallback has no visible regression.
 *
 * Don't change this back to "always v2 when CARD_SCHEMA_V2 is on" without
 * also fixing Feishu mobile's v2 `tag: action` render bug — otherwise
 * AskUserQuestion stops working on mobile again, like it did before this
 * fix (see memory: bug-feishu-v2-mobile-action-buttons).
 */
describe('buildCardForState — schema picker', () => {
  const baseState: CardState = {
    status: 'running',
    userPrompt: 'do a thing',
    responseText: 'working...',
    toolCalls: [],
  };

  it('renders v2 (schema:"2.0") for a normal running card', () => {
    const card = buildCardForState(baseState);
    expect(card).toContain('"schema":"2.0"');
  });

  it('renders v2 for thinking / complete / error cards (no pendingQuestion)', () => {
    for (const status of ['thinking', 'running', 'complete', 'error'] as const) {
      const card = buildCardForState({ ...baseState, status });
      expect(card, `status=${status}`).toContain('"schema":"2.0"');
    }
  });

  it('falls back to v1 (no schema field) when the card carries a pendingQuestion', () => {
    // Mobile Feishu can't render v2 `tag: action`, so the buttons go
    // invisible. v1 IS verified working on mobile. Without this fallback
    // AskUserQuestion is broken on the mobile App.
    const card = buildCardForState({
      ...baseState,
      status: 'waiting_for_input',
      pendingQuestion: {
        toolUseId: 'toolu_test',
        questions: [{
          question: '今天想吃什么？',
          header: '今日午餐',
          options: [
            { label: '吃鸡', description: '白切鸡' },
            { label: '吃鸭', description: '烤鸭' },
          ],
          multiSelect: false,
        }],
      },
    });
    expect(card).not.toContain('"schema":"2.0"');
    // Sanity: v1 still renders the buttons + their callbacks (the whole
    // point of falling back).
    expect(card).toContain('answer_question');
    expect(card).toContain('吃鸡');
    expect(card).toContain('吃鸭');
  });

  it('passes the pendingQuestion through even on a non-waiting status (defensive)', () => {
    // Should still fall back to v1 — the trigger is the presence of the
    // question, not the status. e.g. a card that just transitioned and
    // still has pendingQuestion attached.
    const card = buildCardForState({
      ...baseState,
      status: 'running',
      pendingQuestion: {
        toolUseId: 'toolu_test',
        questions: [{
          question: 'pick one',
          header: 'pick',
          options: [{ label: 'a', description: 'option a' }],
          multiSelect: false,
        }],
      },
    });
    expect(card).not.toContain('"schema":"2.0"');
  });
});
