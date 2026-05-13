/**
 * EXPERIMENTAL — Stage 2.
 *
 * ExecutorRegistry — manages a pool of {@link PersistentClaudeExecutor}
 * instances keyed by chatId. Owns the lifecycle (create, evict, shutdown)
 * so the bridge can stay simple.
 *
 * Eviction strategy:
 *   - LRU when at `maxConcurrent` capacity
 *   - Each executor self-shuts after `idleTimeoutMs` of silence
 *   - Unhealthy executors (closed / crashed) are auto-replaced on next acquire
 *   - Registry removes executors from its map when their 'closed' event fires
 */

import { EventEmitter } from 'node:events';
import type { Logger } from '../../utils/logger.js';
import type { TeamEvent, ApiContext } from './executor.js';
import {
  PersistentClaudeExecutor,
  type PersistentExecutorOptions,
  type ExecutorState,
} from './persistent-executor.js';

const DEFAULT_MAX_CONCURRENT_PER_BOT = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface RegistryOptions {
  logger: Logger;
  /** Max concurrent executors. LRU-evicted past this. Default 20. */
  maxConcurrent?: number;
  /** Idle timeout passed to each executor. Default 30 min. 0 disables. */
  idleTimeoutMs?: number;
  /** Default model for new executors. Per-acquire option overrides this. */
  defaultModel?: string;
  /** Default API key for new executors. */
  defaultApiKey?: string;
}

/**
 * Per-acquire factory options. Things that can vary per chatId (cwd,
 * resumeSessionId, onTeamEvent callback) live here. Pool-wide defaults
 * live on the registry.
 */
export interface AcquireOptions {
  cwd: string;
  resumeSessionId?: string;
  onTeamEvent?: (event: TeamEvent) => void;
  /** Override per-acquire model (else uses registry default). */
  model?: string;
  /** MetaBot bot/chat context baked into the executor's system prompt. */
  apiContext?: ApiContext;
  /** Stable per-chat outputs directory. */
  outputsDir?: string;
}

interface PoolEntry {
  executor: PersistentClaudeExecutor;
  /** For LRU bumping; insertion order in the Map encodes recency. */
  chatId: string;
}

export class ExecutorRegistry extends EventEmitter {
  private executors = new Map<string, PoolEntry>();
  /**
   * In-flight graceful shutdowns by chatId. {@link release} adds an entry
   * before it kicks off the shutdown await, and removes it once the
   * shutdown resolves. {@link acquire} consults this map first: if a
   * shutdown is in flight for the chatId, it awaits completion before
   * inspecting the executors map.
   *
   * Without this, a fast \`/reset\` followed by a new user message would
   * see {@link release}'s `executors.delete()` already done, fall through
   * to the "create new" branch, and end up with two executors for the
   * same chatId in flight — the old one still sending spontaneous-message
   * callbacks into the new card while it shuts down.
   */
  private pendingShutdowns = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(private opts: RegistryOptions) {
    super();
  }

  /**
   * Get or create a healthy executor for chatId. Existing healthy entries
   * are LRU-bumped; closed/crashed entries are replaced. May evict the
   * least-recently-used executor when at `maxConcurrent` capacity.
   *
   * If a release() is mid-shutdown for the same chatId (e.g. a /reset
   * happened a moment ago), this waits for that shutdown to resolve
   * before creating a fresh executor — see {@link pendingShutdowns}.
   */
  async acquire(chatId: string, opts: AcquireOptions): Promise<PersistentClaudeExecutor> {
    if (this.shuttingDown) throw new Error('ExecutorRegistry: shutting down');

    // Wait out any in-flight release() for this chat, otherwise we race
    // with its delete-then-async-shutdown and risk two executors in flight.
    const pending = this.pendingShutdowns.get(chatId);
    if (pending) {
      this.opts.logger.debug({ chatId }, 'ExecutorRegistry: acquire awaiting in-flight release');
      try { await pending; } catch { /* shutdown errors are logged at the source */ }
    }

    const existing = this.executors.get(chatId);
    if (existing) {
      const state = existing.executor.getState();
      if (state === 'ready' || state === 'restarting' || state === 'starting') {
        // Healthy — bump LRU position
        this.executors.delete(chatId);
        this.executors.set(chatId, existing);
        return existing.executor;
      }
      // Unhealthy — drop from map (will recreate below)
      this.opts.logger.info({ chatId, state }, 'ExecutorRegistry: replacing unhealthy executor');
      this.executors.delete(chatId);
    }

    // Make room if at capacity (LRU = first-inserted Map key)
    const max = this.opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PER_BOT;
    while (this.executors.size >= max) {
      const oldestKey = this.executors.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.executors.get(oldestKey)!;
      this.executors.delete(oldestKey);
      this.opts.logger.info({ evictChatId: oldestKey, capacity: max }, 'ExecutorRegistry: LRU evicting');
      this.emit('executor-removed', oldestKey);
      void oldest.executor.shutdown('lru-evict');
    }

    // Create + start
    const execOpts: PersistentExecutorOptions = {
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      apiKey: this.opts.defaultApiKey,
      model: opts.model ?? this.opts.defaultModel,
      logger: this.opts.logger,
      idleTimeoutMs: this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      onTeamEvent: opts.onTeamEvent,
      apiContext: opts.apiContext,
      outputsDir: opts.outputsDir,
    };
    const executor = new PersistentClaudeExecutor(execOpts);
    // Auto-cleanup when executor closes for any reason
    executor.once('closed', () => {
      const cur = this.executors.get(chatId);
      if (cur && cur.executor === executor) {
        this.executors.delete(chatId);
        this.opts.logger.info({ chatId }, 'ExecutorRegistry: executor closed, removed from pool');
        this.emit('executor-removed', chatId);
      }
    });
    await executor.start();
    this.executors.set(chatId, { executor, chatId });
    this.opts.logger.info({ chatId, poolSize: this.executors.size }, 'ExecutorRegistry: acquired new executor');
    this.emit('executor-added', chatId);
    return executor;
  }

