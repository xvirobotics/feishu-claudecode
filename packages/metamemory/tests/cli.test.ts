import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, DEFAULT_URL } from '../src/config.js';
import { request } from '../src/client.js';
import { parseArgs, resolveContentTypeFlag, resolveShareFlag, cmdCreate, cmdMkdir, cmdVisibility, defaultWritePrefix } from '../src/commands.js';

describe('parseArgs', () => {
  it('splits positional and flags', () => {
    const a = parseArgs(['hello', '--folder', 'f1', '--tags', 'a,b', 'world']);
    expect(a.positional).toEqual(['hello', 'world']);
    expect(a.flags).toEqual({ folder: 'f1', tags: 'a,b' });
  });
  it('handles --flag=value', () => {
    const a = parseArgs(['--limit=50', 'q']);
    expect(a.flags.limit).toBe('50');
    expect(a.positional).toEqual(['q']);
  });
  it('handles boolean flag at end', () => {
    const a = parseArgs(['x', '--dry']);
    expect(a.flags.dry).toBe(true);
  });
});

describe('loadConfig', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-'));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('uses env vars when set', () => {
    const cfg = loadConfig({ METABOT_CORE_URL: 'http://example/', METABOT_CORE_TOKEN: 'tok1' });
    expect(cfg.url).toBe('http://example');
    expect(cfg.token).toBe('tok1');
  });

  it('defaults URL and reads token from ~/.metabot-core/token', () => {
    fs.mkdirSync(path.join(tmpHome, '.metabot-core'));
    fs.writeFileSync(path.join(tmpHome, '.metabot-core', 'token'), 'file-tok\n');
    const cfg = loadConfig({});
    expect(cfg.url).toBe(DEFAULT_URL);
    expect(cfg.token).toBe('file-tok');
  });

  it('throws when no token configured', () => {
    expect(() => loadConfig({})).toThrow(/no token configured/);
  });
});

describe('resolveContentTypeFlag', () => {
  it('returns undefined when neither flag is set', () => {
    expect(resolveContentTypeFlag({})).toBeUndefined();
  });
  it('--html maps to text/html', () => {
    expect(resolveContentTypeFlag({ html: true })).toBe('text/html');
  });
  it('--content-type text/html passes through', () => {
    expect(resolveContentTypeFlag({ 'content-type': 'text/html' })).toBe('text/html');
  });
  it('--content-type text/markdown passes through', () => {
    expect(resolveContentTypeFlag({ 'content-type': 'text/markdown' })).toBe('text/markdown');
  });
  it('--html and --content-type together → exit 2', () => {
    try {
      resolveContentTypeFlag({ html: true, 'content-type': 'text/html' });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as Error & { exitCode?: number };
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/mutually exclusive/);
    }
  });
  it('unknown --content-type → exit 2', () => {
    try {
      resolveContentTypeFlag({ 'content-type': 'application/pdf' });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as Error & { exitCode?: number };
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/unsupported content_type/);
    }
  });
  it('--content-type without a value → exit 2', () => {
    try {
      resolveContentTypeFlag({ 'content-type': true });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const err = e as Error & { exitCode?: number };
      expect(err.exitCode).toBe(2);
    }
  });
});

