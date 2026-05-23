import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTranscriptCore } from './resolve.js';

/**
 * Minimal 2-turn jsonl fixture used to exercise the happy path. Mirrors the
 * format the local SessionRegistry writes — the resolver only needs a real
 * file because it ends up calling `readTranscript()` underneath.
 */
function buildFixture(): string {
  const lines: object[] = [
    { type: 'user', message: { role: 'user', content: 'hi' },           uuid: 'u1', timestamp: '2026-05-21T10:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, uuid: 'a1', timestamp: '2026-05-21T10:00:01.000Z' },
    { type: 'user', message: { role: 'user', content: 'again' },        uuid: 'u2', timestamp: '2026-05-21T10:01:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },  uuid: 'a2', timestamp: '2026-05-21T10:01:01.000Z' },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('resolveTranscriptCore', () => {
  let dir:  string;
  let path_: string;

  beforeAll(() => {
    dir   = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-resolve-'));
    path_ = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(path_, buildFixture(), 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns 404 with reason=session when sessionRecord is null', () => {
    const r = resolveTranscriptCore({
      chatId:        'oc_missing',
      turn:          'all',
      sessionRecord: null,
      botKnown:      true,
      jsonlPath:     null,
    });
    expect(r.status).toBe(404);
    if (r.status === 404) {
      expect(r.body.reason).toBe('session');
      expect(r.body.error).toBe('session not found');
    }
  });

  it('returns 404 with reason=bot when sessionRecord present but botKnown=false', () => {
    const r = resolveTranscriptCore({
      chatId:        'oc_x',
      turn:          'all',
      sessionRecord: { botName: 'gone', workingDirectory: '/tmp/x' },
      botKnown:      false,
      jsonlPath:     null,
    });
    expect(r.status).toBe(404);
    if (r.status === 404) expect(r.body.reason).toBe('bot');
  });

  it('returns 200 with empty messages when claudeSessionId is missing', () => {
    const r = resolveTranscriptCore({
      chatId:        'oc_fresh',
      turn:          'all',
      sessionRecord: { botName: 'sa', workingDirectory: '/tmp/x', title: 'Untitled' },
      botKnown:      true,
      jsonlPath:     null,
    });
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.chat).toEqual({ chatId: 'oc_fresh', totalTurns: 0, title: 'Untitled' });
      expect(r.body.messages).toEqual([]);
      expect(r.body.turn).toBe('all');
    }
  });

  it('returns 200 with real messages when jsonlPath points at a transcript', () => {
    const r = resolveTranscriptCore({
      chatId:        'oc_real',
      turn:          'all',
      sessionRecord: { botName: 'sa', workingDirectory: '/tmp/x', claudeSessionId: 'sess', title: 'T', platform: 'feishu' },
      botKnown:      true,
      jsonlPath:     path_,
    });
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.chat.totalTurns).toBe(2);
      expect(r.body.chat.botName).toBe('sa');
      expect(r.body.chat.platform).toBe('feishu');
      expect(r.body.messages.length).toBe(4);
    }
  });

  it('honours numeric turn selection (turn=1 narrows the window)', () => {
    const r = resolveTranscriptCore({
      chatId:        'oc_real',
      turn:          1,
      sessionRecord: { botName: 'sa', workingDirectory: '/tmp/x', claudeSessionId: 'sess' },
      botKnown:      true,
      jsonlPath:     path_,
    });
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.chat.totalTurns).toBe(2);
      expect(r.body.turn).toBe(1);
      // Turn 1 = first user + first assistant only.
      expect(r.body.messages.length).toBe(2);
      expect(r.body.messages[0].role).toBe('user');
      expect(r.body.messages[1].role).toBe('assistant');
    }
  });

  it('returns 200 with empty messages when jsonlPath points at a non-existent file', () => {
    const r = resolveTranscriptCore({
      chatId:        'oc_x',
      turn:          'all',
      sessionRecord: { botName: 'sa', workingDirectory: '/tmp/x', claudeSessionId: 'sess' },
      botKnown:      true,
      jsonlPath:     path.join(dir, 'does-not-exist.jsonl'),
    });
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.chat.totalTurns).toBe(0);
      expect(r.body.messages).toEqual([]);
    }
  });
});
