import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../src/engines/codex/executor.js';
import type { CodexBotConfig } from '../src/config.js';

describe('buildCodexArgs', () => {
  const cwd = '/work/proj';
  const prompt = 'run pwd';

  it('defaults approval policy to "never" and sandbox to "workspace-write"', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined);
    expect(args).toEqual([
      '-a', 'never',
      '--sandbox', 'workspace-write',
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
});
