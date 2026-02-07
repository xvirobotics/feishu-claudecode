import type { Logger } from '../utils/logger.js';

export interface UserSession {
  sessionId: string | undefined;
  workingDirectory: string | undefined;
  lastUsed: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private defaultWorkingDirectory: string | undefined,
    private logger: Logger,
  ) {
    // Periodic cleanup every hour
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 60 * 1000);
  }

  getSession(userId: string): UserSession {
    let session = this.sessions.get(userId);
    if (!session) {
      session = {
        sessionId: undefined,
        workingDirectory: this.defaultWorkingDirectory,
        lastUsed: Date.now(),
      };
      this.sessions.set(userId, session);
    }
    session.lastUsed = Date.now();
    return session;
  }

  setSessionId(userId: string, sessionId: string): void {
    const session = this.getSession(userId);
    session.sessionId = sessionId;
    this.logger.debug({ userId, sessionId: sessionId.slice(0, 8) }, 'Session ID updated');
  }

  setWorkingDirectory(userId: string, directory: string): void {
    const session = this.getSession(userId);
    // Reset session when directory changes (old session is bound to old cwd)
    if (session.workingDirectory !== directory && session.sessionId) {
      session.sessionId = undefined;
      this.logger.info({ userId }, 'Session reset due to directory change');
    }
    session.workingDirectory = directory;
    this.logger.info({ userId, directory }, 'Working directory updated');
  }

  resetSession(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) {
      session.sessionId = undefined;
      // Keep working directory
      this.logger.info({ userId }, 'Session reset');
    }
  }

  hasWorkingDirectory(userId: string): boolean {
    const session = this.getSession(userId);
    return !!session.workingDirectory;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_TTL_MS) {
        this.sessions.delete(userId);
        this.logger.debug({ userId }, 'Expired session cleaned up');
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
