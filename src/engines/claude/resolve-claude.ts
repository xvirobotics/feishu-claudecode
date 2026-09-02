import { execSync } from 'node:child_process';

export interface ResolveClaudePathOptions {
  /** Override for tests; defaults to the current process platform. */
  platform?: NodeJS.Platform;
}

/**
 * Resolve the Claude Code executable path.
 *
 * On Windows, PATH order may put npm's extensionless POSIX shim before the
 * real launchers (claude.exe / claude.cmd). node-pty cannot exec the shim
 * directly (CreateProcess error 193), so prefer native executables by suffix
 * regardless of PATH order. An explicit CLAUDE_EXECUTABLE_PATH always wins.
 */
export function resolveClaudePath(options: ResolveClaudePathOptions = {}): string {
  if (process.env.CLAUDE_EXECUTABLE_PATH) return process.env.CLAUDE_EXECUTABLE_PATH;

  const isWindows = (options.platform ?? process.platform) === 'win32';
  const command = isWindows ? 'where claude' : 'which claude';
  try {
    const candidates = execSync(command, { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

    if (isWindows) {
      const nativeExecutable = candidates.find((candidate) => candidate.toLowerCase().endsWith('.exe'))
        ?? candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate));
      if (nativeExecutable) return nativeExecutable;
    }

    return candidates[0] ?? fallbackExecutable(isWindows);
  } catch {
    return fallbackExecutable(isWindows);
  }
}

function fallbackExecutable(isWindows: boolean): string {
  return isWindows ? 'claude' : '/usr/local/bin/claude';
}