  /**
   * Look up an existing executor without creating one. Returns undefined if
   * no executor is currently held for chatId.
   */
  peek(chatId: string): PersistentClaudeExecutor | undefined {
    return this.executors.get(chatId)?.executor;
  }

  /**
   * Force-release the executor for chatId (graceful shutdown). Used by
   * /reset to discard any teammates / background tasks tied to the old
   * session before starting fresh.
   *
   * Emits 'executor-removed' eagerly (before the underlying shutdown
   * resolves) so subscribers like the bridge's spontaneous handler clean
   * up immediately. The 'closed' listener guards against double-emit
   * because the executor is already gone from the map.
   *
   * Records the in-flight shutdown in {@link pendingShutdowns} so a
   * concurrent {@link acquire} for the same chatId will wait it out
   * instead of racing to create a second executor.
   */
  async release(chatId: string, reason: string = 'caller'): Promise<void> {
    const entry = this.executors.get(chatId);
    if (!entry) {
      // Possible nothing to release, but if a previous release is still
      // in flight (race-on-race), let any caller observing the pending
      // map see this call complete in order too.
      const inFlight = this.pendingShutdowns.get(chatId);
      if (inFlight) {
        try { await inFlight; } catch { /* logged at source */ }
      }
      return;
    }
    this.executors.delete(chatId);
    this.opts.logger.info({ chatId, reason }, 'ExecutorRegistry: release');
    this.emit('executor-removed', chatId);

    const shutdownPromise = entry.executor.shutdown(reason).catch((err) => {
      this.opts.logger.warn({ err, chatId }, 'ExecutorRegistry: shutdown rejected');
    });
    this.pendingShutdowns.set(chatId, shutdownPromise);
    try {
      await shutdownPromise;
    } finally {
      // Only clear if our shutdown is still the one registered — a later
      // release for the same chatId could have replaced it (theoretical,
      // but cheap defensive check).
      if (this.pendingShutdowns.get(chatId) === shutdownPromise) {
        this.pendingShutdowns.delete(chatId);
      }
    }
  }

  /** Shut down all executors (call on bot shutdown). */
  async shutdownAll(reason: string = 'registry-shutdown'): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const all = Array.from(this.executors.values());
    this.executors.clear();
    this.opts.logger.info({ count: all.length, reason }, 'ExecutorRegistry: shutting down all');
    await Promise.allSettled(all.map(e => e.executor.shutdown(reason)));
  }

  /** Observability snapshot. */
  list(): Array<{
    chatId: string;
    state: ExecutorState;
    lastActivityAt: number;
    sessionId?: string;
    hasActiveTurn: boolean;
  }> {
    return Array.from(this.executors.entries()).map(([chatId, entry]) => ({
      chatId,
      state: entry.executor.getState(),
      lastActivityAt: entry.executor.getLastActivityAt(),
      sessionId: entry.executor.getSessionId(),
      hasActiveTurn: entry.executor.hasActiveTurn(),
    }));
  }

  size(): number { return this.executors.size; }
}
