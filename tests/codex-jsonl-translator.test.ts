import { describe, expect, it } from 'vitest';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import {
  createCodexTranslatorState,
  translateCodexJsonEvent,
  type CodexJsonEvent,
} from '../src/engines/codex/jsonl-translator.js';

describe('Codex JSONL translator', () => {
  it('maps Codex exec events into the existing stream processor shape', () => {
    const events: CodexJsonEvent[] = [
      { type: 'thread.started', thread_id: '019dbe98-98b1-78b1-a6b0-b422e495db52' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'I’ll run `pwd` once.' },
      },
      {
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: '/bin/zsh -lc pwd',
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: '/bin/zsh -lc pwd',
          aggregated_output: '/Users/maxzhou/Dev/metabot\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'DONE' } },
      { type: 'turn.completed', usage: { input_tokens: 23111, cached_input_tokens: 12800, output_tokens: 70 } },
    ];

    const state = createCodexTranslatorState({ model: 'gpt-5.4-codex', contextWindow: 400000 });
    const processor = new StreamProcessor('Run pwd');

    let cardState = processor.processMessage({ type: 'system' });
    for (const event of events) {
      for (const message of translateCodexJsonEvent(event, state)) {
        cardState = processor.processMessage(message);
      }
    }

    expect(processor.getSessionId()).toBe('019dbe98-98b1-78b1-a6b0-b422e495db52');
    expect(cardState.status).toBe('complete');
    expect(cardState.responseText).toBe('DONE');
    expect(cardState.toolCalls).toEqual([{ name: 'Bash', detail: '`/bin/zsh -lc pwd`', status: 'done' }]);
    expect(cardState.model).toBe('gpt-5.4-codex');
    expect(cardState.totalTokens).toBe(23181);
    expect(cardState.contextWindow).toBe(400000);
  });

  it('maps failed turns to error results', () => {
    const state = createCodexTranslatorState();
    const processor = new StreamProcessor('hello');

    for (const message of translateCodexJsonEvent({ type: 'thread.started', thread_id: 'codex-thread' }, state)) {
      processor.processMessage(message);
    }
    let cardState = processor.processMessage({ type: 'system' });
    for (const message of translateCodexJsonEvent({ type: 'turn.failed', error: { message: 'network failed' } }, state)) {
      cardState = processor.processMessage(message);
    }

    expect(cardState.status).toBe('error');
    expect(cardState.errorMessage).toBe('network failed');
  });
});
