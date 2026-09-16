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
 *
 * Crash recovery (registry-level):
 *   The executor self-restarts on transient SDK/PTY stream errors (capped, see
 *   PersistentClaudeExecutor.maybeRestart). When that budget is exhausted it
 *   ends in 'closed' having emitted 'crashed' first. Rather than discard the
 *   pool slot immediately — which would lose all Agent-Team teammates and any
 *   in-progress work, and route the next acquire to a vanilla fresh executor —
 *   the registry KEEPS the crashed entry parked in the pool (its last sessionId
 *   captured for resume) and respawns it on the next acquire / between-turn
 *   attempt, with its own exponential backoff and a respawn cap. Only after the
 *   registry-level respawn budget is exhausted is the entry truly removed
 *   (delete + 'executor-removed').
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
/** Registry-level crash respawn backoff + cap (separate from the executor's
 *  own in-process restart budget). Applied when a crashed entry is respawned
 *  on a later acquire. */
const DEFAULT_RESPAWN_BACKOFF_BASE_MS = 500;
const DEFAULT_RESPAWN_BACKOFF_MAX_MS = 30 * 1000;
const DEFAULT_MAX_RESPAWN_ATTEMPTS = 3;
/** Reset the respawn counter once a respawned executor has stayed healthy this
 *  long, so a single bad patch doesn't permanently burn the budget. */
const RESPAWN_COUNTER_RESET_MS = 5 * 60 * 1000;

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
  /** Turn backend for new executors: 'pty' (default) or 'sdk' (legacy). */
  backend?: 'sdk' | 'pty';
  /**
   * Max registry-level respawns of a crashed executor before its pool slot is
   * truly removed. Distinct from the executor's own in-process restart cap.
   * Default 3.
   */
  maxRespawnAttempts?: number;
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
  /**
   * Ignore the registry's defaultModel for this acquire and spawn/respawn
   * with no model flag, so the endpoint resolves its own default. Used by the
   * unknown-model self-heal when the configured model itself is unroutable.
   */
  ignoreRegistryDefaultModel?: boolean;
  /** MetaBot bot/chat context baked into the executor's system prompt. */
  apiContext?: ApiContext;
  /** Stable per-chat outputs directory. */
  outputsDir?: string;
}

interface PoolEntry {
  executor: PersistentClaudeExecutor;
  /** For LRU bumping; insertion order in the Map encodes recency. */
  chatId: string;
  /**
   * Effective model this executor was spawned with (`opts.model ?? defaultModel`).
   * The model binds at spawn (interactive `claude --model` / SDK queryOptions),
   * so when a later acquire requests a DIFFERENT model the executor must be
   * respawned — see {@link ExecutorRegistry.acquire}.
   */
  model?: string;
  /**
   * Per-acquire options this entry was last spawned with. Captured so a crashed
   * entry can be respawned (resuming its session) without the caller having to
   * re-supply cwd / onTeamEvent / apiContext / outputsDir.
   */
  acquireOpts: AcquireOptions;
  /**
   * True once the executor has emitted 'crashed' and its in-process restart
   * budget is exhausted (terminal 'closed' after a crash). A crashed entry is
   * KEPT in the pool (not deleted) so the next acquire can respawn it with the
   * last sessionId, preserving teammates / in-progress work.
   */
  crashed: boolean;
  /**
   * True once the executor emitted 'crashed' at least once during its life,
   * regardless of whether it later self-recovered. The terminal 'closed'
   * handler reads this to distinguish a crash-exhausted close (park slot for
   * respawn) from a clean idle/graceful close (remove slot). Reset to false on
   * each respawn so a recovered-then-cleanly-closed executor isn't mis-parked.
   */
  crashedFlagSeen?: boolean;
  /** Last sessionId observed before the crash, used as resume target. */
  resumeSessionId?: string;
  /** Registry-level respawn attempts spent on this slot since last reset. */
  respawnAttempts: number;
  /** Wall-clock floor before the next respawn is allowed (backoff gate). */
  nextRespawnAt: number;
  /** When the executor last became healthy (used to reset respawnAttempts). */
  healthySince: number;
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

