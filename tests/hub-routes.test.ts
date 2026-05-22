import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type * as http from 'node:http';
import * as os from 'node:os';
import { signSession } from '../src/feishu/oauth.js';
import type { BotJsonEntry } from '../src/manager/bots-config.js';
import type { Pm2ProcInfo } from '../src/manager/pm2-control.js';
import type { SessionMapping } from '../src/manager/session-control.js';

const TEST_SECRET = 'test-secret-for-hub-routes-12345678';

// ─── module mocks ───────────────────────────────────────────────────────────
// We mock the data sources rather than the Hub module itself so route logic
// (auth gating, hubVisible filter, hostId mismatch → 404) runs unmodified.

let mockFeishuBots: BotJsonEntry[] = [];
let mockPm2:        Pm2ProcInfo[]  = [];
let mockSessions:   Record<string, SessionMapping[]> = {};

vi.mock('../src/manager/bots-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/manager/bots-config.js')>('../src/manager/bots-config.js');
  return {
    ...actual,
    loadBotsJson: () => ({ raw: { feishuBots: mockFeishuBots }, feishuBots: mockFeishuBots }),
  };
});

vi.mock('../src/manager/pm2-control.js', async () => {
  const actual = await vi.importActual<typeof import('../src/manager/pm2-control.js')>('../src/manager/pm2-control.js');
  return {
    ...actual,
    listPm2: vi.fn(async () => mockPm2),
  };
});

vi.mock('../src/manager/session-control.js', async () => {
  const actual = await vi.importActual<typeof import('../src/manager/session-control.js')>('../src/manager/session-control.js');
  return {
    ...actual,
    listSessions: (botName: string) => mockSessions[botName] || [],
  };
});

// Import AFTER mocks so the module sees the mocked dependencies.
const { handleHubRoutes } = await import('../src/manager/routes/hub.js');

// ─── helpers ────────────────────────────────────────────────────────────────

interface CapturedResponse {
  status:  number;
  body:    unknown;
  headers: Record<string, string | number | string[]>;
}

function makeReqRes(method: string, url: string, cookies?: Record<string, string>): {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  captured: CapturedResponse;
} {
  const cookie = cookies
    ? Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : undefined;
  const req = { method, url, headers: cookie ? { cookie } : {} } as unknown as http.IncomingMessage;
  const captured: CapturedResponse = { status: 0, body: undefined, headers: {} };
  let bodyBuf = '';
  const res = {
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      captured.status  = status;
      captured.headers = headers || {};
    },
    end(data?: string) {
      if (data) bodyBuf += data;
      try { captured.body = JSON.parse(bodyBuf); } catch { captured.body = bodyBuf; }
    },
  } as unknown as http.ServerResponse;
  return { req, res, captured };
}

function makeBot(overrides: Partial<BotJsonEntry> = {}): BotJsonEntry {
  return {
    name:                    overrides.name || 'WR',
    feishuAppId:             'cli_test',
    feishuAppSecret:         'secret',
    defaultWorkingDirectory: '/tmp/wr',
    ...overrides,
  };
}

function validSessionCookie(openId: string): Record<string, string> {
  return { mb_session: encodeURIComponent(signSession({ open_id: openId, name: 'Owner' })) };
}

beforeAll(() => {
  process.env.METABOT_SESSION_SECRET = TEST_SECRET;
});

beforeEach(() => {
  mockFeishuBots = [];
  mockPm2        = [];
  mockSessions   = {};
});

// ─── tests ─────────────────────────────────────────────────────────────────

