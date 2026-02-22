import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../utils/logger.js';

export interface UserSession {
  sessionId: string | undefined;
  workingDirectory: string;
  lastUsed: number;
}

interface PersistedSession {
  sessionId: string;
  workingDirectory: string;
  lastUsed: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
      session = {
        sessionId: undefined,
        workingDirectory: this.defaultWorkingDirectory,
        lastUsed: Date.now(),
      };
      this.sessions.set(chatId, session);
    }
    session.lastUsed = Date.now();
    return session;
  }

  setSessionId(chatId: string, sessionId: string): void {
    const session = this.getSession(chatId);
    session.sessionId = sessionId;
    this.logger.debug({ chatId, sessionId: sessionId.slice(0, 8) }, 'Session ID updated');
    this.saveToDisk();
  }

  resetSession(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.sessionId = undefined;
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
        // Only persist sessions that have a sessionId (active Claude sessions)
        if (session.sessionId) {
          data[chatId] = {
            sessionId: session.sessionId,
            workingDirectory: session.workingDirectory,
            lastUsed: session.lastUsed,
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
          sessionId: persisted.sessionId,
          workingDirectory: persisted.workingDirectory,
          lastUsed: persisted.lastUsed,
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
