/**
 * User store: SQLite-backed user management with registration and token auth.
 * Supports self-registration and admin user management.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  avatarColor: string;
  token: string;
  createdAt: number;
}

export type UserPublic = Omit<User, 'passwordHash'>;

// Avatar color palette
const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#ef4444', '#f97316', '#eab308', '#84cc16',
  '#22c55e', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6',
];

function pickAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function generateToken(): string {
  return `mb-${crypto.randomBytes(24).toString('base64url')}`;
}

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export class UserStore {
  private db: Database.Database;

  constructor(
    private logger: Logger,
    private adminSecret?: string,
  ) {
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'users.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.logger.info({ dbPath }, 'User store initialized');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        avatar_color TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    `);
  }

  /** Register a new user. Returns the user or throws on duplicate username. */
  register(username: string, password: string, displayName?: string, role: 'admin' | 'user' = 'user'): User {
    const id = crypto.randomUUID();
    const token = generateToken();
    const avatarColor = pickAvatarColor(username);
    const passwordHash = hashPassword(password);
    const now = Date.now();
    const name = displayName || username;

    try {
      this.db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, role, avatar_color, token, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, username, name, passwordHash, role, avatarColor, token, now);
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE')) {
        throw new Error(`Username "${username}" is already taken`, { cause: err });
      }
      throw err;
    }

    this.logger.info({ userId: id, username, role }, 'User registered');
    return { id, username, displayName: name, role, avatarColor, token, createdAt: now };
  }

  /** Login with username + password. Returns user with token or null. */
  login(username: string, password: string): User | null {
    const row = this.db.prepare(`
      SELECT id, username, display_name, password_hash, role, avatar_color, token, created_at
      FROM users WHERE username = ?
    `).get(username) as any;

    if (!row) return null;
    if (row.password_hash !== hashPassword(password)) return null;

    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      avatarColor: row.avatar_color,
      token: row.token,
      createdAt: row.created_at,
    };
  }

  /** Validate a token. Returns user if valid, null otherwise. Also checks admin secret. */
  validateToken(token: string): User | null {
    // Check admin secret first (backward compatible)
    if (this.adminSecret && token === this.adminSecret) {
      return {
        id: 'admin',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        avatarColor: '#6366f1',
        token: this.adminSecret,
        createdAt: 0,
      };
    }

    const row = this.db.prepare(`
      SELECT id, username, display_name, role, avatar_color, token, created_at
      FROM users WHERE token = ?
    `).get(token) as any;

    if (!row) return null;

    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      avatarColor: row.avatar_color,
      token: row.token,
      createdAt: row.created_at,
    };
  }

  /** Get user by ID. */
  getById(id: string): User | null {
    const row = this.db.prepare(`
      SELECT id, username, display_name, role, avatar_color, token, created_at
      FROM users WHERE id = ?
    `).get(id) as any;

    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      avatarColor: row.avatar_color,
      token: row.token,
      createdAt: row.created_at,
    };
  }

  /** List all users (public info only, no tokens). */
  listUsers(): Omit<User, 'token'>[] {
    const rows = this.db.prepare(`
      SELECT id, username, display_name, role, avatar_color, created_at
      FROM users ORDER BY created_at DESC
    `).all() as any[];

    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      avatarColor: r.avatar_color,
      createdAt: r.created_at,
    }));
  }

  /** Delete a user. Admin only. */
  deleteUser(id: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Regenerate token for a user. */
  regenerateToken(id: string): string | null {
    const newToken = generateToken();
    const result = this.db.prepare('UPDATE users SET token = ? WHERE id = ?').run(newToken, id);
    if (result.changes === 0) return null;
    return newToken;
  }

  /** Get user count. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any;
    return row.cnt;
  }
}
