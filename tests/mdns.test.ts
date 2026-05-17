import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  MDNS_SERVICE_TYPE,
  publicKeyFingerprint,
  startMdns,
  type BonjourLike,
  type DiscoveredServiceLike,
} from '../src/cluster/mdns.js';
import type { InstanceIdentity } from '../src/cluster/identity.js';

function createLogger() {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  logger.child = vi.fn().mockReturnValue(logger);
  return logger;
}

class FakeBrowser extends EventEmitter {
  stopped = false;
  stop() {
    this.stopped = true;
  }
  emitUp(svc: DiscoveredServiceLike) {
    this.emit('up', svc);
  }
  emitDown(svc: DiscoveredServiceLike) {
    this.emit('down', svc);
  }
}

class FakeBonjour implements BonjourLike {
  published: Array<{ name: string; type: string; port: number; txt?: Record<string, string> }> = [];
  unpublishedAll = false;
  destroyed = false;
  publishStopped = false;
  browser = new FakeBrowser();

  publish(opts: any) {
    this.published.push({
      name: opts.name,
      type: opts.type,
      port: opts.port,
      txt: opts.txt,
    });
    return {
      stop: (cb?: () => void) => {
        this.publishStopped = true;
        if (cb) cb();
      },
    };
  }

  find() {
    return this.browser;
  }

  unpublishAll(cb?: () => void) {
    this.unpublishedAll = true;
    if (cb) cb();
  }

  destroy(cb?: () => void) {
    this.destroyed = true;
    if (cb) cb();
  }
}

function makeIdentity(overrides: Partial<InstanceIdentity> = {}): InstanceIdentity {
  return {
    instanceId: 'alice-abc123',
    instanceName: 'Alice Laptop',
    discoveryMode: 'auto',
    memoryNamespace: '/instances/alice-abc123',
    identityPath: '/tmp/identity.json',
    publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----',
    ...overrides,
  };
}

describe('mDNS publicKeyFingerprint', () => {
  it('returns a stable short hex fingerprint', () => {
    const fp1 = publicKeyFingerprint('pem-A');
    const fp2 = publicKeyFingerprint('pem-A');
    const fp3 = publicKeyFingerprint('pem-B');
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1).toHaveLength(32);
  });

  it('returns undefined for missing pem', () => {
    expect(publicKeyFingerprint(undefined)).toBeUndefined();
  });
});

