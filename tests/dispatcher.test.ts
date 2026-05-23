import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRoutes, dispatchRoute } from '../src/cluster/dispatcher.js';
import {
  sessionJsonlPath,
  type SessionRecord,
  type SessionRegistry,
} from '../src/session/session-registry.js';
import type { BotRegistry, RegisteredBot } from '../src/api/bot-registry.js';

/**
 * Fake registries that satisfy only the slice of the public surface that
 * dispatcher handlers touch. Casting to the full class type via `as unknown
 * as X` is the standard pattern for narrow test doubles here — the
 * dispatcher contract is intentionally just `findByChatId / listSessions`
 * + `get(name)`.
 */
function fakeSessionRegistry(records: SessionRecord[]): SessionRegistry {
  const byId = new Map(records.map((r) => [r.chatId, r]));
  const byBot = new Map<string, SessionRecord[]>();
  for (const r of records) {
    const list = byBot.get(r.botName) ?? [];
    list.push(r);
    byBot.set(r.botName, list);
  }
  return {
    findByChatId: (chatId: string) => byId.get(chatId) ?? null,
    listSessions: (botName: string) =>
      (byBot.get(botName) ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt),
    close: () => {},
  } as unknown as SessionRegistry;
}

function fakeBotRegistry(botNames: string[]): BotRegistry {
  const set = new Set(botNames);
  return {
    get: (name: string) =>
      set.has(name) ? ({ name, platform: 'feishu' } as unknown as RegisteredBot) : undefined,
    list: () => [...set].map((name) => ({ name, platform: 'feishu' })),
  } as unknown as BotRegistry;
}

/**
 * Build a minimal but realistic JSONL transcript on disk so resolveTranscriptCore
 * has something to read. We DON'T fake $HOME — the production helper uses
 * `os.homedir()` which Node caches at startup and doesn't re-read the env.
 * Instead we use the actual sessionJsonlPath(workdir, sessionId) the
 * dispatcher will look at, and track every file we created so afterEach
 * cleans up under the real home.
 */
function writeJsonlFixture(
  workingDirectory: string,
  claudeSessionId: string,
  createdFiles: string[],
): string {
  const filePath = sessionJsonlPath(workingDirectory, claudeSessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    { type: 'user',      message: { role: 'user',      content: 'hello' }, timestamp: '2025-01-01T00:00:00Z' },
    { type: 'assistant', message: { role: 'assistant', content: 'world' }, timestamp: '2025-01-01T00:00:01Z' },
  ];
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  createdFiles.push(filePath);
  return filePath;
}

