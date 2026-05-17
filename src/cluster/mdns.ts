import { createHash } from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { InstanceIdentity } from './identity.js';

/**
 * Service type for MetaBot LAN auto-discovery. Advertised as
 * `_metabot._tcp.local` on the local link.
 */
export const MDNS_SERVICE_TYPE = 'metabot';

export interface DiscoveredPeer {
  /** Stable id of the discovered instance (from TXT). */
  instanceId: string;
  /** Human-friendly instance name (from TXT). */
  instanceName: string;
  /** Cluster id, if the peer advertised one. */
  clusterId?: string;
  /** SHA-256 hex fingerprint of the peer's Ed25519 public key (from TXT). */
  publicKeyFingerprint?: string;
  /** HTTP URL built from the peer's advertised host/port. */
  url: string;
  /** First reachable IPv4 address, if any. */
  address?: string;
  /** Advertised API port. */
  port: number;
  /** Raw mDNS service name (FQDN-style); used for tracking down events. */
  serviceName: string;
}

export interface MdnsOptions {
  identity: InstanceIdentity;
  port: number;
  logger: Logger;
  /** Called when a peer is discovered (or re-discovered). */
  onPeerDiscovered: (peer: DiscoveredPeer) => void;
  /** Called when a peer announces departure or disappears. */
  onPeerLost?: (peer: { instanceId?: string; serviceName: string }) => void;
  /** Injection seam for testing — defaults to importing `bonjour-service`. */
  bonjourFactory?: BonjourFactory;
  /** Optional cluster filter — drop services whose TXT clusterId mismatches. */
  clusterFilter?: string;
}

export interface MdnsHandle {
  /** Shut down both the advertise + browse sides cleanly. */
  stop(): Promise<void>;
  /** Test-only: synchronous accessor for the underlying bonjour-service instance. */
  readonly _bonjour?: BonjourLike;
}

/** Minimal interface this module needs from a `bonjour-service`-shaped lib. */
export interface BonjourLike {
  publish(opts: PublishOptions): PublishedServiceLike;
  find(opts: FindOptions | null, onup?: (svc: DiscoveredServiceLike) => void): BrowserLike;
  unpublishAll(cb?: () => void): void;
  destroy(cb?: () => void): void;
}

export interface PublishOptions {
  name: string;
  type: string;
  port: number;
  protocol?: 'tcp' | 'udp';
  txt?: Record<string, string>;
}

export interface PublishedServiceLike {
  stop?: (cb?: () => void) => void;
}

export interface FindOptions {
  type: string;
  protocol?: 'tcp' | 'udp';
}

export interface DiscoveredServiceLike {
  name: string;
  fqdn?: string;
  host?: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, string | undefined>;
}

export interface BrowserLike {
  on(event: 'up' | 'down', cb: (svc: DiscoveredServiceLike) => void): unknown;
  stop?: () => void;
}

export type BonjourFactory = () => BonjourLike | Promise<BonjourLike>;

/**
 * Compute a short, stable fingerprint of an Ed25519 PEM public key so peers
 * can recognise each other across restarts without exchanging the full PEM.
 */
export function publicKeyFingerprint(publicKeyPem?: string): string | undefined {
  if (!publicKeyPem) return undefined;
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 32);
}

function buildTxtRecord(identity: InstanceIdentity): Record<string, string> {
  const txt: Record<string, string> = {
    instanceId: identity.instanceId,
    instanceName: identity.instanceName,
    version: '1',
  };
  if (identity.clusterId) txt.clusterId = identity.clusterId;
  const fp = publicKeyFingerprint(identity.publicKey);
  if (fp) txt.pubkeyFp = fp;
  return txt;
}

function pickFirstIpv4(addresses?: string[]): string | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  // Prefer non-link-local IPv4.
  const ipv4 = addresses.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const routable = ipv4.find((a) => !a.startsWith('169.254.'));
  return routable || ipv4[0] || addresses[0];
}

function buildPeerUrl(address: string | undefined, host: string | undefined, port: number): string {
  // Prefer routable IPv4; fall back to the advertised host (Bonjour gives us
  // `.local` names which only resolve where mDNS resolution is wired in).
  const target = address || host || '127.0.0.1';
  // Wrap IPv6 in brackets.
  const safe = target.includes(':') && !target.startsWith('[') ? `[${target}]` : target;
  return `http://${safe}:${port}`;
}

function defaultBonjourFactory(): BonjourFactory {
  return async () => {
    // Dynamic import keeps the dep optional at type-check time and lets tests
    // inject a stub without pulling the real udp socket open.
    const mod: any = await import('bonjour-service');
    const Ctor = mod.Bonjour || mod.default || mod;
    return new Ctor();
  };
}

/**
 * Start mDNS LAN auto-discovery. Returns a handle whose `stop()` tears down
 * both the advertise and browse sides. When `identity.discoveryMode === 'off'`
 * or `'standalone'`, this is a no-op and the handle's `stop()` resolves
 * immediately. When `'static'`, we still browse but do not advertise (lets an
 * instance see neighbours without publishing itself).
 */
