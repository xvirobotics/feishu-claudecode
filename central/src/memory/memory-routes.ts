import type { MemoryStore } from './memory-store.js';
import type { Credential } from '../auth/credentials.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

function statusFromException(e: unknown): number {
  const s = (e as { statusCode?: number }).statusCode;
  return typeof s === 'number' ? s : 400;
}

// ---- Folder handlers ----

export function listFolders(store: MemoryStore, query: URLSearchParams, cred: Credential): RouteResult {
  const prefix = query.get('prefix') || undefined;
  const folders = store.listFolders(prefix, cred);
  return { status: 200, body: { folders } };
}

export function getFolderTree(store: MemoryStore, cred: Credential): RouteResult {
  const tree = store.getFolderTree(cred);
  return { status: 200, body: tree };
}

export function getFolder(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  const folder = idOrPath.startsWith('/')
    ? store.findFolderByPath(idOrPath)
    : store.findFolderById(idOrPath);
  if (!folder) return err(404, 'folder_not_found');
  if (!canReadFolder(store, folder, cred)) return err(404, 'folder_not_found');
  return { status: 200, body: folder };
}

export function createFolder(store: MemoryStore, body: Record<string, unknown>, cred: Credential): RouteResult {
  const name = body.name as string | undefined;
  const pathHint = body.path as string | undefined;
  if (!name && !pathHint) return err(400, 'name_or_path_required');
  try {
    const folder = store.createFolder({
      name: name ?? '',
      parent_id: (body.parent_id as string) ?? undefined,
      path: pathHint,
    }, cred);
    return { status: 201, body: folder };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function deleteFolder(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  try {
    store.deleteFolder(idOrPath, cred);
    return { status: 200, body: { ok: true } };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

// ---- Document handlers ----

export function listDocuments(store: MemoryStore, query: URLSearchParams, cred: Credential): RouteResult {
  const docs = store.listDocuments({
    folder_id: query.get('folder_id') || undefined,
    prefix: query.get('prefix') || undefined,
    limit: query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined,
    offset: query.get('offset') ? parseInt(query.get('offset')!, 10) : undefined,
  }, cred);
  return { status: 200, body: { documents: docs } };
}

export function getDocument(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  const doc = store.getDocument(idOrPath, cred);
  if (!doc) return err(404, 'document_not_found');
  return { status: 200, body: doc };
}

export function createDocument(store: MemoryStore, body: Record<string, unknown>, cred: Credential): RouteResult {
  const title = (body.title as string) ?? '';
  const pathHint = body.path as string | undefined;
  if (!title && !pathHint) return err(400, 'title_or_path_required');
  try {
    const doc = store.createDocument({
      title,
      path: pathHint,
      folder_id: (body.folder_id as string) || undefined,
      content: typeof body.content === 'string' ? body.content : '',
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      created_by: (body.created_by as string) || undefined,
    }, cred);
    return { status: 201, body: doc };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function updateDocument(store: MemoryStore, idOrPath: string, body: Record<string, unknown>, cred: Credential): RouteResult {
  try {
    const doc = store.updateDocument(idOrPath, {
      title: typeof body.title === 'string' ? (body.title as string) : undefined,
      content: typeof body.content === 'string' ? (body.content as string) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      folder_id: typeof body.folder_id === 'string' ? (body.folder_id as string) : undefined,
    }, cred);
    if (!doc) return err(404, 'document_not_found');
    return { status: 200, body: doc };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function deleteDocument(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  try {
    const ok = store.deleteDocument(idOrPath, cred);
    if (!ok) return err(404, 'document_not_found');
    return { status: 200, body: { ok: true } };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function search(store: MemoryStore, query: URLSearchParams, cred: Credential): RouteResult {
  const q = query.get('q');
  if (!q || !q.trim()) return err(400, 'q_required');
  const limit = parseInt(query.get('limit') || '20', 10) || 20;
  const results = store.searchDocuments(q, limit, cred);
  return { status: 200, body: { results } };
}

function canReadFolder(store: MemoryStore, folder: { path: string }, cred: Credential): boolean {
  return store.accessibleRoots(cred).some((root) => {
    if (root === '/') return true;
    return folder.path === root || folder.path.startsWith(root + '/');
  }) || folder.path.startsWith('/shared');
}