describe('handleHubRoutes', () => {
  it('returns false for non-/api/hub/ URLs (caller falls through)', async () => {
    const { req, res } = makeReqRes('GET', '/api/manager/bots');
    const handled = await handleHubRoutes(req, res, 'GET', '/api/manager/bots');
    expect(handled).toBe(false);
  });

  it('GET /api/hub/hosts returns 401 + loginUrl when no cookie present', async () => {
    mockFeishuBots = [makeBot({ name: 'WR', hubVisible: true, accessAllowOpenIds: ['ou_owner'] })];
    const { req, res, captured } = makeReqRes('GET', '/api/hub/hosts');
    const handled = await handleHubRoutes(req, res, 'GET', '/api/hub/hosts');
    expect(handled).toBe(true);
    expect(captured.status).toBe(401);
    expect((captured.body as { loginUrl?: string }).loginUrl).toContain('/api/auth/feishu/login');
    expect((captured.body as { loginUrl?: string }).loginUrl).toContain('bot=WR');
  });

  it('GET /api/hub/hosts returns 403 when cookie ok but open_id not in any whitelist', async () => {
    mockFeishuBots = [makeBot({ name: 'WR', hubVisible: true, accessAllowOpenIds: ['ou_other'] })];
    const { req, res, captured } = makeReqRes('GET', '/api/hub/hosts', validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/hosts');
    expect(captured.status).toBe(403);
  });

  it('GET /api/hub/hosts returns 200 with a single host when cookie + whitelist match', async () => {
    mockFeishuBots = [
      makeBot({ name: 'WR', hubVisible: true,  accessAllowOpenIds: ['ou_owner'], publicBaseUrl: 'https://wr.example.com/' }),
      makeBot({ name: 'PA', hubVisible: false, accessAllowOpenIds: ['ou_owner'] }),
    ];
    mockPm2 = [{ name: 'WR', status: 'online', uptimeMs: 1000, cpu: 0.1, memoryBytes: 200 * 1024 * 1024, restarts: 0, env: {} }];
    mockSessions = { WR: [{ chatId: 'oc_1', title: 'hello' }] };

    const { req, res, captured } = makeReqRes('GET', '/api/hub/hosts', validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/hosts');
    expect(captured.status).toBe(200);
    const body = captured.body as { hosts: Array<{ hostId: string; visibleBots: Array<{ name: string; transcriptBaseUrl?: string; sessions?: number }>; hiddenBotCount: number }> };
    expect(body.hosts.length).toBe(1);
    expect(body.hosts[0].hostId).toBe(os.hostname().toLowerCase());
    expect(body.hosts[0].visibleBots.length).toBe(1);
    expect(body.hosts[0].visibleBots[0].name).toBe('WR');
    expect(body.hosts[0].visibleBots[0].transcriptBaseUrl).toBe('https://wr.example.com');
    expect(body.hosts[0].visibleBots[0].sessions).toBe(1);
    expect(body.hosts[0].hiddenBotCount).toBe(1);
  });

  it('GET /api/hub/hosts/:hostId returns 404 when hostId does not match os.hostname()', async () => {
    mockFeishuBots = [makeBot({ name: 'WR', hubVisible: true, accessAllowOpenIds: ['ou_owner'] })];
    const { req, res, captured } = makeReqRes('GET', '/api/hub/hosts/not-this-host', validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/hosts/not-this-host');
    expect(captured.status).toBe(404);
  });

  it('GET /api/hub/hosts/:hostId returns 200 when hostId matches', async () => {
    mockFeishuBots = [makeBot({ name: 'WR', hubVisible: true, accessAllowOpenIds: ['ou_owner'] })];
    const realHostId = os.hostname().toLowerCase();
    const { req, res, captured } = makeReqRes('GET', `/api/hub/hosts/${realHostId}`, validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', `/api/hub/hosts/${realHostId}`);
    expect(captured.status).toBe(200);
    expect((captured.body as { host: { hostId: string } }).host.hostId).toBe(realHostId);
  });

  it('GET /api/hub/bots/:name/sessions returns 404 when bot is not hubVisible', async () => {
    mockFeishuBots = [makeBot({ name: 'WR', hubVisible: false, accessAllowOpenIds: ['ou_owner'] })];
    const { req, res, captured } = makeReqRes('GET', '/api/hub/bots/WR/sessions', validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/bots/WR/sessions');
    expect(captured.status).toBe(404);
  });

  it('GET /api/hub/bots/:name/sessions returns 404 when bot does not exist', async () => {
    mockFeishuBots = [];
    const { req, res, captured } = makeReqRes('GET', '/api/hub/bots/missing/sessions', validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/bots/missing/sessions');
    expect(captured.status).toBe(404);
  });

  it('GET /api/hub/bots/:name/sessions enforces the target bot allowlist (not the union)', async () => {
    mockFeishuBots = [
      // Hub OAuth driver — different owner.
      makeBot({ name: 'WR', hubVisible: true, accessAllowOpenIds: ['ou_alice'] }),
      // Target bot — different allowlist.
      makeBot({ name: 'PA', hubVisible: true, accessAllowOpenIds: ['ou_bob'] }),
    ];
    // Alice has Hub access but NOT PA — should be 403 on PA's sessions endpoint.
    const { req, res, captured } = makeReqRes('GET', '/api/hub/bots/PA/sessions', validSessionCookie('ou_alice'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/bots/PA/sessions');
    expect(captured.status).toBe(403);
  });

  it('GET /api/hub/bots/:name/sessions returns 200 with session list when allowed', async () => {
    mockFeishuBots = [makeBot({ name: 'WR', hubVisible: true, accessAllowOpenIds: ['ou_owner'] })];
    mockSessions = { WR: [{ chatId: 'oc_a', title: 'Test session', lastUsed: 1234 }] };
    const { req, res, captured } = makeReqRes('GET', '/api/hub/bots/WR/sessions', validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/bots/WR/sessions');
    expect(captured.status).toBe(200);
    const body = captured.body as { sessions: SessionMapping[] };
    expect(body.sessions).toEqual(mockSessions.WR);
  });

  it('GET /api/hub/hosts excludes sensitive fields from the response (feishuAppSecret/env)', async () => {
    mockFeishuBots = [makeBot({
      name:               'WR',
      hubVisible:         true,
      accessAllowOpenIds: ['ou_owner'],
      feishuAppSecret:    'super-secret',
      env:                { ANTHROPIC_AUTH_TOKEN: 'tok-abc' },
    })];
    const { req, res, captured } = makeReqRes('GET', '/api/hub/hosts', validSessionCookie('ou_owner'));
    await handleHubRoutes(req, res, 'GET', '/api/hub/hosts');
    expect(captured.status).toBe(200);
    const serialized = JSON.stringify(captured.body);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('tok-abc');
    const body = captured.body as { hosts: Array<{ visibleBots: Array<{ hiddenFields: string[] }> }> };
    expect(body.hosts[0].visibleBots[0].hiddenFields).toEqual(expect.arrayContaining(['feishuAppSecret', 'env']));
  });
});
