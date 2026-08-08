import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexArgs,
  buildCodexSpawnCommand,
  resolveCodexModelMetadata,
} from '../src/engines/codex/executor.js';
import type { CodexBotConfig } from '../src/config.js';

describe('buildCodexArgs', () => {
  const cwd = '/work/proj';
  const prompt = 'run pwd';

  it('defaults approval policy to "never" and sandbox to "danger-full-access"', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined);
    expect(args).toEqual([
      '-a', 'never',
      '--sandbox', 'danger-full-access',
      '-C', cwd,
      'exec', '--json', '--color', 'never', '--skip-git-repo-check', prompt,
    ]);
  });

  it('honors explicit approvalPolicy and sandbox', () => {
    const cfg: CodexBotConfig = { approvalPolicy: 'on-failure', sandbox: 'read-only' };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    expect(args.slice(0, 4)).toEqual(['-a', 'on-failure', '--sandbox', 'read-only']);
  });

  it('replaces policy/sandbox flags when dangerouslyBypassApprovalsAndSandbox is set', () => {
    const cfg: CodexBotConfig = {
      dangerouslyBypassApprovalsAndSandbox: true,
      approvalPolicy: 'on-failure',
      sandbox: 'read-only',
    };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    expect(args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('-a');
    expect(args).not.toContain('--sandbox');
  });

  it('passes model and profile when provided', () => {
    const cfg: CodexBotConfig = { profile: 'staging' };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, 'gpt-5.4-codex');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.4-codex');
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('staging');
  });

  it('appends extraArgs verbatim between global flags and the exec subcommand', () => {
    const cfg: CodexBotConfig = { extraArgs: ['--foo', 'bar baz', '--qux'] };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    const execIdx = args.indexOf('exec');
    expect(args.slice(execIdx - 3, execIdx)).toEqual(['--foo', 'bar baz', '--qux']);
  });

  it('uses `exec resume <sessionId>` when a session id is provided', () => {
    const args = buildCodexArgs({}, cwd, prompt, 'sess-abc', undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', 'sess-abc', prompt]);
    // resume path does NOT pass --color never (Codex resume subcommand differs)
    expect(tail).not.toContain('--color');
  });

  it('passes `--color never` for fresh executions (no session id)', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', '--json', '--color', 'never', '--skip-git-repo-check', prompt]);
  });

  it('keeps prompt as a single argv entry even with whitespace / metacharacters', () => {
    // spawn() receives argv as an array, so shell metacharacters are safe.
    const evil = 'ignore; rm -rf /\n`whoami`';
    const args = buildCodexArgs({}, cwd, evil, undefined, undefined);
    expect(args[args.length - 1]).toBe(evil);
  });

  it('infers Codex display model and context from CODEX_HOME files', () => {
    const priorCodexHome = process.env.CODEX_HOME;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-'));
    try {
      process.env.CODEX_HOME = dir;
      writeFileSync(join(dir, 'config.toml'), 'model = "gpt-test"\n');
      writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({
        models: [
          { slug: 'gpt-test', context_window: 123456 },
          { slug: 'gpt-other', context_window: 999 },
        ],
      }));

      expect(resolveCodexModelMetadata({})).toEqual({
        model: 'gpt-test',
        contextWindow: 123456,
      });
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildCodexSpawnCommand', () => {
  const args = ['exec', '--json', 'prompt with spaces & "quotes"'];

  it('runs the npm Codex wrapper through Node when codex.js exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-codex-wrapper-'));
    try {
      const codexScript = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
      writeFileSync(codexScript, '');

      expect(buildCodexSpawnCommand(join(dir, 'codex.cmd'), args, 'win32')).toEqual({
        command: process.execPath,
        args: [codexScript, ...args],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects other Windows command wrappers', () => {
    expect(() => buildCodexSpawnCommand(
      'C:\\tools\\custom-codex.cmd',
      args,
      'win32',
    )).toThrow('Codex executable must be a native executable on Windows');
  });

  it('runs Windows native executables directly', () => {
    expect(buildCodexSpawnCommand('C:\\tools\\codex.exe', args, 'win32')).toEqual({
      command: 'C:\\tools\\codex.exe',
      args,
    });
  });

  it('leaves non-Windows commands unchanged', () => {
    expect(buildCodexSpawnCommand('/usr/local/bin/codex', args, 'linux')).toEqual({
      command: '/usr/local/bin/codex',
      args,
    });
  });

  it('rejects a Codex wrapper when its npm entrypoint is missing', () => {
    expect(() => buildCodexSpawnCommand('codex.cmd', args, 'win32')).toThrow(
      'Unable to resolve Codex npm entrypoint',
    );
  });
});
