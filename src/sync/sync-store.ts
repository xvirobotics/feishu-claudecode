/**
 * Sync mapping store: tracks MetaMemory → Feishu Wiki sync state.
 * Uses SQLite (same DB as MetaMemory) for persistence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

export interface SyncMapping {
  memoryDocId: string;
  memoryPath: string;
  feishuNodeToken: string;
  feishuDocId: string;
  contentHash: string;
  syncedAt: string;
}

export interface FolderMapping {
  memoryFolderId: string;
  memoryPath: string;
  feishuNodeToken: string;
}

export interface SyncConfig {
  wikiSpaceId: string;
  rootNodeToken?: string;
  lastFullSyncAt?: string;
}

export class SyncStore {
  private db: Database.Database;

  constructor(databaseDir: string, private logger: Logger) {
    fs.mkdirSync(databaseDir, { recursive: true });
    const dbPath = path.join(databaseDir, 'sync-mapping.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.logger.info({ dbPath }, 'Sync store initialized');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_mappings (
        memory_doc_id      TEXT PRIMARY KEY,
        memory_path        TEXT NOT NULL,
        feishu_node_token  TEXT NOT NULL,
        feishu_doc_id      TEXT NOT NULL,
        content_hash       TEXT NOT NULL DEFAULT '',
        synced_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folder_mappings (
        memory_folder_id   TEXT PRIMARY KEY,
        memory_path        TEXT NOT NULL,
        feishu_node_token  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_doc_mappings_path ON document_mappings(memory_path);
      CREATE INDEX IF NOT EXISTS idx_folder_mappings_path ON folder_mappings(memory_path);
    `);
  }

  // --- Config ---

  getConfig(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO sync_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).run(key, value, value);
  }

  getWikiSpaceId(): string | undefined {
    return this.getConfig('wiki_space_id');
  }

  setWikiSpaceId(spaceId: string): void {
    this.setConfig('wiki_space_id', spaceId);
  }

  // --- Document mappings ---

  getDocMapping(memoryDocId: string): SyncMapping | undefined {
    const row = this.db.prepare('SELECT * FROM document_mappings WHERE memory_doc_id = ?').get(memoryDocId) as any;
    if (!row) return undefined;
    return {
      memoryDocId: row.memory_doc_id,
      memoryPath: row.memory_path,
      feishuNodeToken: row.feishu_node_token,
      feishuDocId: row.feishu_doc_id,
      contentHash: row.content_hash,
      syncedAt: row.synced_at,
    };
  }

  getDocMappingByPath(memoryPath: string): SyncMapping | undefined {
    const row = this.db.prepare('SELECT * FROM document_mappings WHERE memory_path = ?').get(memoryPath) as any;
    if (!row) return undefined;
    return {
      memoryDocId: row.memory_doc_id,
      memoryPath: row.memory_path,
      feishuNodeToken: row.feishu_node_token,
      feishuDocId: row.feishu_doc_id,
      contentHash: row.content_hash,
      syncedAt: row.synced_at,
    };
  }

  upsertDocMapping(mapping: SyncMapping): void {
    this.db.prepare(`
      INSERT INTO document_mappings (memory_doc_id, memory_path, feishu_node_token, feishu_doc_id, content_hash, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_doc_id) DO UPDATE SET
        memory_path = ?, feishu_node_token = ?, feishu_doc_id = ?, content_hash = ?, synced_at = ?
    `).run(
      mapping.memoryDocId, mapping.memoryPath, mapping.feishuNodeToken, mapping.feishuDocId, mapping.contentHash, mapping.syncedAt,
      mapping.memoryPath, mapping.feishuNodeToken, mapping.feishuDocId, mapping.contentHash, mapping.syncedAt,
    );
  }

  deleteDocMapping(memoryDocId: string): void {
    this.db.prepare('DELETE FROM document_mappings WHERE memory_doc_id = ?').run(memoryDocId);
  }

  getAllDocMappings(): SyncMapping[] {
    const rows = this.db.prepare('SELECT * FROM document_mappings').all() as any[];
    return rows.map((row) => ({
      memoryDocId: row.memory_doc_id,
      memoryPath: row.memory_path,
      feishuNodeToken: row.feishu_node_token,
      feishuDocId: row.feishu_doc_id,
      contentHash: row.content_hash,
      syncedAt: row.synced_at,
    }));
  }

  // --- Folder mappings ---

  getFolderMapping(memoryFolderId: string): FolderMapping | undefined {
    const row = this.db.prepare('SELECT * FROM folder_mappings WHERE memory_folder_id = ?').get(memoryFolderId) as any;
    if (!row) return undefined;
    return {
      memoryFolderId: row.memory_folder_id,
      memoryPath: row.memory_path,
      feishuNodeToken: row.feishu_node_token,
    };
  }

  upsertFolderMapping(mapping: FolderMapping): void {
    this.db.prepare(`
      INSERT INTO folder_mappings (memory_folder_id, memory_path, feishu_node_token)
      VALUES (?, ?, ?)
      ON CONFLICT(memory_folder_id) DO UPDATE SET
        memory_path = ?, feishu_node_token = ?
    `).run(
      mapping.memoryFolderId, mapping.memoryPath, mapping.feishuNodeToken,
      mapping.memoryPath, mapping.feishuNodeToken,
    );
  }

  deleteFolderMapping(memoryFolderId: string): void {
    this.db.prepare('DELETE FROM folder_mappings WHERE memory_folder_id = ?').run(memoryFolderId);
  }

  getAllFolderMappings(): FolderMapping[] {
    const rows = this.db.prepare('SELECT * FROM folder_mappings').all() as any[];
    return rows.map((row) => ({
      memoryFolderId: row.memory_folder_id,
      memoryPath: row.memory_path,
      feishuNodeToken: row.feishu_node_token,
    }));
  }

  // --- Stats ---

  getStats(): { documentCount: number; folderCount: number; wikiSpaceId: string | undefined } {
    const docCount = (this.db.prepare('SELECT COUNT(*) as count FROM document_mappings').get() as { count: number }).count;
    const folderCount = (this.db.prepare('SELECT COUNT(*) as count FROM folder_mappings').get() as { count: number }).count;
    return {
      documentCount: docCount,
      folderCount: folderCount,
      wikiSpaceId: this.getWikiSpaceId(),
    };
  }

  /** Clear all mappings (for full re-sync). */
  clearAll(): void {
    this.db.prepare('DELETE FROM document_mappings').run();
    this.db.prepare('DELETE FROM folder_mappings').run();
    this.db.prepare('DELETE FROM sync_config').run();
  }

  close(): void {
    this.db.close();
    this.logger.info('Sync store closed');
  }
}
