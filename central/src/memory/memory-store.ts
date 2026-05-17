import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Credential } from '../auth/credentials.js';
import { canReadPath, canWritePath, joinPath, normalizePath, readableRoots } from './acl.js';

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  created_at: string;
  updated_at: string;
}

export interface FolderTreeNode {
  id: string;
  name: string;
  path: string;
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
  path?: string;
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

export interface FolderCreateInput {
  name: string;
  parent_id?: string;
  path?: string;
}

function nowISO(): string {
  return new Date().toISOString();
}

function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

export function escapeFts5Query(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ') || '""';
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore */ }
  }
  return [];
}

export class MemoryStore {
  private db: Database.Database;
  private logger: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        parent_id  TEXT REFERENCES folders(id),
        path       TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        folder_id  TEXT NOT NULL DEFAULT 'root' REFERENCES folders(id),
        path       TEXT UNIQUE NOT NULL,
        content    BLOB NOT NULL DEFAULT '',
        tags       TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS documents_folder_id_idx ON documents(folder_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title, content, tags, doc_id UNINDEXED
      );

      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(doc_id, title, content, tags)
        VALUES (new.id, new.title, CAST(new.content AS TEXT), new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
        INSERT INTO documents_fts(doc_id, title, content, tags)
        VALUES (new.id, new.title, CAST(new.content AS TEXT), new.tags);
      END;
    `);

    // Seed root folder
    const root = this.db.prepare('SELECT id FROM folders WHERE id = ?').get('root');
    if (!root) {
      const now = nowISO();
      this.db.prepare(
        'INSERT INTO folders (id, name, parent_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('root', 'Root', null, '/', now, now);
    }
  }

  // ---- Folder operations ----

  /** Resolve the path a new folder would take given input. */
  private computeFolderPath(parentId: string, name: string): string {
    const parent = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(parentId) as { path: string } | undefined;
    if (!parent) throw new Error(`Parent folder not found: ${parentId}`);
    return joinPath(parent.path, name);
  }

  /**
   * Ensure all ancestor folders along `path` exist (admin-only, used during
   * member writes so members can create docs under `/users/<bot>` without
   * pre-creating each segment).
   */
  ensureFolderPath(targetPath: string): Folder {
    const normalized = normalizePath(targetPath);
    if (normalized === '/') {
      return this.findFolderByPath('/')!;
    }
    const parts = normalized.slice(1).split('/');
    let parent = this.findFolderByPath('/')!;
    let curPath = '';
    for (const part of parts) {
      curPath += '/' + part;
      let f = this.findFolderByPath(curPath);
      if (!f) {
        const id = crypto.randomUUID();
        const now = nowISO();
        this.db.prepare(
          'INSERT INTO folders (id, name, parent_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, part, parent.id, curPath, now, now);
        f = { id, name: part, parent_id: parent.id, path: curPath, created_at: now, updated_at: now };
      }
      parent = f;
    }
    return parent;
  }

  createFolder(input: FolderCreateInput, cred: Credential): Folder {
    let folderPath: string;
    let parentId: string;
    let name: string;

    if (input.path) {
      folderPath = normalizePath(input.path);
      const segments = folderPath === '/' ? [] : folderPath.slice(1).split('/');
      name = segments[segments.length - 1] || 'root';
      const parentPath = segments.length <= 1 ? '/' : '/' + segments.slice(0, -1).join('/');
      // Auto-create intermediate folders if the caller has write access on
      // any ancestor of the target path. This keeps the create-by-path UX
      // ergonomic without an extra create-each-segment dance.
      if (!canWritePath(cred, folderPath)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
      const parent = this.ensureFolderPath(parentPath);
      parentId = parent.id;
    } else {
      name = input.name;
      parentId = input.parent_id || 'root';
      folderPath = this.computeFolderPath(parentId, name);
    }

    if (!canWritePath(cred, folderPath)) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }

    const existing = this.findFolderByPath(folderPath);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = nowISO();
    this.db.prepare(
      'INSERT INTO folders (id, name, parent_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, name, parentId, folderPath, now, now);
    return { id, name, parent_id: parentId, path: folderPath, created_at: now, updated_at: now };
  }

  findFolderByPath(path: string): Folder | null {
    const normalized = normalizePath(path);
    const row = this.db.prepare('SELECT * FROM folders WHERE path = ?').get(normalized) as Folder | undefined;
    return row ?? null;
  }

  findFolderById(id: string): Folder | null {
    const row = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Folder | undefined;
    return row ?? null;
  }

  /** List folders with optional prefix filter, ACL-applied. */
  listFolders(prefix: string | undefined, cred: Credential): Folder[] {
    let rows: Folder[];
    if (prefix) {
      const p = normalizePath(prefix);
      const like = p === '/' ? '%' : p + '%';
      rows = this.db.prepare('SELECT * FROM folders WHERE path = ? OR path LIKE ? ORDER BY path')
        .all(p, like) as Folder[];
    } else {
      rows = this.db.prepare('SELECT * FROM folders ORDER BY path').all() as Folder[];
    }
    return rows.filter((f) => canReadPath(cred, f.path));
  }

  getFolderTree(cred: Credential): FolderTreeNode {
    const folders = this.listFolders(undefined, cred);
    const docCounts = this.db.prepare(
      'SELECT folder_id, COUNT(*) as count FROM documents GROUP BY folder_id',
    ).all() as { folder_id: string; count: number }[];
    const countMap = new Map<string, number>();
    for (const r of docCounts) countMap.set(r.folder_id, r.count);

    const nodeMap = new Map<string, FolderTreeNode>();
    for (const f of folders) {
      nodeMap.set(f.id, {
        id: f.id, name: f.name, path: f.path, children: [],
        document_count: countMap.get(f.id) || 0,
      });
    }

    let root: FolderTreeNode | undefined;
    for (const f of folders) {
      const node = nodeMap.get(f.id)!;
      if (f.parent_id && nodeMap.has(f.parent_id)) {
        nodeMap.get(f.parent_id)!.children.push(node);
      } else if (!f.parent_id || f.id === 'root') {
        root = node;
      }
    }
    return root || { id: 'root', name: 'Root', path: '/', children: [], document_count: 0 };
  }

  deleteFolder(folderIdOrPath: string, cred: Credential): void {
    const folder = this.resolveFolder(folderIdOrPath);
    if (!folder) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    if (folder.id === 'root') throw Object.assign(new Error('cannot_delete_root'), { statusCode: 400 });
    if (!canWritePath(cred, folder.path)) throw Object.assign(new Error('forbidden'), { statusCode: 403 });

    // recurse
    this.db.prepare('DELETE FROM documents WHERE folder_id = ?').run(folder.id);
    const children = this.db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(folder.id) as { id: string }[];
    for (const child of children) this.deleteFolder(child.id, cred);
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
  }

  private resolveFolder(idOrPath: string): Folder | null {
    if (idOrPath.startsWith('/')) return this.findFolderByPath(idOrPath);
    return this.findFolderById(idOrPath);
  }

  // ---- Document operations ----

  createDocument(data: DocumentCreateInput, cred: Credential): Document {
    let folderId: string;
    let docPath: string;
    let title = data.title;

    if (data.path) {
      const normalized = normalizePath(data.path);
      const segments = normalized.slice(1).split('/');
      const folderPath = segments.length <= 1 ? '/' : '/' + segments.slice(0, -1).join('/');
      const last = segments[segments.length - 1];
      if (!canWritePath(cred, normalized)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
      const folder = this.ensureFolderPath(folderPath);
      folderId = folder.id;
      docPath = normalized;
      if (!title) title = last;
    } else {
      folderId = data.folder_id || 'root';
      const folder = this.findFolderById(folderId);
      if (!folder) throw Object.assign(new Error('folder_not_found'), { statusCode: 404 });
      docPath = joinPath(folder.path, slugify(title));
      if (!canWritePath(cred, docPath)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
    }

    const existing = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(docPath);
    if (existing) {
      throw Object.assign(new Error('already_exists'), { statusCode: 409 });
    }

    const id = crypto.randomUUID();
    const now = nowISO();
    const tags = JSON.stringify(data.tags || []);
    this.db.prepare(
      'INSERT INTO documents (id, title, folder_id, path, content, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, title, folderId, docPath, data.content || '', tags, data.created_by || cred.botName, now, now);

    return {
      id, title, folder_id: folderId, path: docPath,
      content: data.content || '',
      tags: data.tags || [],
      created_by: data.created_by || cred.botName,
      created_at: now, updated_at: now,
    };
  }

  getDocument(idOrPath: string, cred: Credential): Document | null {
    const row = (idOrPath.startsWith('/')
      ? this.db.prepare('SELECT * FROM documents WHERE path = ?').get(normalizePath(idOrPath))
      : this.db.prepare('SELECT * FROM documents WHERE id = ?').get(idOrPath)) as RawDocRow | undefined;
    if (!row) return null;
    if (!canReadPath(cred, row.path)) return null;
    return rowToDoc(row);
  }

  listDocuments(opts: { folder_id?: string; prefix?: string; limit?: number; offset?: number }, cred: Credential): DocumentSummary[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);

    let rows: RawDocRow[];
    if (opts.folder_id) {
      const folder = this.findFolderById(opts.folder_id);
      if (!folder || !canReadPath(cred, folder.path)) return [];
      rows = this.db.prepare(
        'SELECT id, title, folder_id, path, tags, created_by, created_at, updated_at FROM documents WHERE folder_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      ).all(opts.folder_id, limit, offset) as RawDocRow[];
    } else if (opts.prefix) {
      const p = normalizePath(opts.prefix);
      const like = p === '/' ? '%' : p + '%';
      rows = this.db.prepare(
        'SELECT id, title, folder_id, path, tags, created_by, created_at, updated_at FROM documents WHERE path = ? OR path LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      ).all(p, like, limit, offset) as RawDocRow[];
    } else {
      rows = this.db.prepare(
        'SELECT id, title, folder_id, path, tags, created_by, created_at, updated_at FROM documents ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      ).all(limit, offset) as RawDocRow[];
    }

    return rows
      .filter((r) => canReadPath(cred, r.path))
      .map((r) => ({
        id: r.id,
        title: r.title,
        folder_id: r.folder_id,
        path: r.path,
        tags: parseTags(r.tags),
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
  }

  updateDocument(idOrPath: string, data: DocumentUpdateInput, cred: Credential): Document | null {
    const row = (idOrPath.startsWith('/')
      ? this.db.prepare('SELECT * FROM documents WHERE path = ?').get(normalizePath(idOrPath))
      : this.db.prepare('SELECT * FROM documents WHERE id = ?').get(idOrPath)) as RawDocRow | undefined;
    if (!row) return null;
    if (!canWritePath(cred, row.path)) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }

    const title = data.title ?? row.title;
    const content = data.content ?? row.content.toString();
    const tags = data.tags ?? parseTags(row.tags);
    const folderId = data.folder_id ?? row.folder_id;

    // Recompute path if title or folder changed
    let docPath = row.path;
    if (data.title !== undefined || data.folder_id !== undefined) {
      const folder = this.findFolderById(folderId);
      if (!folder) throw Object.assign(new Error('folder_not_found'), { statusCode: 404 });
      docPath = joinPath(folder.path, slugify(title));
      if (!canWritePath(cred, docPath)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
    }

    const now = nowISO();
    this.db.prepare(
      'UPDATE documents SET title = ?, content = ?, tags = ?, folder_id = ?, path = ?, updated_at = ? WHERE id = ?',
    ).run(title, content, JSON.stringify(tags), folderId, docPath, now, row.id);

    return {
      id: row.id, title, folder_id: folderId, path: docPath,
      content, tags,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: now,
    };
  }

  deleteDocument(idOrPath: string, cred: Credential): boolean {
    const row = (idOrPath.startsWith('/')
      ? this.db.prepare('SELECT id, path FROM documents WHERE path = ?').get(normalizePath(idOrPath))
      : this.db.prepare('SELECT id, path FROM documents WHERE id = ?').get(idOrPath)) as { id: string; path: string } | undefined;
    if (!row) return false;
    if (!canWritePath(cred, row.path)) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }
    const result = this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
    return result.changes > 0;
  }

  searchDocuments(query: string, limit: number, cred: Credential): SearchResult[] {
    const escaped = escapeFts5Query(query);
    const rows = this.db.prepare(`
      SELECT d.id, d.title, d.path, d.tags, d.created_by, d.updated_at,
             snippet(documents_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM documents_fts fts
      JOIN documents d ON d.id = fts.doc_id
      WHERE documents_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(escaped, Math.min(Math.max(limit, 1), 100)) as RawSearchRow[];

    return rows
      .filter((r) => canReadPath(cred, r.path))
      .map((r) => ({
        id: r.id, title: r.title, path: r.path,
        snippet: r.snippet || '',
        tags: parseTags(r.tags),
        created_by: r.created_by || '',
        updated_at: r.updated_at,
      }));
  }

  getStats(): { document_count: number; folder_count: number } {
    const docCount = (this.db.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number }).count;
    const folderCount = (this.db.prepare('SELECT COUNT(*) as count FROM folders').get() as { count: number }).count;
    return { document_count: docCount, folder_count: folderCount };
  }

  /** Accessible namespace roots — for diagnostics + manifest. */
  accessibleRoots(cred: Credential): string[] {
    return readableRoots(cred);
  }
}

interface RawDocRow {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content: Buffer | string;
  tags: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RawSearchRow {
  id: string;
  title: string;
  path: string;
  tags: string;
  created_by: string;
  updated_at: string;
  snippet: string | null;
}

function rowToDoc(row: RawDocRow): Document {
  return {
    id: row.id,
    title: row.title,
    folder_id: row.folder_id,
    path: row.path,
    content: row.content?.toString() ?? '',
    tags: parseTags(row.tags),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
