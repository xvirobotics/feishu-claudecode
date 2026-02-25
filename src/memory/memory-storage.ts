import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

// --- Types ---

export type Role = 'admin' | 'reader';
export type Visibility = 'shared' | 'private';

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  visibility: Visibility;
  created_at: string;
  updated_at: string;
}

export interface FolderTreeNode {
  id: string;
  name: string;
  path: string;
  visibility: Visibility;
  children: FolderTreeNode[];
  document_count: number;
}

export interface Document {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content: string;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  snippet: string;
  tags: string[];
  created_by: string;
  updated_at: string;
}

export interface DocumentCreateInput {
  title: string;
  folder_id?: string;
  content?: string;
  tags?: string[];
  created_by?: string;
}

export interface DocumentUpdateInput {
  title?: string;
  content?: string;
  tags?: string[];
  folder_id?: string;
}

// --- Helpers ---

function generateId(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/ /g, '-');
}

export function escapeFts5Query(query: string): string {
  const tokens = query.trim().split(/\s+/);
  const escaped: string[] = [];
  for (const token of tokens) {
    const clean = token.replace(/"/g, '');
    if (clean) {
      escaped.push(`"${clean}"`);
    }
  }
  return escaped.length > 0 ? escaped.join(' ') : '""';
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore */ }
  }
  return [];
}

// --- Storage Class ---

export class MemoryStorage {
  private db: Database.Database;
  private logger: Logger;

  constructor(databaseDir: string, logger: Logger) {
    this.logger = logger;

    // Ensure directory exists
    fs.mkdirSync(databaseDir, { recursive: true });

    const dbPath = path.join(databaseDir, 'metamemory.db');
    this.db = new Database(dbPath);

    // Set pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
    this.logger.info({ dbPath }, 'MetaMemory storage initialized');
  }

