import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { resolveClaudePath } from '../src/engines/claude/resolve-claude.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const execSyncMock = vi.mocked(execSync);

describe('resolveClaudePath', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CLAUDE_EXECUTABLE_PATH;
    execSyncMock.mockReset();
  });

  it('returns the explicit CLAUDE_EXECUTABLE_PATH without searching PATH', () => {
    process.env.CLAUDE_EXECUTABLE_PATH = 'C:/custom/claude.exe';
    expect(resolveClaudePath({ platform: 'win32' })).toBe('C:/custom/claude.exe');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('prefers claude.exe over the extensionless npm shim on Windows', () => {
    execSyncMock.mockReturnValue(
      'C:/npm/claude\nC:/npm/claude.cmd\nC:/Users/u/.local/bin/claude.exe\n' as never,
    );
    expect(resolveClaudePath({ platform: 'win32' })).toBe('C:/Users/u/.local/bin/claude.exe');
  });

  it('falls back to claude.cmd when no claude.exe exists on Windows', () => {
    execSyncMock.mockReturnValue('C:/npm/claude\nC:/npm/claude.cmd\n' as never);
    expect(resolveClaudePath({ platform: 'win32' })).toBe('C:/npm/claude.cmd');
  });

  it('keeps PATH order as the last resort on Windows', () => {
    execSyncMock.mockReturnValue('C:/npm/claude\n' as never);
    expect(resolveClaudePath({ platform: 'win32' })).toBe('C:/npm/claude');
  });

  it('keeps PATH order on non-Windows platforms', () => {
    execSyncMock.mockReturnValue('/usr/local/bin/claude\n/opt/homebrew/bin/claude\n' as never);
    expect(resolveClaudePath({ platform: 'darwin' })).toBe('/usr/local/bin/claude');
  });

  it('falls back per platform when the lookup fails', () => {
    execSyncMock.mockImplementation(() => { throw new Error('not found'); });
    expect(resolveClaudePath({ platform: 'win32' })).toBe('claude');
    expect(resolveClaudePath({ platform: 'darwin' })).toBe('/usr/local/bin/claude');
  });
});
