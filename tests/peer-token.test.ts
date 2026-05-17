import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPeerToken } from '../src/cluster/peer-token.js';

describe('loadPeerToken', () => {
  it('generates a 64-hex token and persists it under ~/.metabot/peer-token', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-peer-token-'));
    try {
      const { token, path: tokenPath } = loadPeerToken({ homeDir, env: {} as NodeJS.ProcessEnv });
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(tokenPath).toBe(path.join(homeDir, '.metabot', 'peer-token'));
      const onDisk = fs.readFileSync(tokenPath, 'utf-8').trim();
      expect(onDisk).toBe(token);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('is idempotent: reloading returns the same token', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-peer-token-idem-'));
    try {
      const a = loadPeerToken({ homeDir, env: {} as NodeJS.ProcessEnv });
      const b = loadPeerToken({ homeDir, env: {} as NodeJS.ProcessEnv });
      expect(b.token).toBe(a.token);
      expect(b.path).toBe(a.path);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('respects METABOT_PEER_TOKEN_PATH override', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-peer-token-env-'));
    try {
      const override = path.join(homeDir, 'custom', 'token');
      const { token, path: tokenPath } = loadPeerToken({
        homeDir,
        env: { METABOT_PEER_TOKEN_PATH: override } as NodeJS.ProcessEnv,
      });
      expect(tokenPath).toBe(override);
      expect(fs.readFileSync(override, 'utf-8').trim()).toBe(token);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('regenerates when the persisted file is corrupt', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-peer-token-corrupt-'));
    try {
      const tokenPath = path.join(homeDir, '.metabot', 'peer-token');
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, 'not a hex token\n');
      const { token } = loadPeerToken({ homeDir, env: {} as NodeJS.ProcessEnv });
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(token).not.toBe('not a hex token');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
