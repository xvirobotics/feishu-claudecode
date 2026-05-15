import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadInstanceIdentity } from '../src/cluster/identity.js';

describe('instance identity', () => {
  it('creates and reuses a persistent identity', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-identity-test-'));
    try {
      const first = loadInstanceIdentity({
        homeDir,
        env: {
          METABOT_INSTANCE_NAME: 'Alice Laptop',
        } as NodeJS.ProcessEnv,
      });
      const second = loadInstanceIdentity({
        homeDir,
        env: {} as NodeJS.ProcessEnv,
      });

      expect(first.instanceId).toBe(second.instanceId);
      expect(first.instanceName).toBe('Alice Laptop');
      expect(second.memoryNamespace).toBe(`/instances/${first.instanceId}`);
      expect(fs.existsSync(path.join(homeDir, '.metabot', 'identity.json'))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, '.metabot', 'identity.key'))).toBe(true);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('lets environment values override persisted identity fields', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-identity-env-test-'));
    try {
      loadInstanceIdentity({
        homeDir,
        env: {
          METABOT_INSTANCE_NAME: 'Original',
        } as NodeJS.ProcessEnv,
      });

      const identity = loadInstanceIdentity({
        homeDir,
        env: {
          METABOT_INSTANCE_ID: 'explicit-id',
          METABOT_INSTANCE_NAME: 'Explicit Name',
          METABOT_CLUSTER_ID: 'team-lan',
          METABOT_CLUSTER_URL: 'http://metabot.internal:9100',
          METABOT_DISCOVERY_MODE: 'standalone',
          METABOT_MEMORY_NAMESPACE: '/custom/ns',
        } as NodeJS.ProcessEnv,
      });

      expect(identity.instanceId).toBe('explicit-id');
      expect(identity.instanceName).toBe('Explicit Name');
      expect(identity.clusterId).toBe('team-lan');
      expect(identity.clusterUrl).toBe('http://metabot.internal:9100');
      expect(identity.discoveryMode).toBe('standalone');
      expect(identity.memoryNamespace).toBe('/custom/ns');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
