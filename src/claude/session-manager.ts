import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../utils/logger.js';

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
  /** 首条消息预览，用于 /sessions 列表展示 */
  title?: string;
}

interface SessionGroup {
  activeIndex: number;
  sessions: UserSession[];
}

// 持久化格式：新格式（SessionGroup）或旧格式（flat PersistedSession）
interface PersistedSessionGroup {
  activeIndex: number;
  sessions: PersistedSession[];
}

interface PersistedSession {
  sessionId: string;
  workingDirectory: string;
  lastUsed: number;
  cumulativeTokens?: number;
  cumulativeCostUsd?: number;
  cumulativeDurationMs?: number;
  title?: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (extended for multi-session)
const MAX_SESSIONS = 10_000;
const MAX_SESSIONS_PER_CHAT = 20;

export class SessionManager {
  private groups = new Map<string, SessionGroup>();
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
    const group = this.getOrCreateGroup(chatId);
    const session = group.sessions[group.activeIndex];
    session.lastUsed = Date.now();
    return session;
  }

  private getOrCreateGroup(chatId: string): SessionGroup {
    let group = this.groups.get(chatId);
    if (!group) {
      // Evict if at capacity
      if (this.groups.size >= MAX_SESSIONS) {
        this.evictOldest();
      }
      group = {
        activeIndex: 0,
        sessions: [this.createEmptySession()],
      };
      this.groups.set(chatId, group);
    }
    return group;
  }

  private createEmptySession(): UserSession {
    return {
      sessionId: undefined,
      workingDirectory: this.defaultWorkingDirectory,
      lastUsed: Date.now(),
      cumulativeTokens: 0,
      cumulativeCostUsd: 0,
      cumulativeDurationMs: 0,
    };
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, group] of this.groups) {
      const lastUsed = Math.max(...group.sessions.map(s => s.lastUsed));
      if (lastUsed < oldestTime) {
        oldestTime = lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.groups.delete(oldestKey);
      this.logger.debug({ chatId: oldestKey }, 'Evicted oldest session group (capacity limit)');
    }
  }

  setSessionId(chatId: string, sessionId: string): void {
    const session = this.getSession(chatId);
    session.sessionId = sessionId;
    this.logger.debug({ chatId, sessionId: sessionId.slice(0, 8) }, 'Session ID updated');
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

  /** Set the title (first message preview) for the active session. Only sets if not already set. */
  setTitle(chatId: string, title: string): void {
    const session = this.getSession(chatId);
    if (!session.title) {
      session.title = title;
      this.saveToDisk();
    }
  }

  /** Create a new session and make it active. Old sessions are preserved. */
  resetSession(chatId: string): void {
    const group = this.getOrCreateGroup(chatId);
    // Trim old sessions if at per-chat limit
    if (group.sessions.length >= MAX_SESSIONS_PER_CHAT) {
      group.sessions.shift();
    }
    group.sessions.push(this.createEmptySession());
    group.activeIndex = group.sessions.length - 1;
    this.logger.info({ chatId, sessionCount: group.sessions.length }, 'Session reset (new session created)');
    this.saveToDisk();
  }

  /** List all sessions for a chatId, ordered by creation (oldest first). */
  listSessions(chatId: string): UserSession[] {
    const group = this.groups.get(chatId);
    return group ? [...group.sessions] : [];
  }

  /** Switch to a different session by index. Returns true if successful. */
  switchSession(chatId: string, index: number): boolean {
    const group = this.groups.get(chatId);
    if (!group || index < 0 || index >= group.sessions.length) return false;
    group.activeIndex = index;
    group.sessions[index].lastUsed = Date.now();
    this.logger.info({ chatId, index, title: group.sessions[index].title }, 'Session switched');
    this.saveToDisk();
    return true;
  }

  /** Get the active session index for a chatId. */
  getActiveIndex(chatId: string): number {
    const group = this.groups.get(chatId);
    return group ? group.activeIndex : 0;
  }

  /** Get a virtual chatId for SessionRegistry record isolation. Format: {chatId}::{N} */
  getVirtualChatId(chatId: string): string {
    const group = this.groups.get(chatId);
    if (!group) return chatId;
    return `${chatId}::${group.activeIndex + 1}`;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [chatId, group] of this.groups) {
      const mostRecent = Math.max(...group.sessions.map(s => s.lastUsed));
      if (now - mostRecent > SESSION_TTL_MS) {
        this.groups.delete(chatId);
        this.logger.debug({ chatId }, 'Expired session group cleaned up');
        changed = true;
      }
    }
    if (changed) {
      this.saveToDisk();
    }
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, PersistedSessionGroup> = {};
      for (const [chatId, group] of this.groups) {
        // 只持久化至少有一个 sessionId 的 group
        const hasAnySession = group.sessions.some(s => s.sessionId);
        if (hasAnySession) {
          data[chatId] = {
            activeIndex: group.activeIndex,
            sessions: group.sessions
              .filter(s => s.sessionId || s.title) // 保留有 sessionId 或 title 的
              .map(s => ({
                sessionId: s.sessionId!,
                workingDirectory: s.workingDirectory,
                lastUsed: s.lastUsed,
                cumulativeTokens: s.cumulativeTokens,
                cumulativeCostUsd: s.cumulativeCostUsd,
                cumulativeDurationMs: s.cumulativeDurationMs,
                title: s.title,
              })),
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
      const data = JSON.parse(raw) as Record<string, unknown>;
      const now = Date.now();
      let loaded = 0;

      for (const [chatId, value] of Object.entries(data)) {
        // 新格式：有 activeIndex 和 sessions 数组
        if (value && typeof value === 'object' && 'sessions' in value && Array.isArray((value as any).sessions)) {
          const persisted = value as PersistedSessionGroup;
          const sessions: UserSession[] = persisted.sessions.map(s => ({
            sessionId: s.sessionId || undefined,
            workingDirectory: s.workingDirectory,
            lastUsed: s.lastUsed,
            cumulativeTokens: s.cumulativeTokens ?? 0,
            cumulativeCostUsd: s.cumulativeCostUsd ?? 0,
            cumulativeDurationMs: s.cumulativeDurationMs ?? 0,
            title: s.title,
          }));
          if (sessions.length === 0) continue;
          const mostRecent = Math.max(...sessions.map(s => s.lastUsed));
          if (now - mostRecent > SESSION_TTL_MS) continue;
          this.groups.set(chatId, {
            activeIndex: Math.min(persisted.activeIndex, sessions.length - 1),
            sessions,
          });
          loaded++;
        }
        // 旧格式：flat PersistedSession（向后兼容）
        else if (value && typeof value === 'object' && 'sessionId' in value) {
          const old = value as PersistedSession;
          if (now - old.lastUsed > SESSION_TTL_MS) continue;
          this.groups.set(chatId, {
            activeIndex: 0,
            sessions: [{
              sessionId: old.sessionId || undefined,
              workingDirectory: old.workingDirectory,
              lastUsed: old.lastUsed,
              cumulativeTokens: old.cumulativeTokens ?? 0,
              cumulativeCostUsd: old.cumulativeCostUsd ?? 0,
              cumulativeDurationMs: old.cumulativeDurationMs ?? 0,
            }],
          });
          loaded++;
        }
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
