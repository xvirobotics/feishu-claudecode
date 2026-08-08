import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, DEFAULT_URL } from '../src/config.js';
import { request } from '../src/client.js';
import {
  parseArgs,
  cmdInstall,
  cmdPublish,
  defaultInstallDir,
  targetsEngineAutoloadDir,
} from '../src/commands.js';

describe('parseArgs', () => {
  it('handles --to flag value', () => {
    const a = parseArgs(['my-skill', '--to', '/tmp/x']);
    expect(a.positional).toEqual(['my-skill']);
    expect(a.flags.to).toBe('/tmp/x');
  });
});

describe('loadConfig', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cfg-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('uses env vars when set', () => {
    const cfg = loadConfig({ METABOT_CORE_URL: 'http://example/', METABOT_CORE_TOKEN: 'tok1' });
    expect(cfg.url).toBe('http://example');
    expect(cfg.token).toBe('tok1');
  });
  it('reads token from ~/.metabot-core/token', () => {
    fs.mkdirSync(path.join(tmpHome, '.metabot-core'));
    fs.writeFileSync(path.join(tmpHome, '.metabot-core', 'token'), 'file-tok\n');
    const cfg = loadConfig({});
    expect(cfg.url).toBe(DEFAULT_URL);
    expect(cfg.token).toBe('file-tok');
  });
});

describe('request', () => {
  it('sends Authorization bearer + parses JSON response', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const body = await request(
      { url: 'http://ex', token: 'tok' },
      { path: '/api/skills' },
      fakeFetch,
    );
    expect(body).toEqual({ skills: [] });
    expect(captured.url).toBe('http://ex/api/skills');
    expect((captured.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});

describe('cmdInstall', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-install-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes SKILL.md to <to>/SKILL.md', async () => {
    const skillMd = '---\nname: foo\n---\n# hi\n';
    const cfg = { url: 'http://ex', token: 't' };
    // Override global fetch for this test.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: 'foo', version: 1, skillMd }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const stdoutSpy: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
        stdoutSpy.push(s);
        return true;
      };
      try {
        await cmdInstall(cfg, { positional: ['foo'], flags: { to: tmp } });
      } finally {
        process.stdout.write = origWrite;
      }
      const dst = path.join(tmp, 'SKILL.md');
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.readFileSync(dst, 'utf8')).toBe(skillMd);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('defaults to a non-engine review directory', () => {
    expect(defaultInstallDir('foo')).toBe(path.join('.metabot', 'skills', 'foo'));
    expect(targetsEngineAutoloadDir(defaultInstallDir('foo'))).toBe(false);
  });

  it('refuses to install into engine auto-load directories without --trust', async () => {
    const cfg = { url: 'http://ex', token: 't' };
    await expect(cmdInstall(cfg, { positional: ['foo'], flags: { to: path.join(tmp, '.claude', 'skills', 'foo') } }))
      .rejects.toThrow('without --trust');
  });

  it('allows engine auto-load install when --trust is explicit', async () => {
    const skillMd = '---\nname: foo\n---\n# hi\n';
    const cfg = { url: 'http://ex', token: 't' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: 'foo', version: 1, skillMd }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const stdoutSpy: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
        stdoutSpy.push(s);
        return true;
      };
      try {
        const to = path.join(tmp, '.claude', 'skills', 'foo');
        await cmdInstall(cfg, { positional: ['foo'], flags: { to, trust: true } });
        expect(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8')).toBe(skillMd);
      } finally {
        process.stdout.write = origWrite;
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('cmdPublish', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-publish-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads SKILL.md from --from <dir>', async () => {
    fs.writeFileSync(path.join(tmp, 'SKILL.md'), '# hello\n');
    let captured: { body?: string } = {};
    const cfg = { url: 'http://ex', token: 't' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      captured.body = init.body as string;
      return new Response(JSON.stringify({ name: 'x', version: 1, published: true }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    try {
      const stdoutSpy: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
        stdoutSpy.push(s);
        return true;
      };
      try {
        await cmdPublish(cfg, { positional: ['x'], flags: { from: tmp } });
      } finally {
        process.stdout.write = origWrite;
      }
      const parsed = JSON.parse(captured.body!);
      expect(parsed.skillMd).toBe('# hello\n');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
