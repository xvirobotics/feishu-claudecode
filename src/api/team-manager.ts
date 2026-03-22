import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { Logger } from '../utils/logger.js';

export interface Team {
  id: string;
  name: string;
  members: string[];      // bot names
  roles: Record<string, string>; // botName -> role
  budgetDailyUsd: number;
  createdAt: number;
  updatedAt: number;
}

export class TeamManager {
  private db: Database.Database;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ module: 'team-manager' });
    const dbDir = path.join(os.homedir(), '.metabot');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'teams.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        members TEXT NOT NULL DEFAULT '[]',
        roles TEXT NOT NULL DEFAULT '{}',
        budget_daily_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_memberships (
        group_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, bot_name)
      );
    `);
    this.logger.info('Team database initialized');
  }

  create(name: string, members: string[] = [], budgetDailyUsd: number = 0): Team {
    const id = `team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO teams (id, name, members, roles, budget_daily_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, JSON.stringify(members), '{}', budgetDailyUsd, now, now);
    return { id, name, members, roles: {}, budgetDailyUsd, createdAt: now, updatedAt: now };
  }

  get(id: string): Team | undefined {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as any;
    return row ? this.rowToTeam(row) : undefined;
  }

  getByName(name: string): Team | undefined {
    const row = this.db.prepare('SELECT * FROM teams WHERE name = ?').get(name) as any;
    return row ? this.rowToTeam(row) : undefined;
  }

  list(): Team[] {
    const rows = this.db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all() as any[];
    return rows.map(r => this.rowToTeam(r));
  }

  update(id: string, updates: Partial<Pick<Team, 'name' | 'members' | 'roles' | 'budgetDailyUsd'>>): Team | undefined {
    const team = this.get(id);
    if (!team) return undefined;

    const newName = updates.name ?? team.name;
    const newMembers = updates.members ?? team.members;
    const newRoles = updates.roles ?? team.roles;
    const newBudget = updates.budgetDailyUsd ?? team.budgetDailyUsd;
    const now = Date.now();

    this.db.prepare(
      'UPDATE teams SET name=?, members=?, roles=?, budget_daily_usd=?, updated_at=? WHERE id=?'
    ).run(newName, JSON.stringify(newMembers), JSON.stringify(newRoles), newBudget, now, id);

    return { ...team, name: newName, members: newMembers, roles: newRoles, budgetDailyUsd: newBudget, updatedAt: now };
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // --- Persistent group memberships (replace in-memory GroupManager) ---

  saveGroupMembership(groupId: string, botName: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO group_memberships (group_id, bot_name, joined_at) VALUES (?, ?, ?)'
    ).run(groupId, botName, Date.now());
  }

  getGroupMembers(groupId: string): string[] {
    const rows = this.db.prepare('SELECT bot_name FROM group_memberships WHERE group_id = ?').all(groupId) as any[];
    return rows.map(r => r.bot_name);
  }

  removeGroupMembership(groupId: string, botName: string): void {
    this.db.prepare('DELETE FROM group_memberships WHERE group_id = ? AND bot_name = ?').run(groupId, botName);
  }

  deleteGroup(groupId: string): void {
    this.db.prepare('DELETE FROM group_memberships WHERE group_id = ?').run(groupId);
  }

  private rowToTeam(row: any): Team {
    return {
      id: row.id,
      name: row.name,
      members: JSON.parse(row.members),
      roles: JSON.parse(row.roles),
      budgetDailyUsd: row.budget_daily_usd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  destroy(): void {
    this.db.close();
  }
}
