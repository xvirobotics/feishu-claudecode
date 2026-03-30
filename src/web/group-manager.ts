/**
 * Server-side group manager: stores groups with bot members and human users.
 * Persisted to SQLite so groups survive restarts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';

export interface ChatGroup {
  id: string;
  name: string;
  members: string[];     // bot names
  users: string[];       // human user IDs
  creatorId: string;     // who created the group
  createdAt: number;
}

export class GroupManager {
  private db: Database.Database;

  constructor() {
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'groups.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        creator_id TEXT NOT NULL DEFAULT 'admin',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_bot_members (
        group_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        PRIMARY KEY (group_id, bot_name),
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS group_user_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      );
    `);
  }

  create(name: string, members: string[], creatorId: string = 'admin', users: string[] = []): ChatGroup {
    const id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();

    const insertGroup = this.db.prepare('INSERT INTO groups (id, name, creator_id, created_at) VALUES (?, ?, ?, ?)');
    const insertBot = this.db.prepare('INSERT INTO group_bot_members (group_id, bot_name) VALUES (?, ?)');
    const insertUser = this.db.prepare('INSERT INTO group_user_members (group_id, user_id) VALUES (?, ?)');

    this.db.transaction(() => {
      insertGroup.run(id, name, creatorId, now);
      for (const bot of members) {
        insertBot.run(id, bot);
      }
      // Always add creator as a user member
      if (creatorId !== 'admin') {
        insertUser.run(id, creatorId);
      }
      for (const uid of users) {
        if (uid !== creatorId) {
          insertUser.run(id, uid);
        }
      }
    })();

    return { id, name, members, users: [...new Set([...(creatorId !== 'admin' ? [creatorId] : []), ...users])], creatorId, createdAt: now };
  }

  get(id: string): ChatGroup | undefined {
    const row = this.db.prepare('SELECT id, name, creator_id, created_at FROM groups WHERE id = ?').get(id) as any;
    if (!row) return undefined;

    const bots = this.db.prepare('SELECT bot_name FROM group_bot_members WHERE group_id = ?').all(id) as any[];
    const users = this.db.prepare('SELECT user_id FROM group_user_members WHERE group_id = ?').all(id) as any[];

    return {
      id: row.id,
      name: row.name,
      members: bots.map((b: any) => b.bot_name),
      users: users.map((u: any) => u.user_id),
      creatorId: row.creator_id,
      createdAt: row.created_at,
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    return result.changes > 0;
  }

  list(): ChatGroup[] {
    const rows = this.db.prepare('SELECT id, name, creator_id, created_at FROM groups ORDER BY created_at DESC').all() as any[];
    return rows.map((row: any) => {
      const bots = this.db.prepare('SELECT bot_name FROM group_bot_members WHERE group_id = ?').all(row.id) as any[];
      const users = this.db.prepare('SELECT user_id FROM group_user_members WHERE group_id = ?').all(row.id) as any[];
      return {
        id: row.id,
        name: row.name,
        members: bots.map((b: any) => b.bot_name),
        users: users.map((u: any) => u.user_id),
        creatorId: row.creator_id,
        createdAt: row.created_at,
      };
    });
  }

  /** List groups that a specific user is a member of. */
  listByUser(userId: string): ChatGroup[] {
    const rows = this.db.prepare(`
      SELECT g.id, g.name, g.creator_id, g.created_at
      FROM groups g
      JOIN group_user_members m ON g.id = m.group_id
      WHERE m.user_id = ?
      ORDER BY g.created_at DESC
    `).all(userId) as any[];

    return rows.map((row: any) => {
      const bots = this.db.prepare('SELECT bot_name FROM group_bot_members WHERE group_id = ?').all(row.id) as any[];
      const users = this.db.prepare('SELECT user_id FROM group_user_members WHERE group_id = ?').all(row.id) as any[];
      return {
        id: row.id,
        name: row.name,
        members: bots.map((b: any) => b.bot_name),
        users: users.map((u: any) => u.user_id),
        creatorId: row.creator_id,
        createdAt: row.created_at,
      };
    });
  }

  /** Add a user to a group. */
  addUser(groupId: string, userId: string): boolean {
    try {
      this.db.prepare('INSERT OR IGNORE INTO group_user_members (group_id, user_id) VALUES (?, ?)').run(groupId, userId);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove a user from a group. */
  removeUser(groupId: string, userId: string): boolean {
    const result = this.db.prepare('DELETE FROM group_user_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    return result.changes > 0;
  }
}