describe('dispatcher routes', () => {
  let tmpHome: string;
  let createdFiles: string[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-test-'));
    createdFiles = [];
  });

  afterEach(() => {
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns 404 for unknown routes', async () => {
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([]),
      botRegistry:     fakeBotRegistry([]),
    });
    const result = await dispatchRoute('nope.missing', {}, routes);
    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toMatch(/unknown route/);
  });

  it('transcript.get: 400 when chatId missing', async () => {
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([]),
      botRegistry:     fakeBotRegistry([]),
    });
    const result = await routes['transcript.get']({});
    expect(result.status).toBe(400);
  });

  it('transcript.get: 404 (session) when chatId unknown', async () => {
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([]),
      botRegistry:     fakeBotRegistry(['alpha']),
    });
    const result = await routes['transcript.get']({ chatId: 'missing', turn: 'all' });
    expect(result.status).toBe(404);
    expect((result.body as { reason: string }).reason).toBe('session');
  });

  it('transcript.get: 404 (bot) when bot no longer registered', async () => {
    const record: SessionRecord = {
      id:               'chat-1',
      botName:          'gone-bot',
      workingDirectory: '/tmp/workdir',
      title:            'a',
      platform:         'feishu',
      chatId:           'chat-1',
      createdAt:        1,
      updatedAt:        2,
    };
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([record]),
      botRegistry:     fakeBotRegistry([]), // bot gone
    });
    const result = await routes['transcript.get']({ chatId: 'chat-1', turn: 'all' });
    expect(result.status).toBe(404);
    expect((result.body as { reason: string }).reason).toBe('bot');
  });

  it('transcript.get: 200 with empty transcript when claudeSessionId missing', async () => {
    const record: SessionRecord = {
      id:               'chat-2',
      botName:          'alpha',
      workingDirectory: '/tmp/workdir',
      title:            'fresh',
      platform:         'feishu',
      chatId:           'chat-2',
      createdAt:        1,
      updatedAt:        2,
    };
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([record]),
      botRegistry:     fakeBotRegistry(['alpha']),
    });
    const result = await routes['transcript.get']({ chatId: 'chat-2', turn: 'all' });
    expect(result.status).toBe(200);
    const body = result.body as { chat: { totalTurns: number; title?: string }; messages: unknown[] };
    expect(body.chat.totalTurns).toBe(0);
    expect(body.chat.title).toBe('fresh');
    expect(body.messages).toEqual([]);
  });

  it('transcript.get: 200 reads the JSONL when claudeSessionId is present', async () => {
    // Use the tmpHome path itself as the workdir — it's already unique to
    // this test run, so its encoded form won't collide with any real bot.
    const workingDirectory = tmpHome;
    const claudeSessionId  = crypto.randomUUID();
    writeJsonlFixture(workingDirectory, claudeSessionId, createdFiles);

    const record: SessionRecord = {
      id:               'chat-3',
      botName:          'alpha',
      claudeSessionId,
      workingDirectory,
      title:            't3',
      platform:         'feishu',
      chatId:           'chat-3',
      createdAt:        1,
      updatedAt:        2,
    };
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([record]),
      botRegistry:     fakeBotRegistry(['alpha']),
    });
    const result = await routes['transcript.get']({ chatId: 'chat-3', turn: 'all' });
    expect(result.status).toBe(200);
    const body = result.body as { chat: { totalTurns: number }; messages: unknown[] };
    expect(body.chat.totalTurns).toBe(1);
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it('sessions.list: 400 when botName missing', async () => {
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([]),
      botRegistry:     fakeBotRegistry(['alpha']),
    });
    const result = await routes['sessions.list']({});
    expect(result.status).toBe(400);
  });

  it('sessions.list: 404 when bot unknown', async () => {
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([]),
      botRegistry:     fakeBotRegistry(['alpha']),
    });
    const result = await routes['sessions.list']({ botName: 'beta' });
    expect(result.status).toBe(404);
  });

  it('sessions.list: 200 returns the bot sessions ordered by updatedAt desc', async () => {
    const records: SessionRecord[] = [
      { id: 'a', botName: 'alpha', workingDirectory: '/w', title: 'A', platform: 'feishu', chatId: 'a', createdAt: 1, updatedAt: 10 },
      { id: 'b', botName: 'alpha', workingDirectory: '/w', title: 'B', platform: 'feishu', chatId: 'b', createdAt: 1, updatedAt: 30 },
      { id: 'c', botName: 'alpha', workingDirectory: '/w', title: 'C', platform: 'feishu', chatId: 'c', createdAt: 1, updatedAt: 20 },
      { id: 'd', botName: 'beta',  workingDirectory: '/w', title: 'D', platform: 'feishu', chatId: 'd', createdAt: 1, updatedAt: 99 },
    ];
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry(records),
      botRegistry:     fakeBotRegistry(['alpha', 'beta']),
    });
    const result = await routes['sessions.list']({ botName: 'alpha' });
    expect(result.status).toBe(200);
    const list = result.body as SessionRecord[];
    expect(list.map((r) => r.chatId)).toEqual(['b', 'c', 'a']);
  });

  it('hub.botList: still 501 — PR-6 wires this', async () => {
    const routes = createRoutes({
      sessionRegistry: fakeSessionRegistry([]),
      botRegistry:     fakeBotRegistry([]),
    });
    const result = await routes['hub.botList']({});
    expect(result.status).toBe(501);
  });

  it('dispatchRoute wraps a thrown handler in a 500', async () => {
    const routes = {
      'boom': async () => {
        throw new Error('kaboom');
      },
    };
    const result = await dispatchRoute('boom', {}, routes);
    expect(result.status).toBe(500);
    expect((result.body as { message: string }).message).toBe('kaboom');
  });
});
