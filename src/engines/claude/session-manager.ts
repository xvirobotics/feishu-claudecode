import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../../utils/logger.js';

export interface UserSession {
  sessionId: string | undefined;
  workingDirectory: string;
  lastUsed: number;
  /** Cumulative token usage across all queries in this session */
  cumulativeTokens: number;
  /** Cumulative cost (USD) across all queries in this session */
  cumulativeCostUsd: number;
  /** Cumulative duration (ms) across all queries in this session */
  cumulativeDurationMs: number;
  /** Per-session model override (e.g. "claude-opus-4-7"). Falls back to bot default when undefined. */
  model?: string;
}

interface PersistedSession {
  sessionId: string;
  workingDirectory: string;
  lastUsed: number;
  cumulativeTokens?: number;
  cumulativeCostUsd?: number;
  cumulativeDurationMs?: number;
  model?: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 10_000;

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private persistPath: string;

  constructor(
    private defaultWorkingDirectory: string,
    private logger: Logger,
    botName: string = 'default',
  ) {
    // Persist sessions to a file under the project data dir
    const dataDir = process.env.SESSION_STORE_DIR
      || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    this.persistPath = path.join(dataDir, `sessions-${botName}.json`);

    this.loadFromDisk();

    // Periodic cleanup every hour
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 60 * 1000);
  }

  getSession(chatId: string): UserSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      // Evict least-recently-used session if at capacity
      if (this.sessions.size >= MAX_SESSIONS) {
        this.evictOldest();
      }
      session = {
        sessionId: undefined,
        workingDirectory: this.defaultWorkingDirectory,
        lastUsed: Date.now(),
        cumulativeTokens: 0,
        cumulativeCostUsd: 0,
        cumulativeDurationMs: 0,
      };
      this.sessions.set(chatId, session);
    }
    session.lastUsed = Date.now();
    return session;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, s] of this.sessions) {
      if (s.lastUsed < oldestTime) {
        oldestTime = s.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.sessions.delete(oldestKey);
      this.logger.debug({ chatId: oldestKey }, 'Evicted oldest session (capacity limit)');
    }
  }

  setSessionId(chatId: string, sessionId: string): void {
    const session = this.getSession(chatId);
    session.sessionId = sessionId;
    this.logger.debug({ chatId, sessionId: sessionId.slice(0, 8) }, 'Session ID updated');
    this.saveToDisk();
  }

  /** Set per-session model override. Pass undefined to clear. */
  setSessionModel(chatId: string, model: string | undefined): void {
    const session = this.getSession(chatId);
    session.model = model;
    this.logger.info({ chatId, model }, 'Session model override updated');
    this.saveToDisk();
  }

  /** Accumulate token/cost/duration from a completed query into the session totals. */
  addUsage(chatId: string, tokens: number, costUsd: number, durationMs: number): void {
    const session = this.getSession(chatId);
    session.cumulativeTokens += tokens;
    session.cumulativeCostUsd += costUsd;
    session.cumulativeDurationMs += durationMs;
    this.saveToDisk();
  }

  resetSession(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.sessionId = undefined;
      session.cumulativeTokens = 0;
      session.cumulativeCostUsd = 0;
      session.cumulativeDurationMs = 0;
      // Keep working directory
      this.logger.info({ chatId }, 'Session reset');
      this.saveToDisk();
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_TTL_MS) {
        this.sessions.delete(chatId);
        this.logger.debug({ chatId }, 'Expired session cleaned up');
        changed = true;
      }
    }
    if (changed) {
      this.saveToDisk();
    }
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, PersistedSession> = {};
      for (const [chatId, session] of this.sessions) {
        // Persist sessions that have either a sessionId or a model override
        if (session.sessionId || session.model) {
          data[chatId] = {
            sessionId: session.sessionId || '',
            workingDirectory: session.workingDirectory,
            lastUsed: session.lastUsed,
            cumulativeTokens: session.cumulativeTokens,
            cumulativeCostUsd: session.cumulativeCostUsd,
            cumulativeDurationMs: session.cumulativeDurationMs,
            model: session.model,
          };
        }
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to persist sessions to disk');
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data: Record<string, PersistedSession> = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      for (const [chatId, persisted] of Object.entries(data)) {
        // Skip expired sessions
        if (now - persisted.lastUsed > SESSION_TTL_MS) continue;
        this.sessions.set(chatId, {
          sessionId: persisted.sessionId || undefined,
          workingDirectory: persisted.workingDirectory,
          lastUsed: persisted.lastUsed,
          cumulativeTokens: persisted.cumulativeTokens ?? 0,
          cumulativeCostUsd: persisted.cumulativeCostUsd ?? 0,
          cumulativeDurationMs: persisted.cumulativeDurationMs ?? 0,
          model: persisted.model,
        });
        loaded++;
      }
      if (loaded > 0) {
        this.logger.info({ loaded, path: this.persistPath }, 'Restored sessions from disk');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load sessions from disk, starting fresh');
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.saveToDisk();
  }
}
