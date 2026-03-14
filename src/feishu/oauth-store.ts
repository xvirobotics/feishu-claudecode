/**
 * OAuth token store: persists Feishu user_access_token per user.
 * Uses SQLite (better-sqlite3) following the same pattern as SyncStore.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

export interface OAuthToken {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (seconds)
  scopes: string;
  createdAt: string;
  updatedAt: string;
}

const REFRESH_BUFFER_SECONDS = 300; // refresh 5 min before expiry

export class OAuthStore {
  private db: Database.Database;

  constructor(databaseDir: string, private logger: Logger) {
    fs.mkdirSync(databaseDir, { recursive: true });
    const dbPath = path.join(databaseDir, 'oauth-tokens.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.logger.info({ dbPath }, 'OAuth store initialized');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        user_id        TEXT PRIMARY KEY,
        access_token   TEXT NOT NULL,
        refresh_token  TEXT NOT NULL,
        expires_at     INTEGER NOT NULL,
        scopes         TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `);
  }

  getToken(userId: string): OAuthToken | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE user_id = ?').get(userId) as any;
    if (!row) return undefined;
    return {
      userId: row.user_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      scopes: row.scopes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveToken(token: OAuthToken): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scopes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token = ?, refresh_token = ?, expires_at = ?, scopes = ?, updated_at = ?
    `).run(
      token.userId, token.accessToken, token.refreshToken, token.expiresAt, token.scopes, token.createdAt || now, now,
      token.accessToken, token.refreshToken, token.expiresAt, token.scopes, now,
    );
  }

  deleteToken(userId: string): boolean {
    const result = this.db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
    return result.changes > 0;
  }

  isExpired(token: OAuthToken): boolean {
    return Date.now() / 1000 >= token.expiresAt - REFRESH_BUFFER_SECONDS;
  }

  listUsers(): string[] {
    const rows = this.db.prepare('SELECT user_id FROM oauth_tokens').all() as { user_id: string }[];
    return rows.map((r) => r.user_id);
  }

  close(): void {
    this.db.close();
    this.logger.info('OAuth store closed');
  }
}
