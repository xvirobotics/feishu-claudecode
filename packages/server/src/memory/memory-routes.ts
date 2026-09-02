import type { MemoryStore } from './memory-store.js';
import type { AgentStore } from '../agents/agent-store.js';
import type { Credential } from '../auth/credentials.js';
import { canReadFolder, isHiddenFromMemoryView, isHiddenIdOrPath, pruneHiddenSubtrees } from './view-policy.js';

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
  if (prefix && isHiddenFromMemoryView(prefix)) return { status: 200, body: { folders: [] } };
  const folders = store.listFolders(prefix, cred).filter((f) => !isHiddenFromMemoryView(f.path));
  return { status: 200, body: { folders } };
}

export function getFolderTree(store: MemoryStore, cred: Credential): RouteResult {
  const tree = store.getFolderTree(cred);
  return { status: 200, body: pruneHiddenSubtrees(tree) };
}

export function getFolder(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'folder')) return err(404, 'folder_not_found');
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
  if (pathHint && isHiddenFromMemoryView(pathHint)) return err(403, 'hidden_namespace');
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
  if (isHiddenIdOrPath(store, idOrPath, 'folder')) return err(404, 'folder_not_found');
  try {
    store.deleteFolder(idOrPath, cred);
    return { status: 200, body: { ok: true } };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

// ---- Document handlers ----

export function listDocuments(store: MemoryStore, query: URLSearchParams, cred: Credential): RouteResult {
  const prefix = query.get('prefix') || undefined;
  if (prefix && isHiddenFromMemoryView(prefix)) return { status: 200, body: { documents: [] } };
  const folderId = query.get('folder_id') || undefined;
  if (folderId && isHiddenIdOrPath(store, folderId, 'folder')) {
    return { status: 200, body: { documents: [] } };
  }
  const docs = store.listDocuments({
    folder_id: folderId,
    prefix,
    limit: query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined,
    offset: query.get('offset') ? parseInt(query.get('offset')!, 10) : undefined,
  }, cred).filter((d) => !isHiddenFromMemoryView(d.path));
  return { status: 200, body: { documents: docs } };
}

export function getDocument(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'document')) return err(404, 'document_not_found');
  const doc = store.getDocument(idOrPath, cred);
  if (!doc) return err(404, 'document_not_found');
  return { status: 200, body: doc };
}

export function createDocument(store: MemoryStore, agents: AgentStore, body: Record<string, unknown>, cred: Credential): RouteResult {
  const title = (body.title as string) ?? '';
  const pathHint = body.path as string | undefined;
  if (!title && !pathHint) return err(400, 'title_or_path_required');
  if (pathHint && isHiddenFromMemoryView(pathHint)) return err(403, 'hidden_namespace');
  const folderId = typeof body.folder_id === 'string' ? (body.folder_id as string) : undefined;
  if (folderId && isHiddenIdOrPath(store, folderId, 'folder')) return err(403, 'hidden_namespace');
  try {
    const doc = store.createDocument({
      title,
      path: pathHint,
      folder_id: folderId,
      content: typeof body.content === 'string' ? body.content : '',
      content_type: typeof body.content_type === 'string' ? (body.content_type as string) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      shared: resolveShared(body.shared, agents, cred),
      created_by: (body.created_by as string) || undefined,
    }, cred);
    return { status: 201, body: doc };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

/**
 * Resolve a new document's `shared` flag. An explicit boolean in the request
 * body always wins (per-doc override); otherwise the default comes from the
 * authoring agent's `memoryPublic` config — public bots share by default,
 * private bots don't. Unregistered/unknown bots default to private.
 */
function resolveShared(raw: unknown, agents: AgentStore, cred: Credential): boolean {
  if (typeof raw === 'boolean') return raw;
  return agents.getByName(cred.botName)?.memoryPublic ?? false;
}

export function updateDocument(store: MemoryStore, idOrPath: string, body: Record<string, unknown>, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'document')) return err(404, 'document_not_found');
  const targetFolder = typeof body.folder_id === 'string' ? (body.folder_id as string) : undefined;
  if (targetFolder && isHiddenIdOrPath(store, targetFolder, 'folder')) {
    return err(403, 'hidden_namespace');
  }
  try {
    const doc = store.updateDocument(idOrPath, {
      title: typeof body.title === 'string' ? (body.title as string) : undefined,
      content: typeof body.content === 'string' ? (body.content as string) : undefined,
      content_type: typeof body.content_type === 'string' ? (body.content_type as string) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      shared: typeof body.shared === 'boolean' ? (body.shared as boolean) : undefined,
      folder_id: targetFolder,
    }, cred);
    if (!doc) return err(404, 'document_not_found');
    return { status: 200, body: doc };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function deleteDocument(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'document')) return err(404, 'document_not_found');
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
  const offset = Math.max(parseInt(query.get('offset') || '0', 10) || 0, 0);
  const results = store.searchDocuments(q, limit, cred, offset).filter((r) => !isHiddenFromMemoryView(r.path));
  return { status: 200, body: { results } };
}
