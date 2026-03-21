/**
 * Cross-platform session registry: tracks sessions across Feishu, Telegram, iOS, and Web.
 * Stores lightweight message transcripts so any client can discover and continue sessions.
 * Uses SQLite for persistence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

export interface SessionRecord {
  id: string;
  botName: string;
  claudeSessionId?: string;
  workingDirectory: string;
  title: string;
  platform: string;
  chatId: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  platform: string;
  costUsd?: number;
  durationMs?: number;
}

export interface SessionLink {
  chatId: string;
  platform: string;
  linkedAt: number;
}

const MAX_MESSAGES_PER_SESSION = 200;

export class SessionRegistry {
  private db: Database.Database;

  constructor(private logger: Logger) {
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'sessions.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.logger.info({ dbPath }, 'Session registry initialized');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        bot_name TEXT NOT NULL,
        claude_session_id TEXT,
        working_directory TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_bot_name ON sessions(bot_name);
      CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_chat_id_unique ON sessions(chat_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_links (
        session_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, chat_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_links_chat_id ON session_links(chat_id);

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        platform TEXT NOT NULL,
        cost_usd REAL,
        duration_ms REAL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
    `);
  }

  /** Detect platform from chatId pattern. */
  static detectPlatform(chatId: string): string {
    if (chatId.startsWith('oc_') || chatId.startsWith('ou_')) return 'feishu';
    if (/^\d+$/.test(chatId)) return 'telegram';
    if (chatId.startsWith('ios_')) return 'ios';
    return 'web';
  }

  /**
   * Create or update a session record after execution completes.
   * Called by MessageBridge after each task.
   */
  createOrUpdate(opts: {
    chatId: string;
    botName: string;
    claudeSessionId?: string;
    workingDirectory: string;
    prompt: string;
    responseText?: string;
    costUsd?: number;
    durationMs?: number;
  }): string {
    const { chatId, botName, claudeSessionId, workingDirectory, prompt, responseText, costUsd, durationMs } = opts;
    const platform = SessionRegistry.detectPlatform(chatId);
    const now = Date.now();

    // Check if session exists for this chatId
    let session = this.findByChatId(chatId);

    if (session) {
      // Update existing session
      const updates: string[] = ['updated_at = ?'];
      const params: any[] = [now];

      if (claudeSessionId) {
        updates.push('claude_session_id = ?');
        params.push(claudeSessionId);
      }

      params.push(chatId);
      this.db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE chat_id = ?`).run(...params);

      // Also check session_links for linked chatIds
      const linkRow = this.db.prepare('SELECT session_id FROM session_links WHERE chat_id = ?').get(chatId) as any;
      if (linkRow) {
        this.db.prepare('UPDATE sessions SET updated_at = ?, claude_session_id = COALESCE(?, claude_session_id) WHERE id = ?')
          .run(now, claudeSessionId || null, linkRow.session_id);
        session = this.getSession(linkRow.session_id)!;
      }
    } else {
      // Check if this chatId is a linked chatId
      const linkRow = this.db.prepare('SELECT session_id FROM session_links WHERE chat_id = ?').get(chatId) as any;
      if (linkRow) {
        this.db.prepare('UPDATE sessions SET updated_at = ?, claude_session_id = COALESCE(?, claude_session_id) WHERE id = ?')
          .run(now, claudeSessionId || null, linkRow.session_id);
        session = this.getSession(linkRow.session_id)!;
      } else {
        // Create new session
        const id = crypto.randomUUID();
        const title = prompt.slice(0, 60).replace(/\n/g, ' ');
        this.db.prepare(`
          INSERT INTO sessions (id, bot_name, claude_session_id, working_directory, title, platform, chat_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, botName, claudeSessionId || null, workingDirectory, title, platform, chatId, now, now);
        session = { id, botName, claudeSessionId, workingDirectory, title, platform, chatId, createdAt: now, updatedAt: now };
      }
    }

    // Add messages
    if (prompt) {
      this.addMessage(session!.id, 'user', prompt, platform);
    }
    if (responseText) {
      this.addMessage(session!.id, 'assistant', responseText, platform, costUsd, durationMs);
    }

    return session!.id;
  }

  /** Add a message to a session's transcript. */
  private addMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    text: string,
    platform: string,
    costUsd?: number,
    durationMs?: number,
  ): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO session_messages (session_id, role, text, platform, cost_usd, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, role, text, platform, costUsd || null, durationMs || null, now);

    // Trim old messages if over limit
    const count = (this.db.prepare('SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?').get(sessionId) as any).count;
    if (count > MAX_MESSAGES_PER_SESSION) {
      const excess = count - MAX_MESSAGES_PER_SESSION;
      this.db.prepare(`
        DELETE FROM session_messages WHERE id IN (
          SELECT id FROM session_messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?
        )
      `).run(sessionId, excess);
    }
  }

  /** List sessions for a bot, ordered by most recent first. */
  listSessions(botName: string): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT s.*,
        (SELECT text FROM session_messages WHERE session_id = s.id ORDER BY timestamp DESC LIMIT 1) as last_message_preview
      FROM sessions s
      WHERE s.bot_name = ?
      ORDER BY s.updated_at DESC
      LIMIT 100
    `).all(botName) as any[];

    return rows.map(this.mapRow);
  }

  /** Get a single session by its registry ID. */
  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  /** Find a session by its chatId (primary or linked). */
  findByChatId(chatId: string): SessionRecord | null {
    // Check primary chatId
    const row = this.db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(chatId) as any;
    if (row) return this.mapRow(row);

    // Check linked chatIds
    const link = this.db.prepare('SELECT session_id FROM session_links WHERE chat_id = ?').get(chatId) as any;
    if (link) return this.getSession(link.session_id);

    return null;
  }

  /** Get message history for a session. */
  getMessages(sessionId: string, since?: number): SessionMessage[] {
    let sql = 'SELECT * FROM session_messages WHERE session_id = ?';
    const params: any[] = [sessionId];
    if (since) {
      sql += ' AND timestamp > ?';
      params.push(since);
    }
    sql += ' ORDER BY timestamp ASC LIMIT 200';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      role: r.role as 'user' | 'assistant',
      text: r.text,
      timestamp: r.timestamp,
      platform: r.platform,
      costUsd: r.cost_usd || undefined,
      durationMs: r.duration_ms || undefined,
    }));
  }

  /** Get all linked chatIds for a session. */
  getLinks(sessionId: string): SessionLink[] {
    const rows = this.db.prepare('SELECT * FROM session_links WHERE session_id = ?').all(sessionId) as any[];
    return rows.map((r) => ({
      chatId: r.chat_id,
      platform: r.platform,
      linkedAt: r.linked_at,
    }));
  }

  /**
   * Link a new chatId to an existing session.
   * Returns the Claude session ID so the caller can set it in SessionManager.
   */
  linkChatId(sessionId: string, chatId: string, platform?: string): string | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    const resolvedPlatform = platform || SessionRegistry.detectPlatform(chatId);
    const now = Date.now();

    this.db.prepare(`
      INSERT OR IGNORE INTO session_links (session_id, chat_id, platform, linked_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, chatId, resolvedPlatform, now);

    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);

    this.logger.info({ sessionId, chatId, platform: resolvedPlatform }, 'Session linked to new chatId');
    return session.claudeSessionId;
  }

  /** Delete a session and all its messages/links. */
  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM session_links WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
    this.logger.info('Session registry closed');
  }

  private mapRow(row: any): SessionRecord {
    return {
      id: row.id,
      botName: row.bot_name,
      claudeSessionId: row.claude_session_id || undefined,
      workingDirectory: row.working_directory,
      title: row.title,
      platform: row.platform,
      chatId: row.chat_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessagePreview: row.last_message_preview || undefined,
    };
  }
}
