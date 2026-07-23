import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf-8');

describe('PowerShell Git Bash wrapper contracts', () => {
  it('resolves Git Bash from the Git for Windows installation', () => {
    expect(SOURCE).toContain('function Resolve-GitBashPath');
    expect(SOURCE).toContain('Get-Command git -CommandType Application');
    expect(SOURCE).toContain('"bin\\bash.exe", "usr\\bin\\bash.exe"');
    expect(SOURCE).not.toContain('$HasBash = Test-Command "bash"');
  });

  it('rejects the System32 WSL launcher', () => {
    expect(SOURCE).toContain('function Test-GitBashPath');
    expect(SOURCE).toContain('Join-Path $env:WINDIR "System32"');
    expect(SOURCE).toContain('The WSL/System32 bash launcher is not compatible');
  });

  it('quotes the absolute Bash and script paths in the cmd wrapper', () => {
    expect(SOURCE).toContain('$cmdContent = "@`"$GitBashPath`" `"%~dp0$cli`" %*"');
    expect(SOURCE).not.toContain('$cmdContent = "@bash');
  });
});
