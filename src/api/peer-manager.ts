import * as fs from 'node:fs';
import * as path from 'node:path';
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
  ownerInstanceId?: string;
  ownerInstanceName?: string;
  visibility?: 'private' | 'published' | 'shared';
  contentHash?: string;
  tags: string[];
  peerUrl: string;
  peerName: string;
  stale?: boolean;
  cachedAt?: number;
  lastSeenAt?: number;
  hasCachedContent?: boolean;
}

export interface PeerMemoryDocument {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content: string;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  peerUrl: string;
  peerName: string;
  stale?: boolean;
  cachedAt: number;
  lastSeenAt: number;
}

export interface PeerMemorySearchResult {
  id: string;
  title: string;
  path: string;
  snippet: string;
  tags: string[];
  created_by: string;
  updated_at: string;
  peerUrl: string;
  peerName: string;
  stale: boolean;
  cachedAt: number;
  lastSeenAt: number;
}

export type PeerSource = 'static' | 'cluster' | 'mdns' | 'manual';

export interface PeerStatus {
  name: string;
  url: string;
  healthy: boolean;
  lastChecked: number;
  lastHealthy: number;
  botCount: number;
  source: PeerSource;
  instanceId?: string;
  error?: string;
}

interface PeerState {
  config: PeerConfig;
  source: PeerSource;
  instanceId?: string;
  healthy: boolean;
  lastChecked: number;
  lastHealthy: number;
  bots: PeerBotInfo[];
  skills: PeerSkillInfo[];
  error?: string;
}

interface CachedPeerSkillContent {
  skillMd: string;
  referencesTarBase64?: string;
  cachedAt: number;
  contentHash?: string;
}

interface CachedPeerSkills {
  peerName: string;
  peerUrl: string;
  lastSeenAt: number;
  skills: PeerSkillInfo[];
  contents: Record<string, CachedPeerSkillContent>;
}

interface CachedPeerMemoryDocument {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content: string;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  cachedAt: number;
}

interface CachedPeerMemory {
  peerName: string;
  peerUrl: string;
  lastSeenAt: number;
  documents: Record<string, CachedPeerMemoryDocument>;
}

interface PeerCacheFile {
  version: 1;
  peers: Record<string, CachedPeerSkills>;
  memory?: Record<string, CachedPeerMemory>;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const TASK_FORWARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class PeerManager {
  private peers: Map<string, PeerState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;
  private logger: Logger;
  private cachePath: string;
  private cache: PeerCacheFile;

  constructor(configs: PeerConfig[], logger: Logger) {
    this.logger = logger.child({ module: 'peers' });
    this.cachePath = process.env.METABOT_PEER_CACHE_PATH
      || path.join(process.cwd(), 'data', 'peer-cache.json');
    this.cache = this.loadCache();

    for (const config of configs) {
      const normalizedUrl = config.url.replace(/\/+$/, '');
      this.peers.set(config.name, {
        config: { ...config, url: normalizedUrl },
        source: 'static',
        healthy: false,
        lastChecked: 0,
        lastHealthy: 0,
        bots: [],
        skills: [],
      });
    }

    this.pollIntervalMs = process.env.METABOT_PEER_POLL_INTERVAL_MS
      ? parseInt(process.env.METABOT_PEER_POLL_INTERVAL_MS, 10)
      : DEFAULT_POLL_INTERVAL_MS;

    if (this.peers.size > 0) {
      this.ensurePollTimer();
    }
  }

  private ensurePollTimer(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.refreshAll().catch((err) => {
        this.logger.error({ err }, 'Peer refresh cycle failed');
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref();
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
          memoryNamespace?: string;
          memoryProject?: string;
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
          ...(b.memoryNamespace ? { memoryNamespace: b.memoryNamespace } : {}),
          ...(b.memoryProject ? { memoryProject: b.memoryProject } : {}),
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
            ownerInstanceId: (s as any).ownerInstanceId || undefined,
            ownerInstanceName: (s as any).ownerInstanceName || undefined,
            visibility: (s as any).visibility || 'published',
            contentHash: (s as any).contentHash || undefined,
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
      this.cachePeerSkillSummaries(config, peerSkills, state.lastHealthy);
      await Promise.allSettled([
        this.refreshPeerSkillContentCache(config, peerSkills, headers),
        this.refreshPeerMemoryCache(config, headers, state.lastHealthy),
      ]);

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

  private loadCache(): PeerCacheFile {
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as PeerCacheFile;
      if (parsed?.version === 1 && parsed.peers) return parsed;
    } catch {
      // Missing or invalid cache is non-fatal.
    }
    return { version: 1, peers: {}, memory: {} };
  }

  private saveCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, `${JSON.stringify(this.cache, null, 2)}\n`, { mode: 0o600 });
    } catch (err: any) {
      this.logger.warn({ err: err.message, cachePath: this.cachePath }, 'Failed to save peer cache');
    }
  }

