import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTransientDownload } from '../src/bridge/message-bridge.js';

describe('isTransientDownload', () => {
  it('marks files under the system temp dir as transient', () => {
    expect(isTransientDownload(path.join(os.tmpdir(), 'metabot-dl', 'photo.png'))).toBe(true);
  });

  it('keeps files downloaded into a persistent project directory', () => {
    const persistent = path.join(os.homedir(), 'projects', 'mybot', 'inputs', 'report.pdf');
    expect(isTransientDownload(persistent)).toBe(false);
  });

  it('does not match sibling paths that merely share the temp dir string prefix', () => {
    expect(isTransientDownload(`${os.tmpdir()}-extra${path.sep}file.txt`)).toBe(false);
  });
});
