import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAppConfig } from '../src/config.js';

describe('cluster bootstrap config', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  function writeBotsConfig(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-config-test-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'bots.json');
    fs.writeFileSync(file, JSON.stringify({
      feishuBots: [{
        name: 'test-bot',
        feishuAppId: 'cli_test',
        feishuAppSecret: 'secret',
        defaultWorkingDirectory: dir,
      }],
    }));
    return file;
  }

  it('adds METABOT_CLUSTER_URL as a bootstrap peer', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-home-test-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    vi.stubEnv('BOTS_CONFIG', writeBotsConfig());
    vi.stubEnv('METABOT_HOME', home);
    vi.stubEnv('METABOT_CLUSTER_ID', 'team-lan');
    vi.stubEnv('METABOT_CLUSTER_URL', 'http://metabot.internal:9100/');
    vi.stubEnv('METABOT_CLUSTER_SECRET', 'cluster-secret');
    vi.stubEnv('METABOT_PEERS', '');

    const config = loadAppConfig();

    expect(config.peers).toContainEqual({
      name: 'team-lan',
      url: 'http://metabot.internal:9100',
      secret: 'cluster-secret',
    });
  });

  it('does not add cluster URL when discovery is off', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-home-test-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    vi.stubEnv('BOTS_CONFIG', writeBotsConfig());
    vi.stubEnv('METABOT_HOME', home);
    vi.stubEnv('METABOT_CLUSTER_URL', 'http://metabot.internal:9100');
    vi.stubEnv('METABOT_DISCOVERY_MODE', 'off');
    vi.stubEnv('METABOT_PEERS', '');

    const config = loadAppConfig();

    expect(config.peers).toEqual([]);
  });
});
