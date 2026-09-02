/**
 * Memory view policy — the single source of truth for which memory paths are
 * visible to API callers. Routes translate these decisions into HTTP semantics
 * (403 on create, 404 on read/delete, empty lists) and never re-implement the
 * path-hiding rules themselves.
 */
import type { MemoryStore } from './memory-store.js';
import type { Credential } from '../auth/credentials.js';
import { isHiddenFromMemoryView } from './hidden-paths.js';

export { isHiddenFromMemoryView };

export type MemoryNodeKind = 'folder' | 'document';

export function isHiddenIdOrPath(store: MemoryStore, idOrPath: string, kind: MemoryNodeKind): boolean {
  if (idOrPath.startsWith('/')) return isHiddenFromMemoryView(idOrPath);
  const path = kind === 'folder'
    ? store.findFolderById(idOrPath)?.path ?? null
    : store.findDocumentPathById(idOrPath);
  return path !== null && isHiddenFromMemoryView(path);
}

export function pruneHiddenSubtrees<T extends { path: string; children: T[] }>(node: T): T {
  return {
    ...node,
    children: node.children
      .filter((child) => !isHiddenFromMemoryView(child.path))
      .map(pruneHiddenSubtrees),
  };
}

export function canReadFolder(store: MemoryStore, folder: { path: string }, cred: Credential): boolean {
  return store.accessibleRoots(cred).some((root) => {
    if (root === '/') return true;
    return folder.path === root || folder.path.startsWith(root + '/');
  }) || folder.path.startsWith('/shared');
}
