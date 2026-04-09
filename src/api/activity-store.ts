/**
 * Activity event store — tracks task lifecycle events for the Team workspace.
 * SQLite-backed with an in-memory ring buffer for fast access.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

export interface ActivityEvent {
  id: string;
  type: 'task_started' | 'task_completed' | 'task_failed';
  botName: string;
  chatId: string;
  userId?: string;
  prompt?: string;
  responsePreview?: string;
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  timestamp: number;
}

const MAX_BUFFER_SIZE = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class ActivityStore {
  private db: Database.Database;
  private buffer: ActivityEvent[] = [];

  constructor(private logger: Logger) {
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'activity.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();

    // Cleanup old events on startup
    this.cleanup();

    // Load recent events into buffer
    this.buffer = this.list({ limit: MAX_BUFFER_SIZE });

    this.logger.info({ dbPath }, 'Activity store initialized');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT,
        prompt TEXT,
        response_preview TEXT,
        cost_usd REAL,
        duration_ms REAL,
        error_message TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_bot_name ON activity_events(bot_name, timestamp DESC);
    `);
  }

  /** Record an activity event. Returns the event with generated ID. */
  record(event: Omit<ActivityEvent, 'id'>): ActivityEvent {
    const id = crypto.randomUUID();
    const full: ActivityEvent = { id, ...event };

    this.db.prepare(`
      INSERT INTO activity_events (id, type, bot_name, chat_id, user_id, prompt, response_preview, cost_usd, duration_ms, error_message, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, event.type, event.botName, event.chatId,
      event.userId || null, event.prompt?.slice(0, 200) || null,
      event.responsePreview?.slice(0, 200) || null,
      event.costUsd || null, event.durationMs || null,
      event.errorMessage?.slice(0, 500) || null, event.timestamp,
    );

    // Add to ring buffer
    this.buffer.unshift(full);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.pop();
    }

    return full;
  }

  /** List recent activity events. */
  list(opts: { limit?: number; botName?: string; since?: number } = {}): ActivityEvent[] {
    const { limit = 50, botName, since } = opts;

    let sql = 'SELECT * FROM activity_events WHERE 1=1';
    const params: any[] = [];

    if (botName) {
      sql += ' AND bot_name = ?';
      params.push(botName);
    }
    if (since) {
      sql += ' AND timestamp > ?';
      params.push(since);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params).map(this.mapRow) as ActivityEvent[];
  }

  /** Get recent events from in-memory buffer (fast). */
  getRecent(limit = 50): ActivityEvent[] {
    return this.buffer.slice(0, limit);
  }

  /** Clean up events older than 7 days. */
  cleanup(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    const result = this.db.prepare('DELETE FROM activity_events WHERE timestamp < ?').run(cutoff);
    if (result.changes > 0) {
      this.logger.info({ deleted: result.changes }, 'Activity store cleanup');
    }
  }

  close(): void {
    this.db.close();
  }

  private mapRow(row: any): ActivityEvent {
    return {
      id: row.id,
      type: row.type,
      botName: row.bot_name,
      chatId: row.chat_id,
      userId: row.user_id || undefined,
      prompt: row.prompt || undefined,
      responsePreview: row.response_preview || undefined,
      costUsd: row.cost_usd || undefined,
      durationMs: row.duration_ms || undefined,
      errorMessage: row.error_message || undefined,
      timestamp: row.timestamp,
    };
  }
}