describe('request', () => {
  it('sends Authorization bearer + json body, returns parsed JSON', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const body = await request(
      { url: 'http://example', token: 'tok' },
      { method: 'POST', path: '/api/memory/documents', body: { title: 'hi' } },
      fakeFetch,
    );
    expect(body).toEqual({ ok: true });
    expect(captured.url).toBe('http://example/api/memory/documents');
    expect((captured.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((captured.init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(captured.init!.method).toBe('POST');
    expect(captured.init!.body).toBe(JSON.stringify({ title: 'hi' }));
  });

  it('throws on non-2xx with status + body attached', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })) as unknown as typeof fetch;
    await expect(
      request({ url: 'http://x', token: 't' }, { path: '/api/memory/documents/xx' }, fakeFetch),
    ).rejects.toThrow(/404.*not_found/);
  });

  it('appends query string', async () => {
    let captured = '';
    const fakeFetch = (async (url: string) => {
      captured = url;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await request(
      { url: 'http://x', token: 't' },
      { path: '/api/memory/search', query: { q: 'hello', limit: 5 } },
      fakeFetch,
    );
    expect(captured).toBe('http://x/api/memory/search?q=hello&limit=5');
  });

  it('memory search forwards --offset', async () => {
    let captured = '';
    const fakeFetch = (async (url: string) => {
      captured = url;
      return new Response('{"results":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fakeFetch);
    const { cmdSearch } = await import('../src/commands.js');
    await cmdSearch({ url: 'http://x', token: 't' }, { positional: ['hello'], flags: { limit: '5', offset: '10' } });
    expect(captured).toBe('http://x/api/memory/search?q=hello&limit=5&offset=10');
  });
});

describe('cmdCreate / cmdMkdir — write target', () => {
  const cfg = { url: 'http://x', token: 't' };

  interface Call {
    url: string;
    init: RequestInit;
  }

  /**
   * Stub global fetch. `whoami` controls the GET /api/whoami response;
   * every other call is recorded and answered with a 201.
   *
   * `ownerName` defaults to `botName` (user-kind whoami — like SSO / self-
   * service web tokens) so existing pre-self-namespace expectations remain
   * meaningful. Pass an explicit ownerName for agent-kind cases.
   */
  function stubFetch(whoami?: {
    botName: string;
    role: string;
    ownerName?: string;
    memoryPublic?: boolean;
  }): Call[] {
    const calls: Call[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/whoami')) {
        const w = whoami ?? { botName: 'bot-x', role: 'member' };
        const body = { ownerName: w.botName, ...w };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fake);
    return calls;
  }

  function bodyOf(call: Call): Record<string, unknown> {
    return JSON.parse(call.init.body as string);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('create: --path is passed through verbatim, no whoami call', async () => {
    const calls = stubFetch();
    await cmdCreate(cfg, parseArgs(['My Doc', 'hello', '--path', '/users/bot-x/my-doc']));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(false);
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).path).toBe('/users/bot-x/my-doc');
    expect(bodyOf(post).folder_id).toBeUndefined();
  });

  it('create: --folder still works, no path, no whoami call', async () => {
    const calls = stubFetch();
    await cmdCreate(cfg, parseArgs(['My Doc', 'hello', '--folder', 'fld-1']));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(false);
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).folder_id).toBe('fld-1');
    expect(bodyOf(post).path).toBeUndefined();
  });

  it('create: bare invocation by a member defaults into its own /users/<bot> namespace', async () => {
    // user-kind stub (ownerName defaults to botName) → /users/<bot>
    const calls = stubFetch({ botName: 'bot-x', role: 'member' });
    await cmdCreate(cfg, parseArgs(['Smoke Test CLI', 'hello']));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(true);
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).path).toBe('/users/bot-x/smoke-test-cli');
  });

  it('create: bare invocation by an admin keeps the root default (no path)', async () => {
    const calls = stubFetch({ botName: 'admin-bot', role: 'admin' });
    await cmdCreate(cfg, parseArgs(['Smoke Test CLI', 'hello']));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(true);
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).path).toBeUndefined();
  });

  it('mkdir: --path is passed through verbatim, no whoami call', async () => {
    const calls = stubFetch();
    await cmdMkdir(cfg, parseArgs(['smoke-folder', '--path', '/users/bot-x/smoke-folder']));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(false);
    const post = calls.find((c) => c.url.endsWith('/api/memory/folders'))!;
    expect(bodyOf(post).path).toBe('/users/bot-x/smoke-folder');
  });

  it('mkdir: parent_id form still works, no whoami call', async () => {
    const calls = stubFetch();
    await cmdMkdir(cfg, parseArgs(['smoke-folder', 'parent-1']));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(false);
    const post = calls.find((c) => c.url.endsWith('/api/memory/folders'))!;
    expect(bodyOf(post).parent_id).toBe('parent-1');
    expect(bodyOf(post).path).toBeUndefined();
  });

  it('mkdir: bare invocation by a member defaults into its own /users/<bot> namespace', async () => {
    const calls = stubFetch({ botName: 'bot-x', role: 'member' });
    await cmdMkdir(cfg, parseArgs(['smoke-folder']));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(true);
    const post = calls.find((c) => c.url.endsWith('/api/memory/folders'))!;
    expect(bodyOf(post).path).toBe('/users/bot-x/smoke-folder');
  });

  it('mkdir: bare invocation by an admin keeps the root default (no path)', async () => {
    const calls = stubFetch({ botName: 'admin-bot', role: 'admin' });
    await cmdMkdir(cfg, parseArgs(['smoke-folder']));
    const post = calls.find((c) => c.url.endsWith('/api/memory/folders'))!;
    expect(bodyOf(post).path).toBeUndefined();
  });

  // ---- write target is always the self namespace (independent of memoryPublic) ----
  it('create: user-kind member → /users/<ownerName>', async () => {
    // user-kind: botName === ownerName (SSO / self-service web token)
    const calls = stubFetch({ botName: 'alice@xvi.com', ownerName: 'alice@xvi.com', role: 'member' });
    await cmdCreate(cfg, parseArgs(['Private Note', 'hello']));
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).path).toBe('/users/alice@xvi.com/private-note');
  });

  it('create: agent-kind member → /users/<owner>/agents/<bot>', async () => {
    // agent-kind: botName !== ownerName (bot token issued via `metabot agents create`)
    const calls = stubFetch({ botName: 'cli-bot', ownerName: 'alice', role: 'member' });
    await cmdCreate(cfg, parseArgs(['Private Note', 'hello']));
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).path).toBe('/users/alice/agents/cli-bot/private-note');
  });

  it('mkdir: agent-kind member → /users/<owner>/agents/<bot>', async () => {
    const calls = stubFetch({ botName: 'cli-bot', ownerName: 'alice', role: 'member' });
    await cmdMkdir(cfg, parseArgs(['private-folder']));
    const post = calls.find((c) => c.url.endsWith('/api/memory/folders'))!;
    expect(bodyOf(post).path).toBe('/users/alice/agents/cli-bot/private-folder');
  });

  it('create: memoryPublic no longer changes the write path (still self namespace)', async () => {
    const calls = stubFetch({ botName: 'bot-x', ownerName: 'alice', role: 'member', memoryPublic: true });
    await cmdCreate(cfg, parseArgs(['Public Note', 'hello']));
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).path).toBe('/users/alice/agents/bot-x/public-note');
  });

  it('create: --share / --no-share forwards the shared flag in the body', async () => {
    const shareCalls = stubFetch();
    await cmdCreate(cfg, parseArgs(['Doc', 'hi', '--path', '/users/bot-x/d', '--share']));
    expect(bodyOf(shareCalls.find((c) => c.url.endsWith('/api/memory/documents'))!).shared).toBe(true);
    vi.unstubAllGlobals();
    const noShareCalls = stubFetch();
    await cmdCreate(cfg, parseArgs(['Doc', 'hi', '--path', '/users/bot-x/d', '--no-share']));
    expect(bodyOf(noShareCalls.find((c) => c.url.endsWith('/api/memory/documents'))!).shared).toBe(false);
  });

  it('create: no share flag → shared omitted (server defaults from agent config)', async () => {
    const calls = stubFetch();
    await cmdCreate(cfg, parseArgs(['Doc', 'hi', '--path', '/users/bot-x/d']));
    expect(bodyOf(calls.find((c) => c.url.endsWith('/api/memory/documents'))!).shared).toBeUndefined();
  });

  it('create: --path still wins as the explicit write target', async () => {
    const calls = stubFetch({ botName: 'bot-x', ownerName: 'alice', role: 'member' });
    await cmdCreate(cfg, parseArgs(['Override', 'hello', '--path', '/users/bot-x/forced']));
    // whoami call shouldn't happen at all when --path is set
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(false);
    const post = calls.find((c) => c.url.endsWith('/api/memory/documents'))!;
    expect(bodyOf(post).path).toBe('/users/bot-x/forced');
  });
});