    const effectiveModel = opts.ignoreRegistryDefaultModel
      ? undefined
      : (opts.model ?? this.opts.defaultModel);
    const existing = this.executors.get(chatId);
    if (existing) {
      const state = existing.executor.getState();
      const healthy = state === 'ready' || state === 'restarting' || state === 'starting';
      if (healthy && existing.model === effectiveModel) {
        // Healthy + same model — bump LRU position
        this.executors.delete(chatId);
        this.executors.set(chatId, existing);
        return existing.executor;
      }
      if (healthy) {
        // Model changed (e.g. /model switch). The model binds at spawn, so
        // reusing this executor would keep the OLD model. Release + respawn —
        // the new executor RESUMES the same session (opts.resumeSessionId), so
        // the conversation is preserved, just continued on the new model.
        this.opts.logger.info(
          { chatId, from: existing.model, to: effectiveModel },
          'ExecutorRegistry: model changed — respawning executor',
        );
        await this.release(chatId, 'model-change');
      } else if (existing.crashed && existing.model === effectiveModel) {
        // Crashed slot — respawn in place (resuming the captured session) so
        // teammates / in-progress work survive. Honors backoff + respawn cap;
        // returns the live executor on success, or undefined once the budget
        // is exhausted (slot removed) — fall through to fresh create then.
        const respawned = await this.respawnCrashed(chatId, existing, opts);
        if (respawned) {
          this.executors.delete(chatId);
          this.executors.set(chatId, existing); // bump LRU
          return respawned;
        }
      } else {
        // Unhealthy (clean close, or crashed under a different model) — drop
        // from map (will recreate below). If the slot was a parked crash, the
        // 'closed' listener intentionally left it in place, so emit removal
        // here to keep bridge bookkeeping (spontaneous subs etc.) in sync.
        this.opts.logger.info({ chatId, state, crashed: existing.crashed }, 'ExecutorRegistry: replacing unhealthy executor');
        this.executors.delete(chatId);
        if (existing.crashed) this.emit('executor-removed', chatId);
      }
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
    const entry: PoolEntry = {
      executor: undefined as unknown as PersistentClaudeExecutor, // set by spawnExecutor
      chatId,
      model: effectiveModel,
      acquireOpts: opts,
      crashed: false,
      resumeSessionId: opts.resumeSessionId,
      respawnAttempts: 0,
      nextRespawnAt: 0,
      healthySince: Date.now(),
    };
    const executor = this.buildExecutor(chatId, entry, opts, effectiveModel, opts.resumeSessionId);
    await executor.start();
    entry.executor = executor;
    entry.healthySince = Date.now();
    this.executors.set(chatId, entry);
    this.opts.logger.info({ chatId, poolSize: this.executors.size }, 'ExecutorRegistry: acquired new executor');
    this.emit('executor-added', chatId);
    return executor;
  }

  /**
   * Construct a {@link PersistentClaudeExecutor} for `entry` and wire its
   * lifecycle listeners (crash parking + close cleanup). Shared by the
   * fresh-create path in {@link acquire} and the {@link respawnCrashed} path.
   * Does NOT call start() — the caller awaits that so it can surface failures.
   */
  private buildExecutor(
    chatId: string,
    entry: PoolEntry,
    opts: AcquireOptions,
    effectiveModel: string | undefined,
    resumeSessionId: string | undefined,
  ): PersistentClaudeExecutor {
    const execOpts: PersistentExecutorOptions = {
      cwd: opts.cwd,
      resumeSessionId,
      apiKey: this.opts.defaultApiKey,
      model: effectiveModel,
      logger: this.opts.logger,
      idleTimeoutMs: this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      onTeamEvent: opts.onTeamEvent,
      apiContext: opts.apiContext,
      outputsDir: opts.outputsDir,
      backend: this.opts.backend,
    };
    const executor = new PersistentClaudeExecutor(execOpts);
    // Remember the last live sessionId so a crash-respawn can resume it even
    // if the SDK forked the sessionId mid-life.
    executor.on('crashed', () => {
      const cur = this.executors.get(chatId);
      if (!cur || cur.executor !== executor) return;
      const sid = executor.getSessionId();
      if (sid) cur.resumeSessionId = sid;
    });
    // Auto-cleanup when executor closes for any reason. A crash-exhausted
    // executor ('crashed' emitted earlier + now terminal 'closed') is KEPT in
    // the pool as a parked slot so the next acquire can respawn it with resume;
    // a clean close (idle / shutdown / stream-end) is removed immediately.
    executor.once('closed', () => {
      const cur = this.executors.get(chatId);
      if (!cur || cur.executor !== executor) return;
      const sid = executor.getSessionId();
      if (sid) cur.resumeSessionId = sid;
      const maxRespawn = this.opts.maxRespawnAttempts ?? DEFAULT_MAX_RESPAWN_ATTEMPTS;
      const crashExhausted =
        cur.executor.getState() === 'closed' &&
        // 'crashed' was emitted before this terminal close
        cur.crashedFlagSeen === true &&
        cur.respawnAttempts < maxRespawn &&
        !this.shuttingDown;
      if (crashExhausted) {
        cur.crashed = true;
        cur.nextRespawnAt = Date.now() + this.respawnBackoffMs(cur.respawnAttempts);
        this.opts.logger.warn(
          { chatId, respawnAttempts: cur.respawnAttempts, resumeSessionId: cur.resumeSessionId },
          'ExecutorRegistry: executor crashed — parking slot for respawn on next acquire',
        );
        // Slot stays in the pool; no 'executor-removed' so bridge keeps its
        // spontaneous subscription / between-turn bookkeeping for the respawn.
        return;
      }
      this.executors.delete(chatId);
      this.opts.logger.info({ chatId }, 'ExecutorRegistry: executor closed, removed from pool');
      this.emit('executor-removed', chatId);
    });
    // Track that a crash happened at all (distinct from clean close), so the
    // 'closed' handler can tell a crash-exhausted close from an idle/graceful one.
    executor.on('crashed', () => {
      const cur = this.executors.get(chatId);
      if (cur && cur.executor === executor) cur.crashedFlagSeen = true;
    });
    // The executor self-recovered a transient crash in-process (restarting →
    // ready). Clear the crash flag so a LATER clean close (idle/shutdown) is
    // treated as graceful and the slot is removed — not mistakenly parked for
    // respawn on the strength of a crash it already recovered from.
    executor.on('restarted', () => {
      const cur = this.executors.get(chatId);
      if (!cur || cur.executor !== executor) return;
      cur.crashedFlagSeen = false;
      cur.healthySince = Date.now();
      const sid = executor.getSessionId();
      if (sid) cur.resumeSessionId = sid;
    });
    return executor;
  }

