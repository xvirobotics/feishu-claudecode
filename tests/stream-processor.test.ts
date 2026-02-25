import { describe, it, expect } from 'vitest';
import { StreamProcessor, extractImagePaths } from '../src/claude/stream-processor.js';
import type { SDKMessage } from '../src/claude/executor.js';

function msg(overrides: Partial<SDKMessage>): SDKMessage {
  return { type: 'system', session_id: 'sess-1', ...overrides } as SDKMessage;
}

describe('StreamProcessor', () => {
  it('starts in thinking status', () => {
    const p = new StreamProcessor('hello');
    const state = p.processMessage(msg({ type: 'system', session_id: 'sess-1' }));
    expect(state.status).toBe('thinking');
    expect(state.userPrompt).toBe('hello');
    expect(state.responseText).toBe('');
    expect(state.toolCalls).toEqual([]);
  });

  it('captures session_id from first message', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({ type: 'system', session_id: 'abc-123' }));
    expect(p.getSessionId()).toBe('abc-123');
  });

  it('accumulates text from stream_event deltas', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'text' } },
    }));
    const state = p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } },
    }));
    expect(state.responseText).toBe('Hello world');
    expect(state.status).toBe('running');
  });

  it('tracks tool calls from stream events', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    }));
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].name).toBe('Read');
    expect(state.toolCalls[0].status).toBe('running');
    expect(state.status).toBe('running');
  });

  it('ignores subagent stream events', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: 'tool-123',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'subagent text' } },
    }));
    expect(state.responseText).toBe('');
  });

  it('processes result message as complete', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'result',
      subtype: 'success',
      result: 'Done!',
      total_cost_usd: 0.05,
      duration_ms: 1200,
    }));
    expect(state.status).toBe('complete');
    expect(state.responseText).toBe('Done!');
    expect(state.costUsd).toBe(0.05);
    expect(state.durationMs).toBe(1200);
  });

  it('processes error result message', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'result',
      subtype: 'error',
      result: '',
      errors: ['Something failed', 'Another error'],
      total_cost_usd: 0.01,
      duration_ms: 500,
    }));
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe('Something failed; Another error');
  });

  it('detects AskUserQuestion and sets waiting_for_input', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool-q1',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Which option?',
              header: 'Choice',
              options: [
                { label: 'A', description: 'Option A' },
                { label: 'B', description: 'Option B' },
              ],
              multiSelect: false,
            }],
          },
        }],
      },
    }));
    expect(state.status).toBe('waiting_for_input');
    expect(state.pendingQuestion).toBeDefined();
    expect(state.pendingQuestion!.toolUseId).toBe('tool-q1');
    expect(state.pendingQuestion!.questions[0].question).toBe('Which option?');
  });

  it('tracks Write tool image paths', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/tmp/output.png' },
        }],
      },
    }));
    expect(p.getImagePaths()).toEqual(['/tmp/output.png']);
  });

  it('does not track non-image Write paths', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/tmp/output.txt' },
        }],
      },
    }));
    expect(p.getImagePaths()).toEqual([]);
  });

  it('marks all tools as done on result', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
    }));
    const state = p.processMessage(msg({
      type: 'result',
      subtype: 'success',
      result: 'ok',
    }));
    expect(state.toolCalls.every(t => t.status === 'done')).toBe(true);
  });
});

describe('extractImagePaths', () => {
  it('extracts image paths from text', () => {
    const text = 'Created file at /tmp/img/chart.png and /home/user/photo.jpg';
    const paths = extractImagePaths(text);
    expect(paths).toContain('/tmp/img/chart.png');
    expect(paths).toContain('/home/user/photo.jpg');
  });

  it('returns empty for no matches', () => {
    expect(extractImagePaths('no images here')).toEqual([]);
  });

  it('deduplicates paths', () => {
    const text = '/tmp/a.png and /tmp/a.png again';
    expect(extractImagePaths(text)).toHaveLength(1);
  });
});