describe('startMdns', () => {
  let logger: ReturnType<typeof createLogger>;
  let bonjour: FakeBonjour;

  beforeEach(() => {
    logger = createLogger();
    bonjour = new FakeBonjour();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op when discoveryMode is off', async () => {
    const onPeerDiscovered = vi.fn();
    const handle = await startMdns({
      identity: makeIdentity({ discoveryMode: 'off' }),
      port: 9100,
      logger,
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });
    expect(bonjour.published).toHaveLength(0);
    await handle.stop();
    expect(bonjour.destroyed).toBe(false);
  });

  it('is a no-op when discoveryMode is standalone', async () => {
    const onPeerDiscovered = vi.fn();
    const handle = await startMdns({
      identity: makeIdentity({ discoveryMode: 'standalone' }),
      port: 9100,
      logger,
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });
    expect(bonjour.published).toHaveLength(0);
    await handle.stop();
  });

  it('advertises and browses when discoveryMode is auto', async () => {
    const onPeerDiscovered = vi.fn();
    const handle = await startMdns({
      identity: makeIdentity(),
      port: 9100,
      logger,
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });

    expect(bonjour.published).toHaveLength(1);
    expect(bonjour.published[0]).toMatchObject({
      type: MDNS_SERVICE_TYPE,
      port: 9100,
    });
    expect(bonjour.published[0].txt).toMatchObject({
      instanceId: 'alice-abc123',
      instanceName: 'Alice Laptop',
    });
    expect(bonjour.published[0].txt?.pubkeyFp).toBeTruthy();

    await handle.stop();
    expect(bonjour.publishStopped).toBe(true);
    expect(bonjour.destroyed).toBe(true);
  });

  it('browses but does not advertise when discoveryMode is static', async () => {
    const onPeerDiscovered = vi.fn();
    const handle = await startMdns({
      identity: makeIdentity({ discoveryMode: 'static' }),
      port: 9100,
      logger,
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });
    expect(bonjour.published).toHaveLength(0);
    await handle.stop();
    expect(bonjour.destroyed).toBe(true);
  });

  it('calls onPeerDiscovered when a remote service comes up', async () => {
    const onPeerDiscovered = vi.fn();
    await startMdns({
      identity: makeIdentity(),
      port: 9100,
      logger,
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });

    bonjour.browser.emitUp({
      name: 'Bob Desktop',
      fqdn: 'Bob Desktop._metabot._tcp.local',
      host: 'bob.local',
      port: 9100,
      addresses: ['192.168.1.42', 'fe80::1'],
      txt: {
        instanceId: 'bob-xyz789',
        instanceName: 'Bob Desktop',
        pubkeyFp: 'deadbeef',
      },
    });

    expect(onPeerDiscovered).toHaveBeenCalledTimes(1);
    const peer = onPeerDiscovered.mock.calls[0][0];
    expect(peer.instanceId).toBe('bob-xyz789');
    expect(peer.instanceName).toBe('Bob Desktop');
    expect(peer.url).toBe('http://192.168.1.42:9100');
    expect(peer.publicKeyFingerprint).toBe('deadbeef');
  });

  it('ignores self-advertisements (same instanceId)', async () => {
    const onPeerDiscovered = vi.fn();
    await startMdns({
      identity: makeIdentity({ instanceId: 'self-id' }),
      port: 9100,
      logger,
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });

    bonjour.browser.emitUp({
      name: 'Self',
      fqdn: 'Self._metabot._tcp.local',
      host: 'self.local',
      port: 9100,
      addresses: ['127.0.0.1'],
      txt: { instanceId: 'self-id', instanceName: 'Self' },
    });

    expect(onPeerDiscovered).not.toHaveBeenCalled();
  });

  it('filters peers in a different cluster when clusterFilter is set', async () => {
    const onPeerDiscovered = vi.fn();
    await startMdns({
      identity: makeIdentity(),
      port: 9100,
      logger,
      clusterFilter: 'team-a',
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });

    bonjour.browser.emitUp({
      name: 'Other',
      port: 9100,
      addresses: ['10.0.0.5'],
      txt: { instanceId: 'other', instanceName: 'Other', clusterId: 'team-b' },
    });

    expect(onPeerDiscovered).not.toHaveBeenCalled();

    bonjour.browser.emitUp({
      name: 'Friend',
      port: 9100,
      addresses: ['10.0.0.6'],
      txt: { instanceId: 'friend', instanceName: 'Friend', clusterId: 'team-a' },
    });
    expect(onPeerDiscovered).toHaveBeenCalledTimes(1);
  });

  it('calls onPeerLost when a service goes down', async () => {
    const onPeerDiscovered = vi.fn();
    const onPeerLost = vi.fn();
    await startMdns({
      identity: makeIdentity(),
      port: 9100,
      logger,
      onPeerDiscovered,
      onPeerLost,
      bonjourFactory: () => bonjour,
    });

    bonjour.browser.emitUp({
      name: 'Bob',
      fqdn: 'Bob._metabot._tcp.local',
      port: 9100,
      addresses: ['192.168.1.42'],
      txt: { instanceId: 'bob', instanceName: 'Bob' },
    });
    bonjour.browser.emitDown({
      name: 'Bob',
      fqdn: 'Bob._metabot._tcp.local',
      port: 9100,
    });
    expect(onPeerLost).toHaveBeenCalledWith({
      instanceId: 'bob',
      serviceName: 'Bob._metabot._tcp.local',
    });
  });

  it('falls back to host when no IPv4 address is given', async () => {
    const onPeerDiscovered = vi.fn();
    await startMdns({
      identity: makeIdentity(),
      port: 9100,
      logger,
      onPeerDiscovered,
      bonjourFactory: () => bonjour,
    });

    bonjour.browser.emitUp({
      name: 'NoIp',
      port: 9100,
      host: 'no-ip.local',
      addresses: [],
      txt: { instanceId: 'no-ip-id', instanceName: 'NoIp' },
    });

    expect(onPeerDiscovered).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://no-ip.local:9100' }),
    );
  });

  it('returns a working no-op handle when bonjour factory throws', async () => {
    const handle = await startMdns({
      identity: makeIdentity(),
      port: 9100,
      logger,
      onPeerDiscovered: vi.fn(),
      bonjourFactory: () => {
        throw new Error('socket error');
      },
    });
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'socket error' }),
      expect.stringContaining('Failed to initialise'),
    );
  });
});
