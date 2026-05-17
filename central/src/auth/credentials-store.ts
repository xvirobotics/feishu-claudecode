import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import {
  Credential,
  CredentialPublic,
  IssueInput,
  IssueResult,
  Role,
  generateToken,
  hashToken,
  toPublic,
} from './credentials.js';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  cred: Credential | null;
  expiresAt: number;
}

export class CredentialsStore {
  private db: Database.Database;
  private logger: Logger;
  private cache = new Map<string, CacheEntry>();
  private pendingLastUsed = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id                   TEXT PRIMARY KEY,
        token_hash           TEXT NOT NULL UNIQUE,
        bot_name             TEXT NOT NULL,
        owner_name           TEXT NOT NULL,
        role                 TEXT NOT NULL CHECK(role IN ('admin', 'member')),
        writable_namespaces  TEXT NOT NULL DEFAULT '[]',
        readable_namespaces  TEXT NOT NULL DEFAULT '[]',
        publish_skill        INTEGER NOT NULL DEFAULT 0,
        created_at           INTEGER NOT NULL,
        revoked_at           INTEGER,
        last_used_at         INTEGER,
        notes                TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS credentials_token_hash_idx
        ON credentials(token_hash);
      CREATE INDEX IF NOT EXISTS credentials_bot_name_idx
        ON credentials(bot_name);
    `);
  }

  /** Issue a new credential. Returns the public record + one-time token. */
  issue(input: IssueInput): IssueResult {
    const role: Role = input.role;
    const token = generateToken(role);
    const tokenHash = hashToken(token);
    const id = crypto.randomUUID();
    const now = Date.now();

    const writable = input.writableNamespaces ?? defaultWritable(input, role);
    const readable = input.readableNamespaces ?? defaultReadable(input, role);
    const publishSkill = input.publishSkill ?? (role === 'admin');

    this.db.prepare(`
      INSERT INTO credentials
        (id, token_hash, bot_name, owner_name, role,
         writable_namespaces, readable_namespaces, publish_skill,
         created_at, revoked_at, last_used_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      id, tokenHash, input.botName, input.ownerName, role,
      JSON.stringify(writable), JSON.stringify(readable),
      publishSkill ? 1 : 0, now, input.notes ?? '',
    );

    const cred = this.findById(id)!;
    this.logger.info({ id, botName: input.botName, role }, 'credential issued');
    return { credential: toPublic(cred), token };
  }

  /**
   * Look up by token (sha256-hashed). Cached for 60s.
   * Returns the credential regardless of revoked state — callers must check
   * `revokedAt` themselves so they can distinguish unknown vs revoked tokens.
   */
  lookupByToken(token: string): Credential | null {
    const tokenHash = hashToken(token);
    const cached = this.cache.get(tokenHash);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.cred;
    }
    const cred = this.findByTokenHash(tokenHash);
    this.cache.set(tokenHash, { cred, expiresAt: now + CACHE_TTL_MS });
    return cred;
  }

  /** Mark a credential as revoked. Returns revokedAt ms, or null if missing. */
  revoke(credentialId: string): number | null {
    const now = Date.now();
    const result = this.db.prepare(
      'UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(now, credentialId);
    if (result.changes === 0) {
      const exists = this.db.prepare('SELECT revoked_at FROM credentials WHERE id = ?').get(credentialId) as { revoked_at: number } | undefined;
      if (!exists) return null;
      return exists.revoked_at;
    }
    this.invalidateCacheById(credentialId);
    this.logger.info({ credentialId, revokedAt: now }, 'credential revoked');
    return now;
  }

  /** List all credentials (public view, no tokenHash). */
  list(): CredentialPublic[] {
    const rows = this.db.prepare('SELECT * FROM credentials ORDER BY created_at DESC').all() as RawCredRow[];
    return rows.map((r) => toPublic(rowToCredential(r)));
  }

  /** Find by id (full record incl. tokenHash). Used internally + by tests. */
  findById(id: string): Credential | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as RawCredRow | undefined;
    return row ? rowToCredential(row) : null;
  }

  /** Has any admin been bootstrapped? */
  hasAdmin(): boolean {
    const row = this.db.prepare(
      "SELECT id FROM credentials WHERE role = 'admin' AND revoked_at IS NULL LIMIT 1",
    ).get();
    return !!row;
  }

  /**
   * Bootstrap the very first admin on an empty DB. Writes the one-time token
   * to `tokenFilePath` (chmod 600) and returns it for stdout logging.
   * No-op + returns null if an admin already exists.
   */
  bootstrapAdmin(tokenFilePath: string): string | null {
    if (this.hasAdmin()) return null;
    const { token } = this.issue({
      botName: 'central-admin',
      ownerName: 'bootstrap',
      role: 'admin',
      writableNamespaces: ['/'],
      readableNamespaces: ['/'],
      publishSkill: true,
      notes: 'auto-bootstrapped on first startup',
    });
    try {
      fs.writeFileSync(tokenFilePath, token + '\n', { mode: 0o600 });
    } catch (err) {
      this.logger.warn({ err, tokenFilePath }, 'failed to write admin bootstrap token file');
    }
    return token;
  }

  /** Defer last_used_at writes — coalesced and flushed every 5s. */
  touchLastUsed(credentialId: string): void {
    this.pendingLastUsed.set(credentialId, Date.now());
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushLastUsed(), 5000);
  }

  flushLastUsed(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingLastUsed.size === 0) return;
    const stmt = this.db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?');
    const tx = this.db.transaction((entries: [string, number][]) => {
      for (const [id, ts] of entries) stmt.run(ts, id);
    });
    tx([...this.pendingLastUsed.entries()]);
    this.pendingLastUsed.clear();
  }

  close(): void {
    this.flushLastUsed();
  }

  private findByTokenHash(tokenHash: string): Credential | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE token_hash = ?').get(tokenHash) as RawCredRow | undefined;
    return row ? rowToCredential(row) : null;
  }

  private invalidateCacheById(credentialId: string): void {
    for (const [hash, entry] of this.cache.entries()) {
      if (entry.cred && entry.cred.id === credentialId) {
        this.cache.delete(hash);
      }
    }
  }
}

interface RawCredRow {
  id: string;
  token_hash: string;
  bot_name: string;
  owner_name: string;
  role: 'admin' | 'member';
  writable_namespaces: string;
  readable_namespaces: string;
  publish_skill: 0 | 1;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  notes: string;
}

function rowToCredential(row: RawCredRow): Credential {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    botName: row.bot_name,
    ownerName: row.owner_name,
    role: row.role,
    writableNamespaces: safeJsonArray(row.writable_namespaces),
    readableNamespaces: safeJsonArray(row.readable_namespaces),
    publishSkill: row.publish_skill === 1,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    notes: row.notes,
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

function defaultWritable(input: IssueInput, role: Role): string[] {
  if (role === 'admin') return ['/'];
  return [`/users/${input.botName}`];
}

function defaultReadable(input: IssueInput, role: Role): string[] {
  if (role === 'admin') return ['/'];
  return ['/shared', `/users/${input.botName}`];
}
