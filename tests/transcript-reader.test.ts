import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTranscript } from '../src/session/transcript-reader.js';

/**
 * Build a deterministic 3-turn jsonl fixture with:
 *   - turn 1: plain user → assistant text
 *   - turn 2: user → assistant (thinking + tool_use Read) → tool_result → assistant text
 *   - turn 3: user → assistant tool_use Bash → tool_result with isError
 * The carrier "user" entries that hold tool_results MUST NOT count as turn
 * boundaries — that's the most important invariant of the reader.
 */
function buildFixture(): string {
  const lines: object[] = [];

  // Turn 1
  lines.push({
    type: 'user',
    message: { role: 'user', content: 'hello' },
    uuid: 'u1',
    timestamp: '2026-05-21T10:00:00.000Z',
  });
  lines.push({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }],
    },
    uuid: 'a1',
    timestamp: '2026-05-21T10:00:01.000Z',
  });

  // Turn 2: user → assistant with thinking + tool_use → tool_result → assistant text
  lines.push({
    type: 'user',
    message: { role: 'user', content: 'read pkg.json' },
    uuid: 'u2',
    timestamp: '2026-05-21T10:01:00.000Z',
  });
  lines.push({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'planning' },
        {
          type: 'tool_use',
          id:   'tool-123',
          name: 'Read',
          input: { file_path: '/etc/hosts' },
        },
      ],
    },
    uuid: 'a2',
    timestamp: '2026-05-21T10:01:01.000Z',
  });
  // Pure tool_result carrier — must NOT bump the turn counter.
  lines.push({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: '127.0.0.1 localhost' }],
    },
    uuid: 'tr2',
    timestamp: '2026-05-21T10:01:02.000Z',
  });
  lines.push({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'localhost is mapped to 127.0.0.1' }],
    },
    uuid: 'a2b',
    timestamp: '2026-05-21T10:01:03.000Z',
  });

  // Turn 3: tool_use with isError
  lines.push({
    type: 'user',
    message: { role: 'user', content: 'run ls' },
    uuid: 'u3',
    timestamp: '2026-05-21T10:02:00.000Z',
  });
  lines.push({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-456', name: 'Bash', input: { command: 'ls /nope' } },
      ],
    },
    uuid: 'a3',
    timestamp: '2026-05-21T10:02:01.000Z',
  });
  lines.push({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-456', content: 'no such file', is_error: true },
      ],
    },
    uuid: 'tr3',
    timestamp: '2026-05-21T10:02:02.000Z',
  });

  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('readTranscript', () => {
  const tmp = path.join(os.tmpdir(), `mb-transcript-${Date.now()}.jsonl`);
  beforeAll(() => fs.writeFileSync(tmp, buildFixture()));
  afterAll(() => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } });

  it('returns empty when the file does not exist', () => {
    const r = readTranscript('/nonexistent.jsonl', 'all');
    expect(r.totalTurns).toBe(0);
    expect(r.messages).toEqual([]);
  });

  it('counts 3 user turns (carrier tool_result users do NOT count)', () => {
    const r = readTranscript(tmp, 'all');
    expect(r.totalTurns).toBe(3);
  });

  it('turn=1 yields only the first user + its assistant reply', () => {
    const r = readTranscript(tmp, 1);
    expect(r.totalTurns).toBe(3);
    expect(r.messages.length).toBe(2);
    expect(r.messages[0]).toMatchObject({ role: 'user',      text: 'hello' });
    expect(r.messages[1]).toMatchObject({ role: 'assistant', text: 'hi there' });
  });

  it('turn=2 inlines tool_result back into the assistant message that issued the call', () => {
    const r = readTranscript(tmp, 2);
    // user + assistant(thinking+toolcall) + assistant(text). Carrier user is hidden.
    expect(r.messages.length).toBe(3);
    expect(r.messages[0]).toMatchObject({ role: 'user', text: 'read pkg.json' });
    const withTool = r.messages[1];
    expect(withTool.role).toBe('assistant');
    expect(withTool.thinking).toContain('planning');
    expect(withTool.toolCalls).toBeDefined();
    expect(withTool.toolCalls?.length).toBe(1);
    const tc = withTool.toolCalls![0];
    expect(tc).toMatchObject({ id: 'tool-123', name: 'Read', status: 'done' });
    expect(tc.result).toBeDefined();
    expect(tc.result?.content).toContain('127.0.0.1');
    expect(r.messages[2]).toMatchObject({ role: 'assistant', text: 'localhost is mapped to 127.0.0.1' });
  });

  it('turn=3 preserves isError on the tool result', () => {
    const r = readTranscript(tmp, 3);
    expect(r.messages.length).toBe(2);
    const a = r.messages[1];
    expect(a.role).toBe('assistant');
    expect(a.toolCalls).toBeDefined();
    expect(a.toolCalls?.[0].name).toBe('Bash');
    expect(a.toolCalls?.[0].result?.isError).toBe(true);
  });

  it('turn=all returns every visible message', () => {
    const r = readTranscript(tmp, 'all');
    expect(r.totalTurns).toBe(3);
    // 3 user + 4 assistant (2 in turn 2, 1 each in turns 1 and 3) = 7 visible.
    expect(r.messages.length).toBe(7);
  });

  it('clamps an out-of-range turn to the last turn', () => {
    const r = readTranscript(tmp, 99);
    expect(r.totalTurns).toBe(3);
    // Falls into turn 3.
    expect(r.messages[0].text).toBe('run ls');
  });
});