describe('resolveShareFlag — pure helper', () => {
  it('neither flag → undefined (server defaults from agent config)', () => {
    expect(resolveShareFlag({})).toBeUndefined();
  });
  it('--share → true', () => {
    expect(resolveShareFlag({ share: true })).toBe(true);
  });
  it('--no-share → false', () => {
    expect(resolveShareFlag({ 'no-share': true })).toBe(false);
  });
  it('both → throws exit 2', () => {
    let caught: (Error & { exitCode?: number }) | undefined;
    try { resolveShareFlag({ share: true, 'no-share': true }); } catch (e) { caught = e as Error & { exitCode?: number }; }
    expect(caught?.exitCode).toBe(2);
  });
});

describe('defaultWritePrefix — pure helper', () => {
  it('admin → undefined (root default preserved)', () => {
    expect(defaultWritePrefix({ botName: 'a', ownerName: '', role: 'admin' })).toBeUndefined();
  });
  it('member, user-kind (botName === ownerName) → /users/<ownerName>, regardless of memoryPublic', () => {
    // SSO / self-service web token: cred.botName === cred.ownerName === email
    expect(defaultWritePrefix({
      botName: 'alice@xvi.com', ownerName: 'alice@xvi.com', role: 'member',
    })).toBe('/users/alice@xvi.com');
    expect(defaultWritePrefix({
      botName: 'alice@xvi.com', ownerName: 'alice@xvi.com', role: 'member', memoryPublic: true,
    })).toBe('/users/alice@xvi.com');
  });
  it('member, agent-kind (botName !== ownerName) → /users/<owner>/agents/<bot>, regardless of memoryPublic', () => {
    // Bot token issued via `metabot agents create`
    expect(defaultWritePrefix({
      botName: 'cli-bot', ownerName: 'alice', role: 'member',
    })).toBe('/users/alice/agents/cli-bot');
    expect(defaultWritePrefix({
      botName: 'cli-bot', ownerName: 'alice', role: 'member', memoryPublic: true,
    })).toBe('/users/alice/agents/cli-bot');
  });
});