  private initSchema(): void {
    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        parent_id  TEXT REFERENCES folders(id),
        path       TEXT UNIQUE NOT NULL,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS documents (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        folder_id  TEXT NOT NULL DEFAULT 'root' REFERENCES folders(id),
        path       TEXT UNIQUE NOT NULL,
        content    TEXT DEFAULT '',
        tags       TEXT DEFAULT '[]',
        created_by TEXT DEFAULT '',
        created_at TEXT,
        updated_at TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title, content, tags, doc_id UNINDEXED
      );

      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(doc_id, title, content, tags)
        VALUES (new.id, new.title, new.content, COALESCE(json_extract(new.tags, '$'), ''));
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
        INSERT INTO documents_fts(doc_id, title, content, tags)
        VALUES (new.id, new.title, new.content, COALESCE(json_extract(new.tags, '$'), ''));
      END;
    `);

    // Migration: add visibility column if not exists
    const cols = this.db.prepare("PRAGMA table_info('folders')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'visibility')) {
      this.db.exec("ALTER TABLE folders ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'");
      this.logger.info('Migration: added visibility column to folders');
    }

    // Seed root folder if not exists
    const root = this.db.prepare('SELECT id FROM folders WHERE id = ?').get('root');
    if (!root) {
      const now = nowISO();
      this.db.prepare(
        'INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('root', 'Root', null, '/', 'shared', now, now);
    }
  }

  // --- Folder operations ---

  private computeFolderPath(parentId: string, name: string): string {
    const parent = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(parentId) as { path: string } | undefined;
    if (!parent) throw new Error(`Parent folder not found: ${parentId}`);
    const parentPath = parent.path.replace(/\/+$/, '');
    return `${parentPath}/${name}`;
  }

  createFolder(name: string, parentId = 'root', visibility: Visibility = 'shared'): Folder {
    const folderPath = this.computeFolderPath(parentId, name);

    // Check for existing folder with same path (idempotent)
    const existing = this.db.prepare('SELECT * FROM folders WHERE path = ?').get(folderPath) as Folder | undefined;
    if (existing) return existing;

    const now = nowISO();
    const id = generateId();
    this.db.prepare(
      'INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, name, parentId, folderPath, visibility, now, now);

    return { id, name, parent_id: parentId, path: folderPath, visibility, created_at: now, updated_at: now };
  }

  getFolderTree(role: Role = 'admin'): FolderTreeNode {
    const folders = this.db.prepare('SELECT * FROM folders').all() as Folder[];
    const docCounts = this.db.prepare(
      'SELECT folder_id, COUNT(*) as count FROM documents GROUP BY folder_id',
    ).all() as { folder_id: string; count: number }[];

    const countMap = new Map<string, number>();
    for (const row of docCounts) {
      countMap.set(row.folder_id, row.count);
    }

    // Filter folders by role: readers can only see shared folders
    const visibleFolders = role === 'admin' ? folders : folders.filter((f) => f.visibility !== 'private');
    const visibleIds = new Set(visibleFolders.map((f) => f.id));

    // Build tree
    const nodeMap = new Map<string, FolderTreeNode>();
    for (const f of visibleFolders) {
      nodeMap.set(f.id, {
        id: f.id,
        name: f.name,
        path: f.path,
        visibility: f.visibility || 'shared',
        children: [],
        document_count: countMap.get(f.id) || 0,
      });
    }

    let root: FolderTreeNode | undefined;
    for (const f of visibleFolders) {
      const node = nodeMap.get(f.id)!;
      if (f.parent_id && nodeMap.has(f.parent_id)) {
        nodeMap.get(f.parent_id)!.children.push(node);
      } else if (!f.parent_id || f.id === 'root') {
        root = node;
      }
    }

    return root || { id: 'root', name: 'Root', path: '/', visibility: 'shared', children: [], document_count: 0 };
  }

  deleteFolder(folderId: string): void {
    if (folderId === 'root') throw new Error('Cannot delete root folder');
    const folder = this.db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
    if (!folder) throw new Error(`Folder not found: ${folderId}`);

    // Delete documents in this folder first (cascade manually since SQLite FK cascade may not cover triggers)
    this.db.prepare('DELETE FROM documents WHERE folder_id = ?').run(folderId);
    // Delete child folders recursively
    const children = this.db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(folderId) as { id: string }[];
    for (const child of children) {
      this.deleteFolder(child.id);
    }
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
  }

  /** Check if a folder is accessible by the given role. */
  isFolderAccessible(folderId: string, role: Role): boolean {
    if (role === 'admin') return true;
    const folder = this.db.prepare('SELECT visibility FROM folders WHERE id = ?').get(folderId) as { visibility: string } | undefined;
    if (!folder) return false;
    return folder.visibility !== 'private';
  }

  /** Get set of folder IDs accessible by the given role. */
  getAccessibleFolderIds(role: Role): Set<string> {
    if (role === 'admin') {
      const rows = this.db.prepare('SELECT id FROM folders').all() as { id: string }[];
      return new Set(rows.map((r) => r.id));
    }
    const rows = this.db.prepare("SELECT id FROM folders WHERE visibility != 'private'").all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /** Update folder visibility (admin only). */
  updateFolder(folderId: string, data: { visibility?: Visibility }): Folder | null {
    const existing = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as Folder | undefined;
    if (!existing) return null;
    const visibility = data.visibility ?? existing.visibility;
    const now = nowISO();
    this.db.prepare('UPDATE folders SET visibility = ?, updated_at = ? WHERE id = ?').run(visibility, now, folderId);
    return { ...existing, visibility, updated_at: now };
  }

  // --- Document operations ---

  private computeDocPath(folderId: string, title: string): string {
    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | undefined;
    if (!folder) throw new Error(`Folder not found: ${folderId}`);
    const folderPath = folder.path.replace(/\/+$/, '');
    return `${folderPath}/${slugify(title)}`;
  }

  createDocument(data: DocumentCreateInput, role: Role = 'admin'): Document {
    const folderId = data.folder_id || 'root';
    if (!this.isFolderAccessible(folderId, role)) {
      throw new Error('Access denied: cannot create document in private folder');
    }
    const docPath = this.computeDocPath(folderId, data.title);
    const now = nowISO();
    const id = generateId();
    const tags = JSON.stringify(data.tags || []);

    this.db.prepare(
      'INSERT INTO documents (id, title, folder_id, path, content, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, data.title, folderId, docPath, data.content || '', tags, data.created_by || '', now, now);

    return {
      id,
      title: data.title,
      folder_id: folderId,
      path: docPath,
      content: data.content || '',
      tags: data.tags || [],
      created_by: data.created_by || '',
      created_at: now,
      updated_at: now,
    };
  }

  getDocument(docId: string, role: Role = 'admin'): Document | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as (Omit<Document, 'tags'> & { tags: string }) | undefined;
    if (!row) return null;
    if (!this.isFolderAccessible(row.folder_id, role)) return null;
    return { ...row, tags: parseTags(row.tags) };
  }

  getDocumentByPath(docPath: string, role: Role = 'admin'): Document | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE path = ?').get(docPath) as (Omit<Document, 'tags'> & { tags: string }) | undefined;
    if (!row) return null;
    if (!this.isFolderAccessible(row.folder_id, role)) return null;
    return { ...row, tags: parseTags(row.tags) };
  }

  listDocuments(folderId?: string, limit = 50, offset = 0, role: Role = 'admin'): DocumentSummary[] {
    let rows: any[];
    if (folderId) {
      // Check access to the specific folder
      if (!this.isFolderAccessible(folderId, role)) return [];
      rows = this.db.prepare(
        'SELECT id, title, folder_id, path, tags, created_by, created_at, updated_at FROM documents WHERE folder_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      ).all(folderId, limit, offset);
    } else if (role === 'admin') {
      rows = this.db.prepare(
        'SELECT id, title, folder_id, path, tags, created_by, created_at, updated_at FROM documents ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      ).all(limit, offset);
    } else {
      // Reader: only documents in shared folders
      rows = this.db.prepare(
        `SELECT d.id, d.title, d.folder_id, d.path, d.tags, d.created_by, d.created_at, d.updated_at
         FROM documents d JOIN folders f ON d.folder_id = f.id
         WHERE f.visibility != 'private'
         ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`,
      ).all(limit, offset);
    }
    return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
  }

  updateDocument(docId: string, data: DocumentUpdateInput, role: Role = 'admin'): Document | null {
    const existing = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as (Omit<Document, 'tags'> & { tags: string }) | undefined;
    if (!existing) return null;
    if (!this.isFolderAccessible(existing.folder_id, role)) return null;

    const title = data.title ?? existing.title;
    const content = data.content ?? existing.content;
    const tags = data.tags ?? parseTags(existing.tags);
    const folderId = data.folder_id ?? existing.folder_id;

    // Recompute path if title or folder changed
    let docPath = existing.path;
    if (data.title !== undefined || data.folder_id !== undefined) {
      docPath = this.computeDocPath(folderId, title);
    }

    const now = nowISO();
    this.db.prepare(
      'UPDATE documents SET title = ?, content = ?, tags = ?, folder_id = ?, path = ?, updated_at = ? WHERE id = ?',
    ).run(title, content, JSON.stringify(tags), folderId, docPath, now, docId);

    return {
      id: docId,
      title,
      folder_id: folderId,
      path: docPath,
      content,
      tags,
      created_by: existing.created_by,
      created_at: existing.created_at,
      updated_at: now,
    };
  }

  deleteDocument(docId: string, role: Role = 'admin'): boolean {
    if (role !== 'admin') {
      // Check if document is in an accessible folder
      const doc = this.db.prepare('SELECT folder_id FROM documents WHERE id = ?').get(docId) as { folder_id: string } | undefined;
      if (!doc || !this.isFolderAccessible(doc.folder_id, role)) return false;
    }
    const result = this.db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    return result.changes > 0;
  }

  // --- Search ---

  searchDocuments(query: string, limit = 20, role: Role = 'admin'): SearchResult[] {
    const escaped = escapeFts5Query(query);
    let rows: any[];
    if (role === 'admin') {
      rows = this.db.prepare(`
        SELECT d.id, d.title, d.path, d.tags, d.created_by, d.updated_at,
               snippet(documents_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
        FROM documents_fts fts
        JOIN documents d ON d.id = fts.doc_id
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(escaped, limit) as any[];
    } else {
      rows = this.db.prepare(`
        SELECT d.id, d.title, d.path, d.tags, d.created_by, d.updated_at,
               snippet(documents_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
        FROM documents_fts fts
        JOIN documents d ON d.id = fts.doc_id
        JOIN folders f ON d.folder_id = f.id
        WHERE documents_fts MATCH ? AND f.visibility != 'private'
        ORDER BY rank
        LIMIT ?
      `).all(escaped, limit) as any[];
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      snippet: r.snippet || '',
      tags: parseTags(r.tags),
      created_by: r.created_by || '',
      updated_at: r.updated_at,
    }));
  }

  // --- Stats ---

  getStats(): { document_count: number; folder_count: number } {
    const docCount = (this.db.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number }).count;
    const folderCount = (this.db.prepare('SELECT COUNT(*) as count FROM folders').get() as { count: number }).count;
    return { document_count: docCount, folder_count: folderCount };
  }

  // --- Lifecycle ---

  close(): void {
    this.db.close();
    this.logger.info('MetaMemory storage closed');
  }
}
