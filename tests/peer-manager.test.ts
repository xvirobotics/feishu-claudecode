import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PeerManager } from '../src/api/peer-manager.js';

function createLogger() {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  logger.child.mockReturnValue(logger);
  return logger;
}

describe('PeerManager', () => {
  let manager: PeerManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-peer-manager-'));
    vi.stubEnv('METABOT_PEER_CACHE_PATH', path.join(tempDir, 'peer-cache.json'));
  });

  afterEach(() => {
    if (manager) manager.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('initializes with empty peer bots', () => {
    manager = new PeerManager([], createLogger());
    expect(manager.getPeerBots()).toEqual([]);
    expect(manager.getPeerStatuses()).toEqual([]);
  });

  it('refreshPeer caches bots from a healthy peer', async () => {
    const mockBots = {
      bots: [
        { name: 'bot-a', platform: 'feishu', workingDirectory: '/work/a' },
        { name: 'bot-b', description: 'B bot', platform: 'telegram', workingDirectory: '/work/b' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockBots),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots).toHaveLength(2);
    expect(bots[0].name).toBe('bot-a');
    expect(bots[0].peerUrl).toBe('http://localhost:9200');
    expect(bots[0].peerName).toBe('alice');
    expect(bots[1].name).toBe('bot-b');
    expect(bots[1].description).toBe('B bot');

    const statuses = manager.getPeerStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].healthy).toBe(true);
    expect(statuses[0].botCount).toBe(2);
  });

  it('marks peer as unhealthy when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    manager = new PeerManager([
      { name: 'bob', url: 'http://unreachable:9999' },
    ], createLogger());

    await manager.refreshAll();

    expect(manager.getPeerBots()).toEqual([]);
    const statuses = manager.getPeerStatuses();
    expect(statuses[0].healthy).toBe(false);
    expect(statuses[0].error).toBe('ECONNREFUSED');
  });

  it('marks peer as unhealthy on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    manager = new PeerManager([
      { name: 'locked', url: 'http://locked:9100' },
    ], createLogger());

    await manager.refreshAll();

    expect(manager.getPeerBots()).toEqual([]);
    const statuses = manager.getPeerStatuses();
    expect(statuses[0].healthy).toBe(false);
    expect(statuses[0].error).toContain('401');
  });

  it('filters out transitive bots (bots with peerUrl)', async () => {
    const mockBots = {
      bots: [
        { name: 'local-bot', platform: 'feishu', workingDirectory: '/work' },
        { name: 'transitive-bot', platform: 'feishu', workingDirectory: '/other', peerUrl: 'http://third:9300' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockBots),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe('local-bot');
  });

  it('findBotPeer returns correct peer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        bots: [{ name: 'backend-bot', platform: 'feishu', workingDirectory: '/work' }],
      }),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200', secret: 'sec' },
    ], createLogger());

    await manager.refreshAll();

    const result = manager.findBotPeer('backend-bot');
    expect(result).toBeDefined();
    expect(result!.peer.name).toBe('alice');
    expect(result!.bot.name).toBe('backend-bot');
  });

  it('findBotPeer returns undefined for unknown bot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();
    expect(manager.findBotPeer('nonexistent')).toBeUndefined();
  });

  it('findBotOnPeer returns bot from specific peer', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('9200/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [{ name: 'bot-a', platform: 'feishu', workingDirectory: '/a' }] }) });
      }
      if (url.includes('9300/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [{ name: 'bot-b', platform: 'telegram', workingDirectory: '/b' }] }) });
      }
      // skills endpoints
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
      { name: 'bob', url: 'http://localhost:9300' },
    ], createLogger());

    await manager.refreshAll();

    const result = manager.findBotOnPeer('bob', 'bot-b');
    expect(result).toBeDefined();
    expect(result!.peer.name).toBe('bob');

    // Should not find alice's bot on bob
    expect(manager.findBotOnPeer('bob', 'bot-a')).toBeUndefined();
  });

  it('forwardTask sends POST with X-MetaBot-Origin header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, responseText: 'done' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([], createLogger());

    const result = await manager.forwardTask(
      { name: 'alice', url: 'http://localhost:9200', secret: 'sec' },
      { botName: 'bot-a', chatId: 'chat1', prompt: 'hello' },
    );

    expect(result).toEqual({ success: true, responseText: 'done' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9200/api/talk',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-MetaBot-Origin': 'peer',
          'Authorization': 'Bearer sec',
        }),
      }),
    );
  });

  it('sends auth header when peer has secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'secure-peer', url: 'http://remote:9100', secret: 'my-secret' },
    ], createLogger());

    await manager.refreshAll();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://remote:9100/api/bots',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer my-secret', 'X-MetaBot-Origin': 'peer' }),
      }),
    );
  });

  it('does not send auth header when peer has no secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'local-peer', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9200/api/bots',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-MetaBot-Origin': 'peer' }),
      }),
    );
  });

  it('normalizes trailing slashes in URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [{ name: 'b', platform: 'feishu', workingDirectory: '/' }] }),
    }));

    manager = new PeerManager([
      { name: 'trailing', url: 'http://localhost:9200///' },
    ], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots[0].peerUrl).toBe('http://localhost:9200');
  });

  it('returns stale peer skills from the persistent cache when a peer is offline', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [] }) });
      }
      if (url.includes('/api/skills/lark-doc')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            skillMd: '# Lark Doc\n',
            referencesTar: Buffer.from('refs').toString('base64'),
          }),
        });
      }
      if (url.includes('/api/skills')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            skills: [{
              name: 'lark-doc',
              description: 'Read Lark docs',
              version: 3,
              author: 'alice',
              tags: ['lark'],
              contentHash: 'hash-1',
            }],
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());
    await manager.refreshAll();
    manager.destroy();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());
    await manager.refreshAll();

    const skills = manager.getPeerSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'lark-doc',
      peerName: 'alice',
      stale: true,
      hasCachedContent: true,
    });
  });

  it('falls back to cached peer skill content when the peer is offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [] }) });
      }
      if (url.includes('/api/skills/lark-doc')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            skillMd: '# Cached Skill\n',
            referencesTar: Buffer.from('cached refs').toString('base64'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          skills: [{
            name: 'lark-doc',
            description: 'Read Lark docs',
            version: 1,
            author: 'alice',
            tags: [],
            contentHash: 'hash-2',
          }],
        }),
      });
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());
    await manager.refreshAll();
    manager.destroy();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    manager = new PeerManager([], createLogger());

    const skill = await manager.fetchPeerSkill('alice', 'lark-doc');
    expect(skill?.skillMd).toBe('# Cached Skill\n');
    expect(skill?.referencesTar?.toString()).toBe('cached refs');
  });
});
