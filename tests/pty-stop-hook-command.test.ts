import { describe, expect, it } from 'vitest';
import { buildStopHookCommand } from '../src/engines/claude/pty/hook-bridge.js';

describe('buildStopHookCommand', () => {
  it('uses a command that exists on the host OS', () => {
    // `cat` is not available on Windows, where hooks run through cmd.
    expect(buildStopHookCommand('/tmp/x/stop.flag', 'linux')).toBe("cat > '/tmp/x/stop.flag'");
    expect(buildStopHookCommand('C:\\Temp\\stop.flag', 'win32')).toContain('powershell.exe');
    expect(buildStopHookCommand('C:\\Temp\\stop.flag', 'win32')).not.toContain('cat >');
  });

  it('quotes the sentinel path so spaces and metacharacters survive', () => {
    expect(buildStopHookCommand('/tmp/my dir/stop.flag', 'linux')).toBe("cat > '/tmp/my dir/stop.flag'");
    expect(buildStopHookCommand('C:\\Temp Folder\\stop.flag', 'win32')).toContain(
      "Set-Content -LiteralPath 'C:\\Temp Folder\\stop.flag'",
    );
  });

  it('escapes a single quote in the path for each shell', () => {
    // POSIX: close the quoted string, emit an escaped quote, reopen it.
    expect(buildStopHookCommand("/tmp/it's/stop.flag", 'linux')).toBe(
      `cat > '/tmp/it'"'"'s/stop.flag'`,
    );
    // PowerShell: a single quote is escaped by doubling it.
    expect(buildStopHookCommand("C:\\it's\\stop.flag", 'win32')).toContain(
      "Set-Content -LiteralPath 'C:\\it''s\\stop.flag'",
    );
  });

  it('defaults to the host platform', () => {
    const expected = process.platform === 'win32' ? 'powershell.exe' : 'cat >';
    expect(buildStopHookCommand('/tmp/stop.flag')).toContain(expected);
  });
});