  private respawnBackoffMs(attempt: number): number {
    const base = DEFAULT_RESPAWN_BACKOFF_BASE_MS * Math.pow(2, attempt);
    return Math.min(base, DEFAULT_RESPAWN_BACKOFF_MAX_MS);
  }

  /**
   * Respawn a parked crashed entry in place, resuming its captured sessionId so
   * teammates / in-progress work survive. Returns the live executor on success,
   * or undefined when the respawn budget is exhausted / backoff not yet elapsed
   * with no budget left — in which case the slot is removed and the caller
   * falls back to a fresh create.
   *
   * Backoff: respawn is gated by `entry.nextRespawnAt`. If a caller arrives
   * before the gate, we still respawn (waiting would block the user's turn);
   * the gate primarily spaces out the attempt-count accounting and is honored
   * on a best-effort basis via a short bounded wait.
   */
  private async respawnCrashed(
    chatId: string,
    entry: PoolEntry,
    opts: AcquireOptions,
  ): Promise<PersistentClaudeExecutor | undefined> {
    const maxRespawn = this.opts.maxRespawnAttempts ?? DEFAULT_MAX_RESPAWN_ATTEMPTS;
    if (entry.respawnAttempts >= maxRespawn) {
      this.opts.logger.error(
        { chatId, respawnAttempts: entry.respawnAttempts, max: maxRespawn },
        'ExecutorRegistry: crash respawn budget exhausted — removing slot',
      );
      this.executors.delete(chatId);
      this.emit('executor-removed', chatId);
      return undefined;
    }
    // Best-effort backoff: wait out the remaining gate, bounded so a user turn
    // never stalls longer than the max backoff.
    const waitMs = Math.min(
      Math.max(0, entry.nextRespawnAt - Date.now()),
      DEFAULT_RESPAWN_BACKOFF_MAX_MS,
    );
    if (waitMs > 0) {
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
    const effectiveModel = opts.ignoreRegistryDefaultModel
      ? undefined
      : (opts.model ?? this.opts.defaultModel);
    entry.respawnAttempts++;
    const resume = entry.resumeSessionId ?? opts.resumeSessionId;
    this.opts.logger.info(
      { chatId, attempt: entry.respawnAttempts, resume },
      'ExecutorRegistry: respawning crashed executor (resume)',
    );
    // Refresh the captured opts (cwd/onTeamEvent/apiContext are stable per chat,
    // but the latest acquire's callbacks should win).
    entry.acquireOpts = opts;
    entry.model = effectiveModel;
    entry.crashed = false;
    entry.crashedFlagSeen = false;
    const executor = this.buildExecutor(chatId, entry, opts, effectiveModel, resume);
    try {
      await executor.start();
    } catch (err) {
      this.opts.logger.error({ err, chatId }, 'ExecutorRegistry: crash respawn start() failed');
      // Re-park (or remove if now exhausted) and let the caller fall back.
      if (entry.respawnAttempts >= maxRespawn) {
        this.executors.delete(chatId);
        this.emit('executor-removed', chatId);
      } else {
        entry.crashed = true;
        entry.nextRespawnAt = Date.now() + this.respawnBackoffMs(entry.respawnAttempts);
      }
      return undefined;
    }
    entry.executor = executor;
    entry.healthySince = Date.now();
    this.opts.logger.info({ chatId, attempt: entry.respawnAttempts }, 'ExecutorRegistry: crashed executor respawned');
    this.emit('executor-respawned', chatId);
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
