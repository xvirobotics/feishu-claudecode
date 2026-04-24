import type { Logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/http.js';
import type { PeerConfig } from '../config.js';
import type { BotInfo } from './bot-registry.js';

export interface PeerBotInfo extends BotInfo {
  peerUrl: string;
  peerName: string;
}

export interface PeerSkillInfo {
  name: string;
  description: string;
  version: number;
  author: string;
  tags: string[];
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
  skills: PeerSkillInfo[];
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
        skills: [],
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
    const headers: Record<string, string> = {
      'X-MetaBot-Origin': 'peer',
    };
    if (config.secret) {
      headers['Authorization'] = `Bearer ${config.secret}`;
    }

    try {
      // Fetch bots and skills in parallel
      const [botsResp, skillsResp] = await Promise.all([
        proxyFetch(`${config.url}/api/bots`, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
        proxyFetch(`${config.url}/api/skills`, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }).catch(() => null), // Skills endpoint may not exist on older peers
      ]);

      if (!botsResp.ok) {
        throw new Error(`HTTP ${botsResp.status}: ${botsResp.statusText}`);
      }

      const botsData = (await botsResp.json()) as {
        bots: Array<{
          name: string;
          description?: string;
          platform: string;
          engine?: BotInfo['engine'];
          model?: string;
          workingDirectory: string;
          peerUrl?: string;
        }>;
      };

      // Filter out transitive bots (bots that already have a peerUrl — they came from another peer)
      const directBots: PeerBotInfo[] = (botsData.bots || [])
        .filter((b) => !b.peerUrl)
        .map((b) => ({
          name: b.name,
          ...(b.description ? { description: b.description } : {}),
          platform: b.platform,
          engine: b.engine ?? 'claude',
          ...(b.model ? { model: b.model } : {}),
          workingDirectory: b.workingDirectory,
          peerUrl: config.url,
          peerName: config.name,
        }));

      // Parse peer skills
      let peerSkills: PeerSkillInfo[] = [];
      if (skillsResp?.ok) {
        const skillsData = (await skillsResp.json()) as {
          skills: Array<{
            name: string;
            description: string;
            version: number;
            author: string;
            tags: string[];
            peerUrl?: string;
          }>;
        };
        // Filter out transitive skills
        peerSkills = (skillsData.skills || [])
          .filter((s) => !s.peerUrl)
          .map((s) => ({
            name: s.name,
            description: s.description || '',
            version: s.version || 1,
            author: s.author || '',
            tags: s.tags || [],
            peerUrl: config.url,
            peerName: config.name,
          }));
      }

      state.bots = directBots;
      state.skills = peerSkills;
      state.healthy = true;
      state.lastChecked = Date.now();
      state.lastHealthy = Date.now();
      state.error = undefined;

      this.logger.debug(
        { peerName: config.name, peerUrl: config.url, botCount: directBots.length, skillCount: peerSkills.length },
        'Peer refreshed',
      );
    } catch (err: any) {
      state.healthy = false;
      state.lastChecked = Date.now();
      state.error = err.message || 'Unknown error';
      state.bots = [];
      state.skills = [];

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

  /** Return all cached skills from healthy peers. */
  getPeerSkills(): PeerSkillInfo[] {
    const allSkills: PeerSkillInfo[] = [];
    for (const state of this.peers.values()) {
      if (state.healthy) {
        allSkills.push(...state.skills);
      }
    }
    return allSkills;
  }

  /** Fetch a full skill record from a peer by peer name. */
  async fetchPeerSkill(peerName: string, skillName: string): Promise<{ skillMd: string; referencesTar?: Buffer } | null> {
    const state = this.peers.get(peerName);
    if (!state || !state.healthy) return null;

    const { config } = state;
    const headers: Record<string, string> = {
      'X-MetaBot-Origin': 'peer',
    };
    if (config.secret) {
      headers['Authorization'] = `Bearer ${config.secret}`;
    }

    try {
      const response = await proxyFetch(`${config.url}/api/skills/${encodeURIComponent(skillName)}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as any;
      return {
        skillMd: data.skillMd || '',
        referencesTar: data.referencesTar ? Buffer.from(data.referencesTar, 'base64') : undefined,
      };
    } catch {
      return null;
    }
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
