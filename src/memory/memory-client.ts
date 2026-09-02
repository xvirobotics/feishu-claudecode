import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/http.js';

/**
 * Talks to the central `metabot-core` service over HTTP(S) (default
 * `http://localhost:9200` — set METABOT_CORE_URL for a remote/self-hosted
 * host). All endpoints live under `/api/memory/*` and require a
 * `Authorization: Bearer <token>` header.
 *
 * Token resolution order:
 *   1. constructor `tokenOverride`
 *   2. `METABOT_CORE_TOKEN` env var
 *   3. first non-empty line of `~/.metabot-core/token`
 *
 * Base URL resolution order:
 *   1. constructor `baseUrlOverride`
 *   2. `METABOT_CORE_URL` env var
 *   3. `http://localhost:9200` (local default)
 */

const DEFAULT_BASE_URL = 'http://localhost:9200';

export class MemoryClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'MemoryClientError';
  }
}

export interface FolderTreeNode {
  id: string;
  name: string;
  path: string;
  children: FolderTreeNode[];
  document_count: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  tags: string[];
  created_by: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  snippet: string;
  tags: string[];
  updated_at: string;
}

export interface FullDocument {
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

export interface HealthStatus {
  status: string;
  document_count: number;
  folder_count: number;
}

function loadTokenFromFile(): string | undefined {
  const candidate = path.join(os.homedir(), '.metabot-core', 'token');
  try {
    const raw = fs.readFileSync(candidate, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
  } catch {
    /* file missing or unreadable — caller will warn */
  }
  return undefined;
}

export class MemoryClient {
  /** Base URL for metabot-core (no trailing slash). Public so callers
   *  that need to build sibling URLs (e.g. doc-sync uploads) can reuse it. */
  public readonly baseUrl: string;
  /** Bearer token resolved at construction. Public for doc-sync's
   *  binary-upload path; may be empty string if no token was found. */
  public readonly token: string;
  /** Backwards-compatible alias for `token` — kept because doc-sync.ts
   *  historically reached for `(memoryClient as any).secret`. New code
   *  should prefer `token`. */
  public readonly secret: string;

  constructor(
    private logger: Logger,
    baseUrlOverride?: string,
    tokenOverride?: string,
  ) {
    const rawUrl = baseUrlOverride
      || process.env.METABOT_CORE_URL
      || DEFAULT_BASE_URL;
    this.baseUrl = rawUrl.replace(/\/+$/, '');

    const resolved = tokenOverride
      || process.env.METABOT_CORE_TOKEN
      || loadTokenFromFile();
    this.token = resolved || '';
    this.secret = this.token;

    if (!this.token) {
      this.logger.warn(
        { baseUrl: this.baseUrl },
        'MemoryClient: no metabot-core token found (set METABOT_CORE_TOKEN or write ~/.metabot-core/token). Requests will fail with 401.',
      );
    }
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const res = await proxyFetch(url, {
      headers: { ...headers, ...options?.headers },
      ...options,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new MemoryClientError(`metabot-core ${res.status}: ${body}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  /** Health probe (calls /health on the central service, not a memory route). */
  async health(): Promise<HealthStatus> {
    const url = `${this.baseUrl}/health`;
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await proxyFetch(url, { headers });
    if (!res.ok) {
      throw new Error(`metabot-core health ${res.status}`);
    }
    const raw = await res.json() as Record<string, unknown>;
    const ok = raw && (raw as any).ok ? 'ok' : 'unknown';
    let documentCount = 0;
    let folderCount = 0;
    try {
      const tree = await this.listFolderTree();
      const counts = countTree(tree);
      documentCount = counts.docs;
      folderCount = counts.folders;
    } catch {
      /* health should still succeed even if listing fails */
    }
    return { status: String(ok), document_count: documentCount, folder_count: folderCount };
  }

  async listFolderTree(): Promise<FolderTreeNode> {
    const raw = await this.request<unknown>('/api/memory/folders/tree');
    return this.unwrapSingle<FolderTreeNode>(raw, 'folders');
  }

  async listDocuments(folderId?: string, limit = 50): Promise<DocumentSummary[]> {
    const params = new URLSearchParams();
    if (folderId) params.set('folder_id', folderId);
    params.set('limit', String(limit));
    const raw = await this.request<unknown>(`/api/memory/documents?${params}`);
    return this.unwrapArray<DocumentSummary>(raw, 'documents');
  }

  /**
   * Fetch full document content by id or absolute path. metabot-core accepts
   * either form in the same URL slot — a leading '/' on the path triggers
   * path-mode resolution on the server side. The whole segment must be
   * URL-encoded so the leading '/' survives as %2F.
   */
  async getDocument(idOrPath: string): Promise<FullDocument | null> {
    try {
      const encoded = encodeURIComponent(idOrPath);
      const raw = await this.request<unknown>(`/api/memory/documents/${encoded}`);
      if (raw && typeof raw === 'object') {
        const doc = (raw as any).document || raw;
        return {
          id: doc.id,
          title: doc.title,
          folder_id: doc.folder_id,
          path: doc.path,
          content: doc.content || '',
          tags: Array.isArray(doc.tags) ? doc.tags : [],
          created_by: doc.created_by || '',
          created_at: doc.created_at || '',
          updated_at: doc.updated_at || '',
        };
      }
      return null;
    } catch (error) {
      if (error instanceof MemoryClientError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const raw = await this.request<unknown>(`/api/memory/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return this.unwrapArray<SearchResult>(raw, 'results');
  }

  /** Format folder tree as indented text for Feishu card display */
  formatFolderTree(node: FolderTreeNode, depth = 0): string {
    if (!node || typeof node !== 'object') return 'No folder data available.';
    const name = node.name || 'unknown';
    const children = Array.isArray(node.children) ? node.children : [];
    const docCount = node.document_count || 0;
    const indent = '  '.repeat(depth);
    const icon = children.length > 0 ? '📂' : '📁';
    const count = docCount > 0 ? ` (${docCount})` : '';
    let result = `${indent}${icon} ${name}${count}\n`;
    for (const child of children) {
      result += this.formatFolderTree(child, depth + 1);
    }
    return result;
  }

  /** Format search results as text for Feishu card display */
  formatSearchResults(results: SearchResult[]): string {
    if (!Array.isArray(results) || results.length === 0) return 'No results found.';
    return results.map((r, i) => {
      const tags = Array.isArray(r.tags) && r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : '';
      // Strip HTML tags from snippet
      const snippet = (r.snippet || '').replace(/<[^>]*>/g, '');
      return `${i + 1}. **${r.title}**${tags}\n   ${snippet}`;
    }).join('\n\n');
  }

  /**
   * Unwrap API responses that may come as:
   * - A plain array: [...]
   * - An object with a specific key: { <key>: [...] }
   * - An object with 'results' key: { results: [...] }
   */
  private unwrapArray<T>(data: unknown, key: string): T[] {
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj[key])) return obj[key] as T[];
      if (Array.isArray(obj.results)) return obj.results as T[];
      if (Array.isArray(obj.data)) return obj.data as T[];
    }
    this.logger.warn({ responseType: typeof data, key }, 'Unexpected array response format from metabot-core');
    return [];
  }

  /**
   * Unwrap single-object API responses that may come as:
   * - The object directly: { id, name, ... }
   * - Wrapped in a key: { <key>: { id, name, ... } }
   */
  private unwrapSingle<T>(data: unknown, key: string): T {
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      // If the response has the expected key, return its value
      if (obj[key] && typeof obj[key] === 'object') return obj[key] as T;
      // If the response looks like the object itself (has expected fields), return directly
      if ('id' in obj || 'name' in obj || 'path' in obj || 'children' in obj) return data as T;
    }
    this.logger.warn({ responseType: typeof data, key }, 'Unexpected single-object response format from metabot-core');
    // Return a safe fallback
    return { id: '', name: 'root', path: '/', children: [], document_count: 0 } as unknown as T;
  }
}

function countTree(node: FolderTreeNode): { docs: number; folders: number } {
  let docs = node?.document_count || 0;
  let folders = node && node.id && node.id !== 'root' ? 1 : 0;
  for (const child of node?.children || []) {
    const sub = countTree(child);
    docs += sub.docs;
    folders += sub.folders;
  }
  return { docs, folders };
}
