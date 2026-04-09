import type { Logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/http.js';
import type { PeerConfig } from '../config.js';
import type { BotInfo } from './bot-registry.js';

export interface PeerBotInfo extends BotInfo {
  peerUrl: string;
  peerName: string;
}

export interface PeerStatus {
  name: string;
  url: string;
  healthy: boolean;
  lastChecked: number;
  lastHealthy: number;
  botCount: number;
  error?: string;
}

interface PeerState {
  config: PeerConfig;
  healthy: boolean;
  lastChecked: number;
  lastHealthy: number;
  bots: PeerBotInfo[];
  error?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const TASK_FORWARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PeerManager {
  private peers: Map<string, PeerState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private logger: Logger;

  constructor(configs: PeerConfig[], logger: Logger) {
    this.logger = logger.child({ module: 'peers' });

    for (const config of configs) {
      const normalizedUrl = config.url.replace(/\/+$/, '');
      this.peers.set(config.name, {
        config: { ...config, url: normalizedUrl },
        healthy: false,
        lastChecked: 0,
        lastHealthy: 0,
        bots: [],
      });
    }

    const interval = process.env.METABOT_PEER_POLL_INTERVAL_MS
      ? parseInt(process.env.METABOT_PEER_POLL_INTERVAL_MS, 10)
      : DEFAULT_POLL_INTERVAL_MS;

    if (this.peers.size > 0) {
      this.pollTimer = setInterval(() => {
        this.refreshAll().catch((err) => {
          this.logger.error({ err }, 'Peer refresh cycle failed');
        });
      }, interval);
      this.pollTimer.unref();
    }
  }

  async refreshAll(): Promise<void> {
    const tasks = Array.from(this.peers.values()).map((state) =>
      this.refreshPeer(state),
    );
    await Promise.allSettled(tasks);
  }

  private async refreshPeer(state: PeerState): Promise<void> {
    const { config } = state;
    const url = `${config.url}/api/bots`;
    const headers: Record<string, string> = {};
    if (config.secret) {
      headers['Authorization'] = `Bearer ${config.secret}`;
    }

    try {
      const response = await proxyFetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        bots: Array<{
          name: string;
          description?: string;
          platform: string;
          workingDirectory: string;
          peerUrl?: string;
        }>;
      };

      // Filter out transitive bots (bots that already have a peerUrl — they came from another peer)
      const directBots: PeerBotInfo[] = (data.bots || [])
        .filter((b) => !b.peerUrl)
        .map((b) => ({
          name: b.name,
          ...(b.description ? { description: b.description } : {}),
          platform: b.platform,
          workingDirectory: b.workingDirectory,
          peerUrl: config.url,
          peerName: config.name,
        }));

      state.bots = directBots;
      state.healthy = true;
      state.lastChecked = Date.now();
      state.lastHealthy = Date.now();
      state.error = undefined;

      this.logger.debug(
        { peerName: config.name, peerUrl: config.url, botCount: directBots.length },
        'Peer refreshed',
      );
    } catch (err: any) {
      state.healthy = false;
      state.lastChecked = Date.now();
      state.error = err.message || 'Unknown error';
      state.bots = [];

      this.logger.warn(
        { peerName: config.name, peerUrl: config.url, err: err.message },
        'Peer unreachable',
      );
    }
  }

  /** Return all cached bots from healthy peers. */
  getPeerBots(): PeerBotInfo[] {
    const allBots: PeerBotInfo[] = [];
    for (const state of this.peers.values()) {
      if (state.healthy) {
        allBots.push(...state.bots);
      }
    }
    return allBots;
  }

  /** Find a bot by name across all healthy peers (first match wins). */
  findBotPeer(botName: string): { peer: PeerConfig; bot: PeerBotInfo } | undefined {
    for (const state of this.peers.values()) {
      if (!state.healthy) continue;
      const bot = state.bots.find((b) => b.name === botName);
      if (bot) {
        return { peer: state.config, bot };
      }
    }
    return undefined;
  }

  /** Find a bot on a specific peer by peer name (for qualified name syntax: peerName/botName). */
  findBotOnPeer(peerName: string, botName: string): { peer: PeerConfig; bot: PeerBotInfo } | undefined {
    const state = this.peers.get(peerName);
    if (!state || !state.healthy) return undefined;
    const bot = state.bots.find((b) => b.name === botName);
    if (bot) {
      return { peer: state.config, bot };
    }
    return undefined;
  }

  /** Forward a task request to a peer. Adds X-MetaBot-Origin header to prevent loops. */
  async forwardTask(peer: PeerConfig, body: object): Promise<object> {
    const url = `${peer.url}/api/talk`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-MetaBot-Origin': 'peer',
    };
    if (peer.secret) {
      headers['Authorization'] = `Bearer ${peer.secret}`;
    }

    const response = await proxyFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TASK_FORWARD_TIMEOUT_MS),
    });

    return (await response.json()) as object;
  }

  /** Return health status of all configured peers. */
  getPeerStatuses(): PeerStatus[] {
    return Array.from(this.peers.values()).map((state) => ({
      name: state.config.name,
      url: state.config.url,
      healthy: state.healthy,
      lastChecked: state.lastChecked,
      lastHealthy: state.lastHealthy,
      botCount: state.bots.length,
      ...(state.error ? { error: state.error } : {}),
    }));
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