  private cachePeerSkillSummaries(config: PeerConfig, skills: PeerSkillInfo[], lastSeenAt: number): void {
    const existing = this.cache.peers[config.name];
    const contents = existing?.contents || {};
    this.cache.peers[config.name] = {
      peerName: config.name,
      peerUrl: config.url,
      lastSeenAt,
      skills: skills.map((skill) => ({
        ...skill,
        stale: false,
        cachedAt: lastSeenAt,
        lastSeenAt,
        hasCachedContent: !!contents[skill.name],
      })),
      contents,
    };
    this.saveCache();
  }

  private async fetchPeerSkillContentFromNetwork(
    config: PeerConfig,
    skillName: string,
    headers: Record<string, string>,
  ): Promise<{ skillMd: string; referencesTar?: Buffer } | null> {
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

  private async refreshPeerSkillContentCache(
    config: PeerConfig,
    skills: PeerSkillInfo[],
    headers: Record<string, string>,
  ): Promise<void> {
    if (process.env.METABOT_PEER_SKILL_CACHE_CONTENTS === 'false') return;
    const peerCache = this.cache.peers[config.name];
    if (!peerCache) return;

    const tasks = skills.slice(0, 100).map(async (skill) => {
      const cached = peerCache.contents[skill.name];
      if (cached && cached.contentHash && skill.contentHash && cached.contentHash === skill.contentHash) return;
      const content = await this.fetchPeerSkillContentFromNetwork(config, skill.name, headers);
      if (!content?.skillMd) return;
      peerCache.contents[skill.name] = {
        skillMd: content.skillMd,
        referencesTarBase64: content.referencesTar?.toString('base64'),
        cachedAt: Date.now(),
        contentHash: skill.contentHash,
      };
    });
    await Promise.allSettled(tasks);
    for (const skill of peerCache.skills) {
      skill.hasCachedContent = !!peerCache.contents[skill.name];
    }
    this.saveCache();
  }

  private getMemoryCache(): Record<string, CachedPeerMemory> {
    if (!this.cache.memory) this.cache.memory = {};
    return this.cache.memory;
  }

  private async fetchPeerMemoryJson(config: PeerConfig, apiPath: string, headers: Record<string, string>): Promise<unknown | null> {
    try {
      const response = await proxyFetch(`${config.url}/memory${apiPath}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }

  private unwrapMemoryDocuments(raw: unknown): Array<{
    id: string;
    title: string;
    folder_id: string;
    path: string;
    content?: string;
    tags?: string[];
    created_by?: string;
    created_at?: string;
    updated_at?: string;
  }> {
    if (Array.isArray(raw)) return raw as any[];
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.documents)) return obj.documents as any[];
      if (Array.isArray(obj.results)) return obj.results as any[];
      if (Array.isArray(obj.data)) return obj.data as any[];
    }
    return [];
  }

  private async refreshPeerMemoryCache(config: PeerConfig, headers: Record<string, string>, lastSeenAt: number): Promise<void> {
    if (process.env.METABOT_PEER_MEMORY_CACHE_ENABLED === 'false') return;
    const limit = Math.min(Math.max(parseInt(process.env.METABOT_PEER_MEMORY_CACHE_LIMIT || '200', 10) || 200, 1), 500);
    const raw = await this.fetchPeerMemoryJson(config, `/api/documents?limit=${limit}`, headers);
    const summaries = this.unwrapMemoryDocuments(raw);
    if (summaries.length === 0) return;

    const memoryCache = this.getMemoryCache();
    const peerCache = memoryCache[config.name] || {
      peerName: config.name,
      peerUrl: config.url,
      lastSeenAt,
      documents: {},
    };
    peerCache.peerUrl = config.url;
    peerCache.lastSeenAt = lastSeenAt;

    const tasks = summaries.map(async (summary) => {
      if (!summary.id) return;
      const cached = peerCache.documents[summary.id];
      if (cached && cached.updated_at && summary.updated_at && cached.updated_at === summary.updated_at) return;
      const fullRaw = await this.fetchPeerMemoryJson(config, `/api/documents/${encodeURIComponent(summary.id)}`, headers);
      const full = fullRaw && typeof fullRaw === 'object' && 'document' in fullRaw
        ? (fullRaw as any).document
        : fullRaw;
      if (!full || typeof full !== 'object') return;
      const doc = full as any;
      peerCache.documents[summary.id] = {
        id: doc.id || summary.id,
        title: doc.title || summary.title || '',
        folder_id: doc.folder_id || summary.folder_id || 'root',
        path: doc.path || summary.path || '',
        content: doc.content || '',
        tags: Array.isArray(doc.tags) ? doc.tags : Array.isArray(summary.tags) ? summary.tags : [],
        created_by: doc.created_by || summary.created_by || '',
        created_at: doc.created_at || summary.created_at || '',
        updated_at: doc.updated_at || summary.updated_at || '',
        cachedAt: Date.now(),
      };
    });
    await Promise.allSettled(tasks);
    memoryCache[config.name] = peerCache;
    this.saveCache();
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

  /** Return all live skills, plus stale cached skills for unavailable peers. */
  getPeerSkills(): PeerSkillInfo[] {
    const allSkills: PeerSkillInfo[] = [];
    const livePeerNames = new Set<string>();
    for (const state of this.peers.values()) {
      if (state.healthy) {
        livePeerNames.add(state.config.name);
        const peerCache = this.cache.peers[state.config.name];
        allSkills.push(...state.skills.map((skill) => ({
          ...skill,
          stale: false,
          lastSeenAt: state.lastHealthy,
          hasCachedContent: !!peerCache?.contents[skill.name],
        })));
      }
    }
    for (const [peerName, cached] of Object.entries(this.cache.peers)) {
      if (livePeerNames.has(peerName)) continue;
      allSkills.push(...cached.skills.map((skill) => ({
        ...skill,
        peerName: cached.peerName,
        peerUrl: cached.peerUrl,
        stale: true,
        cachedAt: skill.cachedAt || cached.lastSeenAt,
        lastSeenAt: cached.lastSeenAt,
        hasCachedContent: !!cached.contents[skill.name],
      })));
    }
    return allSkills;
  }

  /** Fetch a full skill record from a peer by peer name. */
  async fetchPeerSkill(peerName: string, skillName: string): Promise<{ skillMd: string; referencesTar?: Buffer } | null> {
    const state = this.peers.get(peerName);
    if (state?.healthy) {
      const { config } = state;
      const headers: Record<string, string> = {
        'X-MetaBot-Origin': 'peer',
      };
      if (config.secret) {
        headers['Authorization'] = `Bearer ${config.secret}`;
      }
      const live = await this.fetchPeerSkillContentFromNetwork(config, skillName, headers);
      if (live?.skillMd) {
        const peerCache = this.cache.peers[peerName];
        const skill = peerCache?.skills.find((s) => s.name === skillName);
        if (peerCache) {
          peerCache.contents[skillName] = {
            skillMd: live.skillMd,
            referencesTarBase64: live.referencesTar?.toString('base64'),
            cachedAt: Date.now(),
            contentHash: skill?.contentHash,
          };
          this.saveCache();
        }
        return live;
      }
    }
    return this.getCachedPeerSkillContent(peerName, skillName);
  }

  private getCachedPeerSkillContent(peerName: string, skillName: string): { skillMd: string; referencesTar?: Buffer } | null {
    const cached = this.cache.peers[peerName]?.contents[skillName];
    if (!cached?.skillMd) return null;
    return {
      skillMd: cached.skillMd,
      referencesTar: cached.referencesTarBase64
        ? Buffer.from(cached.referencesTarBase64, 'base64')
        : undefined,
    };
  }

  getCachedPeerMemoryDocument(peerName: string, docId: string): PeerMemoryDocument | null {
    const peerCache = this.cache.memory?.[peerName];
    const doc = peerCache?.documents[docId];
    if (!peerCache || !doc) return null;
    const state = this.peers.get(peerName);
    return {
      ...doc,
      peerName: peerCache.peerName,
      peerUrl: peerCache.peerUrl,
      stale: !state?.healthy,
      lastSeenAt: peerCache.lastSeenAt,
    };
  }

  searchCachedPeerMemory(query: string, limit = 20): PeerMemorySearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const results: PeerMemorySearchResult[] = [];
    for (const [peerName, peerCache] of Object.entries(this.cache.memory || {})) {
      const state = this.peers.get(peerName);
      for (const doc of Object.values(peerCache.documents)) {
        const haystack = `${doc.title}\n${doc.path}\n${doc.tags.join(' ')}\n${doc.content}`.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
        results.push({
          id: doc.id,
          title: doc.title,
          path: doc.path,
          snippet: this.buildMemorySnippet(doc.content, terms[0]),
          tags: doc.tags,
          created_by: doc.created_by,
          updated_at: doc.updated_at,
          peerName: peerCache.peerName,
          peerUrl: peerCache.peerUrl,
          stale: !state?.healthy,
          cachedAt: doc.cachedAt,
          lastSeenAt: peerCache.lastSeenAt,
        });
      }
    }
    return results
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, Math.min(Math.max(limit, 1), 100));
  }

  private buildMemorySnippet(content: string, term: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    const index = normalized.toLowerCase().indexOf(term);
    if (index < 0) return normalized.slice(0, 180);
    const start = Math.max(index - 70, 0);
    const end = Math.min(index + 110, normalized.length);
    return `${start > 0 ? '...' : ''}${normalized.slice(start, end)}${end < normalized.length ? '...' : ''}`;
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
      source: state.source,
      ...(state.instanceId ? { instanceId: state.instanceId } : {}),
      ...(state.error ? { error: state.error } : {}),
    }));
  }

  /**
   * Register a peer discovered at runtime (e.g. via mDNS). Static peers that
   * point at the same URL take precedence — the dynamic record is dropped on
   * URL collision so that pre-configured secrets keep working. Returns true
   * when the peer was newly added, false when ignored (duplicate or self).
   */
  addDynamicPeer(input: {
    name: string;
    url: string;
    source: PeerSource;
    instanceId?: string;
    secret?: string;
  }): boolean {
    const normalizedUrl = input.url.replace(/\/+$/, '');
    // Skip self / duplicates by URL.
    for (const state of this.peers.values()) {
      if (state.config.url === normalizedUrl) {
        return false;
      }
    }
    // Avoid name collisions — suffix with a short fragment of the URL.
    let name = input.name;
    if (this.peers.has(name)) {
      const suffix = normalizedUrl.replace(/^https?:\/\//, '').replace(/[:.]/g, '-');
      name = `${name}-${suffix}`;
    }
    this.peers.set(name, {
      config: {
        name,
        url: normalizedUrl,
        ...(input.secret ? { secret: input.secret } : {}),
      },
      source: input.source,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      healthy: false,
      lastChecked: 0,
      lastHealthy: 0,
      bots: [],
      skills: [],
    });
    this.logger.info(
      { peerName: name, peerUrl: normalizedUrl, source: input.source, instanceId: input.instanceId },
      'Peer added dynamically',
    );
    this.ensurePollTimer();
    // Refresh asynchronously so the caller doesn't have to wait.
    const state = this.peers.get(name);
    if (state) {
      this.refreshPeer(state).catch((err) => {
        this.logger.warn({ err: err?.message || err, peerName: name }, 'Initial refresh of dynamic peer failed');
      });
    }
    return true;
  }

  /**
   * Remove a previously-added dynamic peer. Static peers are never removed by
   * this method. Returns true when a record was removed.
   */
  removeDynamicPeer(match: { instanceId?: string; url?: string }): boolean {
    const normalizedUrl = match.url ? match.url.replace(/\/+$/, '') : undefined;
    for (const [name, state] of this.peers.entries()) {
      if (state.source === 'static') continue;
      const matchesInstance = match.instanceId && state.instanceId === match.instanceId;
      const matchesUrl = normalizedUrl && state.config.url === normalizedUrl;
      if (matchesInstance || matchesUrl) {
        this.peers.delete(name);
        this.logger.info({ peerName: name, source: state.source }, 'Dynamic peer removed');
        return true;
      }
    }
    return false;
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
