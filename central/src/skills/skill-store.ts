import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export type Visibility = 'private' | 'published' | 'shared';

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  ownerBotName?: string;
  ownerCredentialId?: string;
  visibility: Visibility;
  contentHash: string;
  tags: string[];
  userInvocable: boolean;
  context?: string;
  allowedTools?: string;
  skillMd: string;
  hasReferences: boolean;
  publishedAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  ownerBotName?: string;
  visibility: Visibility;
  contentHash: string;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
}

export interface SkillSearchResult extends SkillSummary {
  snippet: string;
}

export interface SkillPublishInput {
  name: string;
  skillMd: string;
  referencesTar?: Buffer;
  author?: string;
  ownerBotName?: string;
  ownerCredentialId?: string;
  visibility?: Visibility;
}

export interface ListOptions {
  visibility?: Visibility[];
}

function parseFrontmatter(content: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }
  return meta;
}

function computeContentHash(skillMd: string, referencesTar?: Buffer): string {
  const hash = crypto.createHash('sha256');
  hash.update(skillMd);
  if (referencesTar) hash.update(referencesTar);
  return hash.digest('hex');
}

export class SkillStore {
  private db: Database.Database;
  private logger: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        version              INTEGER NOT NULL DEFAULT 1,
        author               TEXT NOT NULL DEFAULT '',
        owner_bot_name       TEXT,
        owner_credential_id  TEXT,
        visibility           TEXT NOT NULL DEFAULT 'published',
        content_hash         TEXT NOT NULL DEFAULT '',
        tags                 TEXT NOT NULL DEFAULT '[]',
        user_invocable       INTEGER NOT NULL DEFAULT 1,
        context              TEXT,
        allowed_tools        TEXT,
        skill_md             TEXT NOT NULL,
        references_tar       BLOB,
        published_at         TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS skills_visibility_idx ON skills(visibility);
      CREATE INDEX IF NOT EXISTS skills_owner_idx ON skills(owner_credential_id);
    `);

    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skills_fts'",
    ).get();
    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE skills_fts USING fts5(
          name, description, tags, skill_md,
          content='skills',
          content_rowid='rowid'
        );

        CREATE TRIGGER skills_ai AFTER INSERT ON skills BEGIN
          INSERT INTO skills_fts(rowid, name, description, tags, skill_md)
          VALUES (new.rowid, new.name, new.description, new.tags, new.skill_md);
        END;

        CREATE TRIGGER skills_au AFTER UPDATE ON skills BEGIN
          INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, skill_md)
          VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.skill_md);
          INSERT INTO skills_fts(rowid, name, description, tags, skill_md)
          VALUES (new.rowid, new.name, new.description, new.tags, new.skill_md);
        END;

        CREATE TRIGGER skills_ad AFTER DELETE ON skills BEGIN
          INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, skill_md)
          VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.skill_md);
        END;
      `);
    }
  }

  publish(input: SkillPublishInput): SkillRecord {
    const meta = parseFrontmatter(input.skillMd);
    const name = input.name || meta['name'] || 'unnamed-skill';
    const description = meta['description'] || '';
    const tags = meta['tags'] ? meta['tags'].split(',').map((t) => t.trim()) : [];
    const userInvocable = meta['user-invocable'] !== 'false';
    const context = meta['context'] || undefined;
    const allowedTools = meta['allowed-tools'] || undefined;
    const visibility = input.visibility || 'published';
    const contentHash = computeContentHash(input.skillMd, input.referencesTar);
    const now = new Date().toISOString();

    const existing = this.db.prepare('SELECT id, version FROM skills WHERE name = ?').get(name) as
      | { id: string; version: number }
      | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE skills SET
          description = ?, version = ?, author = ?, owner_bot_name = ?,
          owner_credential_id = ?, visibility = ?, content_hash = ?, tags = ?,
          user_invocable = ?, context = ?, allowed_tools = ?,
          skill_md = ?, references_tar = ?, updated_at = ?
        WHERE name = ?
      `).run(
        description, existing.version + 1, input.author || '',
        input.ownerBotName || null, input.ownerCredentialId || null,
        visibility, contentHash, JSON.stringify(tags),
        userInvocable ? 1 : 0, context || null, allowedTools || null,
        input.skillMd, input.referencesTar || null, now, name,
      );
      this.logger.info({ name, version: existing.version + 1 }, 'skill updated');
      return this.get(name)!;
    }

    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO skills (id, name, description, version, author,
        owner_bot_name, owner_credential_id, visibility, content_hash, tags,
        user_invocable, context, allowed_tools, skill_md, references_tar,
        published_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, description, input.author || '',
      input.ownerBotName || null, input.ownerCredentialId || null,
      visibility, contentHash, JSON.stringify(tags),
      userInvocable ? 1 : 0, context || null, allowedTools || null,
      input.skillMd, input.referencesTar || null, now, now,
    );
    this.logger.info({ name, id }, 'skill published');
    return this.get(name)!;
  }

  get(name: string): SkillRecord | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as RawSkillRow | undefined;
    if (!row) return undefined;
    return rowToRecord(row);
  }

  getContent(name: string): { skillMd: string; referencesTar?: Buffer } | undefined {
    const row = this.db.prepare('SELECT skill_md, references_tar FROM skills WHERE name = ?').get(name) as
      | { skill_md: string; references_tar: Buffer | null }
      | undefined;
    if (!row) return undefined;
    return {
      skillMd: row.skill_md,
      referencesTar: row.references_tar || undefined,
    };
  }

  list(options?: ListOptions): SkillSummary[] {
    const { sql, params } = applyVisibilityFilter(
      `SELECT id, name, description, version, author, owner_bot_name,
              visibility, content_hash, tags,
              published_at, updated_at
       FROM skills`,
      options?.visibility,
    );
    const rows = this.db.prepare(`${sql} ORDER BY updated_at DESC`).all(...params) as RawSkillSummaryRow[];
    return rows.map(summaryRowToRecord);
  }

  search(query: string, options?: ListOptions): SkillSearchResult[] {
    const escaped = escapeFts5Query(query);
    if (!escaped) return this.list(options).map((s) => ({ ...s, snippet: '' }));

    const { sql, params } = applyVisibilityFilter(
      `SELECT s.id, s.name, s.description, s.version, s.author,
              s.owner_bot_name, s.visibility,
              s.content_hash, s.tags,
              s.published_at, s.updated_at,
              snippet(skills_fts, 3, '<b>', '</b>', '...', 32) AS snippet
       FROM skills_fts f
       JOIN skills s ON s.rowid = f.rowid
       WHERE skills_fts MATCH ?`,
      options?.visibility,
      's.visibility',
    );
    const rows = this.db.prepare(`${sql} ORDER BY rank`).all(escaped, ...params) as (RawSkillSummaryRow & { snippet: string | null })[];
    return rows.map((row) => ({
      ...summaryRowToRecord(row),
      snippet: row.snippet || '',
    }));
  }

  remove(name: string): boolean {
    const result = this.db.prepare('DELETE FROM skills WHERE name = ?').run(name);
    if (result.changes > 0) {
      this.logger.info({ name }, 'skill removed');
      return true;
    }
    return false;
  }
}

interface RawSkillRow {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  owner_bot_name: string | null;
  owner_credential_id: string | null;
  visibility: Visibility;
  content_hash: string;
  tags: string;
  user_invocable: 0 | 1;
  context: string | null;
  allowed_tools: string | null;
  skill_md: string;
  references_tar: Buffer | null;
  published_at: string;
  updated_at: string;
}

interface RawSkillSummaryRow {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  owner_bot_name: string | null;
  visibility: Visibility;
  content_hash: string;
  tags: string;
  published_at: string;
  updated_at: string;
}

function rowToRecord(row: RawSkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    author: row.author,
    ownerBotName: row.owner_bot_name || undefined,
    ownerCredentialId: row.owner_credential_id || undefined,
    visibility: row.visibility,
    contentHash: row.content_hash,
    tags: safeJsonArray(row.tags),
    userInvocable: row.user_invocable === 1,
    context: row.context || undefined,
    allowedTools: row.allowed_tools || undefined,
    skillMd: row.skill_md,
    hasReferences: !!row.references_tar,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

function summaryRowToRecord(row: RawSkillSummaryRow): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    author: row.author,
    ownerBotName: row.owner_bot_name || undefined,
    visibility: row.visibility,
    contentHash: row.content_hash,
    tags: safeJsonArray(row.tags),
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function applyVisibilityFilter(
  baseSql: string,
  visibility: Visibility[] | undefined,
  column = 'visibility',
): { sql: string; params: string[] } {
  if (!visibility || visibility.length === 0) {
    return { sql: baseSql, params: [] };
  }
  const placeholders = visibility.map(() => '?').join(', ');
  const connector = /\bWHERE\b/i.test(baseSql) ? 'AND' : 'WHERE';
  return {
    sql: `${baseSql} ${connector} ${column} IN (${placeholders})`,
    params: visibility,
  };
}

function escapeFts5Query(query: string): string {
  return query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}