describe('cmdVisibility — read + toggle', () => {
  const cfg = { url: 'http://x', token: 't' };

  interface Call { url: string; init: RequestInit }

  function stubFetch(whoami: { botName: string; role: string; memoryPublic?: boolean }, patchBody?: unknown): Call[] {
    const calls: Call[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/whoami')) {
        return new Response(JSON.stringify(whoami), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(patchBody ?? { ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fake);
    return calls;
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('no argument: prints current state, no PATCH', async () => {
    const calls = stubFetch({ botName: 'bot-x', role: 'member', memoryPublic: true });
    await cmdVisibility(cfg, parseArgs([]));
    expect(calls.some((c) => c.url.endsWith('/api/whoami'))).toBe(true);
    expect(calls.some((c) => (c.init.method || 'GET') === 'PATCH')).toBe(false);
  });

  it('public: PATCHes /api/agents/<bot>/memory-visibility with memoryPublic:true', async () => {
    const calls = stubFetch({ botName: 'bot-x', role: 'member' });
    await cmdVisibility(cfg, parseArgs(['public']));
    const patch = calls.find((c) => (c.init.method === 'PATCH') && c.url.includes('/memory-visibility'));
    expect(patch).toBeDefined();
    expect(patch!.url).toContain('/api/agents/bot-x/memory-visibility');
    expect(JSON.parse(patch!.init.body as string)).toEqual({ memoryPublic: true });
  });

  it('private: PATCHes with memoryPublic:false', async () => {
    const calls = stubFetch({ botName: 'bot-x', role: 'member' });
    await cmdVisibility(cfg, parseArgs(['private']));
    const patch = calls.find((c) => (c.init.method === 'PATCH') && c.url.includes('/memory-visibility'));
    expect(JSON.parse(patch!.init.body as string)).toEqual({ memoryPublic: false });
  });

  it('bogus argument: throws with exitCode 2, no PATCH', async () => {
    stubFetch({ botName: 'bot-x', role: 'member' });
    await expect(cmdVisibility(cfg, parseArgs(['maybe'])))
      .rejects.toMatchObject({ message: /expected 'public' or 'private'/, exitCode: 2 });
  });
});