export async function startMdns(options: MdnsOptions): Promise<MdnsHandle> {
  const { identity, port, logger, onPeerDiscovered, onPeerLost } = options;
  const log = logger.child({ module: 'mdns' });

  if (identity.discoveryMode === 'off' || identity.discoveryMode === 'standalone') {
    log.debug({ discoveryMode: identity.discoveryMode }, 'mDNS disabled by discovery mode');
    return { stop: async () => {} };
  }

  const factory = options.bonjourFactory || defaultBonjourFactory();
  let bonjour: BonjourLike;
  try {
    bonjour = await factory();
  } catch (err: any) {
    log.warn({ err: err?.message || err }, 'Failed to initialise bonjour-service; mDNS disabled');
    return { stop: async () => {} };
  }

  // --- Advertise side -----------------------------------------------------
  let published: PublishedServiceLike | undefined;
  const shouldAdvertise = identity.discoveryMode !== 'static';
  if (shouldAdvertise) {
    try {
      published = bonjour.publish({
        name: identity.instanceName || identity.instanceId,
        type: MDNS_SERVICE_TYPE,
        protocol: 'tcp',
        port,
        txt: buildTxtRecord(identity),
      });
      log.info(
        { instanceId: identity.instanceId, port, type: `_${MDNS_SERVICE_TYPE}._tcp.local` },
        'mDNS advertising started',
      );
    } catch (err: any) {
      log.warn({ err: err?.message || err }, 'mDNS advertise failed; will only browse');
    }
  }

  // --- Browse side --------------------------------------------------------
  // Track services we've already surfaced so we can correlate `down` events.
  const seen: Map<string, { instanceId: string }> = new Map();

  let browser: BrowserLike | undefined;
  try {
    browser = bonjour.find({ type: MDNS_SERVICE_TYPE, protocol: 'tcp' });
  } catch (err: any) {
    log.warn({ err: err?.message || err }, 'mDNS browse failed');
  }

  if (browser) {
    browser.on('up', (svc) => {
      try {
        const txt = svc.txt || {};
        const peerInstanceId = (txt.instanceid || txt.instanceId || '').toString();
        const peerInstanceName = (txt.instancename || txt.instanceName || svc.name || '').toString();
        const peerClusterId = (txt.clusterid || txt.clusterId || undefined)?.toString();
        const peerFingerprint = (txt.pubkeyfp || txt.pubkeyFp || undefined)?.toString();

        // Filter self by instance id.
        if (peerInstanceId && peerInstanceId === identity.instanceId) {
          log.debug({ serviceName: svc.name }, 'mDNS ignored self-advertisement');
          return;
        }
        // Optional cluster filter — only join peers in the same cluster when set.
        if (options.clusterFilter && peerClusterId && peerClusterId !== options.clusterFilter) {
          log.debug(
            { serviceName: svc.name, peerClusterId, clusterFilter: options.clusterFilter },
            'mDNS skipped peer in different cluster',
          );
          return;
        }

        const address = pickFirstIpv4(svc.addresses);
        const url = buildPeerUrl(address, svc.host, svc.port);
        const peer: DiscoveredPeer = {
          instanceId: peerInstanceId || svc.name,
          instanceName: peerInstanceName || svc.name,
          ...(peerClusterId ? { clusterId: peerClusterId } : {}),
          ...(peerFingerprint ? { publicKeyFingerprint: peerFingerprint } : {}),
          url,
          ...(address ? { address } : {}),
          port: svc.port,
          serviceName: svc.fqdn || svc.name,
        };
        seen.set(peer.serviceName, { instanceId: peer.instanceId });
        log.info(
          { peerInstanceId: peer.instanceId, peerInstanceName: peer.instanceName, url: peer.url },
          'mDNS peer discovered',
        );
        onPeerDiscovered(peer);
      } catch (err: any) {
        log.warn({ err: err?.message || err }, 'mDNS up handler failed');
      }
    });

    browser.on('down', (svc) => {
      const key = svc.fqdn || svc.name;
      const tracked = seen.get(key);
      seen.delete(key);
      log.info({ serviceName: key, instanceId: tracked?.instanceId }, 'mDNS peer lost');
      if (onPeerLost) {
        onPeerLost({ ...(tracked?.instanceId ? { instanceId: tracked.instanceId } : {}), serviceName: key });
      }
    });
  }

  let stopped = false;
  return {
    _bonjour: bonjour,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        if (browser?.stop) browser.stop();
      } catch (err: any) {
        log.warn({ err: err?.message || err }, 'mDNS browser stop failed');
      }
      try {
        if (published?.stop) {
          await new Promise<void>((resolve) => published!.stop!(() => resolve()));
        } else {
          bonjour.unpublishAll();
        }
      } catch (err: any) {
        log.warn({ err: err?.message || err }, 'mDNS unpublish failed');
      }
      try {
        await new Promise<void>((resolve) => bonjour.destroy(() => resolve()));
      } catch (err: any) {
        log.warn({ err: err?.message || err }, 'mDNS destroy failed');
      }
      log.info('mDNS stopped');
    },
  };
}
