/**
 * Core document sync service: MetaMemory → Feishu Wiki (one-way).
 *
 * Syncs the entire MetaMemory folder tree to a Feishu Wiki space,
 * creating wiki nodes for folders and docx pages for documents.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import type { MemoryClient, FolderTreeNode } from '../memory/memory-client.js';
import { SyncStore } from './sync-store.js';
import { markdownToBlocks, batchBlocks, contentHash } from './markdown-to-blocks.js';

/** Full document with content (returned by GET /api/documents/:id). */
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

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  errors: string[];
  durationMs: number;
}

export interface DocSyncConfig {
  /** Feishu app ID (from bots.json, first feishu bot). */
  feishuAppId: string;
  /** Feishu app secret. */
  feishuAppSecret: string;
  /** Directory for sync-mapping.db. */
  databaseDir: string;
  /** Optional: wiki space name to find by name. */
  wikiSpaceName?: string;
  /** Optional: pre-existing wiki space ID (skips create/search). */
  wikiSpaceId?: string;
  /** Throttle delay between API calls (ms). Default 300. */
  throttleMs?: number;
}

const DEFAULT_THROTTLE_MS = 300;
const WIKI_SPACE_NAME = 'MetaMemory';

export class DocSync {
  private client: lark.Client;
  private store: SyncStore;
  private throttleMs: number;
  private wikiSpaceName: string;
  private syncing = false;

  constructor(
    private config: DocSyncConfig,
    private memoryClient: MemoryClient,
    private logger: Logger,
  ) {
    this.client = new lark.Client({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      disableTokenCache: false,
    });
    this.store = new SyncStore(config.databaseDir, logger);
    this.throttleMs = config.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.wikiSpaceName = config.wikiSpaceName ?? WIKI_SPACE_NAME;
  }

  /** Check if a sync is currently running. */
  isSyncing(): boolean {
    return this.syncing;
  }

  /** Get sync statistics. */
  getStats() {
    return this.store.getStats();
  }

  /** Get the wiki space ID (if configured). */
  getWikiSpaceId(): string | undefined {
    return this.store.getWikiSpaceId();
  }

  /**
   * Run a full sync: fetch all MetaMemory folders and documents,
   * create/update them in the Feishu Wiki space.
   */
  async syncAll(): Promise<SyncResult> {
    if (this.syncing) {
      return { created: 0, updated: 0, skipped: 0, deleted: 0, errors: ['Sync already in progress'], durationMs: 0 };
    }

    this.syncing = true;
    const start = Date.now();
    const result: SyncResult = { created: 0, updated: 0, skipped: 0, deleted: 0, errors: [], durationMs: 0 };

    try {
      // Step 1: Ensure wiki space exists
      const spaceId = await this.ensureWikiSpace();
      if (!spaceId) {
        result.errors.push('Failed to create or find wiki space. Check that the Feishu app has wiki:wiki and docx:document permissions.');
        return result;
      }

      // Step 2: Fetch MetaMemory folder tree
      const folderTree = await this.memoryClient.listFolderTree();

      // Step 3: Sync folder structure (create wiki nodes for folders)
      await this.syncFolders(spaceId, folderTree, '', result);

      // Step 4: Sync documents in each folder
      await this.syncDocumentsInTree(spaceId, folderTree, result);

      // Step 5: Clean up deleted documents
      await this.cleanupDeleted(result);

      this.store.setConfig('last_full_sync_at', new Date().toISOString());
    } catch (err: any) {
      this.logger.error({ err }, 'Sync failed');
      result.errors.push(err.message || 'Unknown sync error');
    } finally {
      this.syncing = false;
      result.durationMs = Date.now() - start;
    }

    return result;
  }

  /**
   * Sync a single document by its MetaMemory ID.
   * Used for incremental sync when a document is created/updated.
   */
  async syncDocument(docId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const spaceId = await this.ensureWikiSpace();
      if (!spaceId) {
        return { success: false, error: 'No wiki space configured' };
      }

      const doc = await this.fetchDocument(docId);
      if (!doc) {
        return { success: false, error: 'Document not found in MetaMemory' };
      }

      // Ensure parent folder is synced
      const folderTree = await this.memoryClient.listFolderTree();
      const parentNodeToken = await this.resolveParentNodeToken(spaceId, doc.folder_id, folderTree);

      await this.syncSingleDocument(spaceId, doc, parentNodeToken);
      return { success: true };
    } catch (err: any) {
      this.logger.error({ err, docId }, 'Failed to sync single document');
      return { success: false, error: err.message };
    }
  }

  // --- Wiki space management ---

  private async ensureWikiSpace(): Promise<string | undefined> {
    // Check stored space ID first
    let spaceId = this.store.getWikiSpaceId();
    if (spaceId) {
      // Verify it still exists
      try {
        await this.client.wiki.v2.space.get({ path: { space_id: spaceId } });
        return spaceId;
      } catch {
        this.logger.warn({ spaceId }, 'Stored wiki space not found, will search for one');
        this.store.setConfig('wiki_space_id', '');
      }
    }

    // Use pre-configured space ID from config/env
    if (this.config.wikiSpaceId) {
      spaceId = this.config.wikiSpaceId;
      try {
        await this.client.wiki.v2.space.get({ path: { space_id: spaceId } });
        this.store.setWikiSpaceId(spaceId);
        this.logger.info({ spaceId }, 'Using configured wiki space');
        return spaceId;
      } catch (err: any) {
        this.logger.error({ spaceId, err: err.msg || err.message }, 'Configured WIKI_SPACE_ID is invalid or bot is not a member');
      }
    }

    // Try to find existing space by name (bot must be a member)
    try {
      const resp = await this.client.wiki.v2.space.list({ params: { page_size: 50 } });
      const spaces = (resp.data as any)?.items || [];
      const existing = spaces.find((s: any) => s.name === this.wikiSpaceName);
      if (existing) {
        spaceId = existing.space_id;
        this.store.setWikiSpaceId(spaceId!);
        this.logger.info({ spaceId }, 'Found existing wiki space');
        return spaceId;
      }
      // If spaces exist but none match, use the first one
      if (spaces.length > 0) {
        spaceId = spaces[0].space_id;
        this.store.setWikiSpaceId(spaceId!);
        this.logger.info({ spaceId, name: spaces[0].name }, 'Using first available wiki space');
        return spaceId;
      }
    } catch (err: any) {
      this.logger.warn({ err: err.msg || err.message }, 'Failed to list wiki spaces');
    }

    // Try to create new space (requires user_access_token; may fail for bot apps)
    try {
      const resp = await this.client.wiki.v2.space.create({
        data: {
          name: this.wikiSpaceName,
          description: 'Auto-synced knowledge base from MetaMemory',
        },
      });
      spaceId = (resp.data as any)?.space?.space_id;
      if (spaceId) {
        this.store.setWikiSpaceId(spaceId);
        this.logger.info({ spaceId }, 'Created new wiki space');
        return spaceId;
      }
    } catch (err: any) {
      this.logger.error(
        { err: err.msg || err.message, code: err.code },
        'Failed to create wiki space. Create a wiki space manually in Feishu, add the bot app as a member, and set WIKI_SPACE_ID env var.',
      );
    }

    return undefined;
  }

  // --- Folder sync ---

  private async syncFolders(
    spaceId: string,
    node: FolderTreeNode,
    parentNodeToken: string,
    result: SyncResult,
  ): Promise<void> {
    // Skip the root folder itself (just process its children)
    if (node.id === 'root' || node.path === '/') {
      for (const child of node.children || []) {
        await this.syncFolders(spaceId, child, parentNodeToken, result);
      }
      return;
    }

    // Check if folder already has a mapping
    let folderMapping = this.store.getFolderMapping(node.id);

    if (!folderMapping) {
      // Create wiki node for this folder (as a shortcut page)
      try {
        const resp = await this.client.wiki.v2.spaceNode.create({
          path: { space_id: spaceId },
          data: {
            obj_type: 'shortcut' as any,
            title: node.name,
            parent_node_token: parentNodeToken || undefined,
          } as any,
        });
        const nodeToken = (resp.data as any)?.node?.node_token;
        if (nodeToken) {
          folderMapping = {
            memoryFolderId: node.id,
            memoryPath: node.path,
            feishuNodeToken: nodeToken,
          };
          this.store.upsertFolderMapping(folderMapping);
          this.logger.info({ folder: node.name, nodeToken }, 'Created wiki folder node');
        }
        await this.throttle();
      } catch {
        // If shortcut doesn't work, create a docx node as folder placeholder
        try {
          const resp = await this.client.wiki.v2.spaceNode.create({
            path: { space_id: spaceId },
            data: {
              obj_type: 'docx',
              node_type: 'origin',
              title: node.name,
              parent_node_token: parentNodeToken || undefined,
            },
          });
          const nodeToken = (resp.data as any)?.node?.node_token;
          if (nodeToken) {
            folderMapping = {
              memoryFolderId: node.id,
              memoryPath: node.path,
              feishuNodeToken: nodeToken,
            };
            this.store.upsertFolderMapping(folderMapping);
            this.logger.info({ folder: node.name, nodeToken }, 'Created wiki folder node (as docx)');
          }
          await this.throttle();
        } catch (err2: any) {
          this.logger.error({ err: err2.msg || err2.message, folder: node.name }, 'Failed to create folder node');
          result.errors.push(`Folder "${node.name}": ${err2.msg || err2.message}`);
        }
      }
    }

    // Recurse into children
    const currentNodeToken = folderMapping?.feishuNodeToken || parentNodeToken;
    for (const child of node.children || []) {
      await this.syncFolders(spaceId, child, currentNodeToken, result);
    }
  }

  // --- Document sync ---

  private async syncDocumentsInTree(
    spaceId: string,
    node: FolderTreeNode,
    result: SyncResult,
  ): Promise<void> {
    const isRoot = node.id === 'root' || node.path === '/';
    // For root: listDocuments(undefined) returns ALL docs globally.
    // Filter to only root-folder docs to avoid double-traversal with child folders.
    const folderId = isRoot ? undefined : node.id;
    try {
      const docs = await this.memoryClient.listDocuments(folderId, 200);
      const parentNodeToken = this.resolveFolderNodeToken(node.id);

      for (const docSummary of docs) {
        // When listing from root, skip docs that belong to subfolders
        // (they'll be synced when we recurse into that folder)
        if (isRoot && docSummary.folder_id && docSummary.folder_id !== 'root') {
          continue;
        }

        try {
          const doc = await this.fetchDocument(docSummary.id);
          if (!doc) {
            result.errors.push(`Document "${docSummary.title}": not found`);
            continue;
          }
          await this.syncSingleDocument(spaceId, doc, parentNodeToken, result);
        } catch (err: any) {
          this.logger.error({ err: err.message, doc: docSummary.title }, 'Failed to sync document');
          result.errors.push(`Document "${docSummary.title}": ${err.message}`);
        }
      }
    } catch (err: any) {
      this.logger.error({ err: err.message, folder: node.name }, 'Failed to list folder documents');
      result.errors.push(`Folder "${node.name}" listing: ${err.message}`);
    }

    // Recurse into child folders
    for (const child of node.children || []) {
      await this.syncDocumentsInTree(spaceId, child, result);
    }
  }

  private async syncSingleDocument(
    spaceId: string,
    doc: FullDocument,
    parentNodeToken: string,
    result?: SyncResult,
  ): Promise<void> {
    const hash = contentHash(doc.content + doc.title);
    const existing = this.store.getDocMapping(doc.id);

    // Skip if content hasn't changed
    if (existing && existing.contentHash === hash) {
      if (result) result.skipped++;
      return;
    }

    if (existing) {
      // Update existing document
      await this.updateDocumentContent(existing.feishuDocId, doc);
      this.store.upsertDocMapping({
        ...existing,
        memoryPath: doc.path,
        contentHash: hash,
        syncedAt: new Date().toISOString(),
      });
      if (result) result.updated++;
      this.logger.info({ doc: doc.title, docId: existing.feishuDocId }, 'Updated wiki document');
    } else {
      // Create new wiki page
      try {
        const resp = await this.client.wiki.v2.spaceNode.create({
          path: { space_id: spaceId },
          data: {
            obj_type: 'docx',
            node_type: 'origin',
            title: doc.title,
            parent_node_token: parentNodeToken || undefined,
          },
        });
        const node = (resp.data as any)?.node;
        const nodeToken = node?.node_token;
        const docId = node?.obj_token;

        if (nodeToken && docId) {
          await this.throttle();
          await this.writeDocumentContent(docId, doc);

          this.store.upsertDocMapping({
            memoryDocId: doc.id,
            memoryPath: doc.path,
            feishuNodeToken: nodeToken,
            feishuDocId: docId,
            contentHash: hash,
            syncedAt: new Date().toISOString(),
          });
          if (result) result.created++;
          this.logger.info({ doc: doc.title, nodeToken, docId }, 'Created wiki document');
        }
        await this.throttle();
      } catch (err: any) {
        this.logger.error({ err: err.msg || err.message, doc: doc.title }, 'Failed to create wiki document');
        if (result) result.errors.push(`Create "${doc.title}": ${err.msg || err.message}`);
      }
    }
  }

  // --- Document content writing ---

  private async writeDocumentContent(feishuDocId: string, doc: FullDocument): Promise<void> {
    // Build metadata header + content
    const fullContent = this.buildDocumentMarkdown(doc);
    const blocks = markdownToBlocks(fullContent);

    if (blocks.length === 0) return;

    const batches = batchBlocks(blocks);
    for (const batch of batches) {
      try {
        await this.client.docx.v1.documentBlockChildren.create({
          path: { document_id: feishuDocId, block_id: feishuDocId },
          data: {
            children: batch,
            index: -1, // append at end
          },
        });
        await this.throttle();
      } catch (err: any) {
        this.logger.error({ err: err.msg || err.message, docId: feishuDocId }, 'Failed to write blocks');
        throw err;
      }
    }
  }

  private async updateDocumentContent(feishuDocId: string, doc: FullDocument): Promise<void> {
    // Delete existing blocks first, then rewrite
    try {
      // Get existing blocks
      const resp = await this.client.docx.v1.documentBlockChildren.get({
        path: { document_id: feishuDocId, block_id: feishuDocId },
        params: { page_size: 500 },
      });
      const children = (resp.data as any)?.items || [];

      // Delete all existing child blocks
      if (children.length > 0) {
        const blockIds = children.map((b: any) => b.block_id).filter(Boolean);
        if (blockIds.length > 0) {
          await this.client.docx.v1.documentBlockChildren.batchDelete({
            path: { document_id: feishuDocId, block_id: feishuDocId },
            data: {
              start_index: 0,
              end_index: blockIds.length,
            },
          });
          await this.throttle();
        }
      }
    } catch (err: any) {
      this.logger.warn({ err: err.msg || err.message, docId: feishuDocId }, 'Failed to clear old blocks, will try writing anyway');
    }

    // Write new content
    await this.writeDocumentContent(feishuDocId, doc);
  }

  private buildDocumentMarkdown(doc: FullDocument): string {
    const parts: string[] = [];

    // Add tags as metadata line
    if (doc.tags && doc.tags.length > 0) {
      parts.push(`> Tags: ${doc.tags.join(', ')}`);
      parts.push('');
    }

    // Add the actual content
    parts.push(doc.content);

    // Add footer with sync info
    parts.push('');
    parts.push('---');
    parts.push(`> Synced from MetaMemory | Path: \`${doc.path}\` | Updated: ${doc.updated_at}`);

    return parts.join('\n');
  }

  // --- Cleanup ---

  private async cleanupDeleted(result: SyncResult): Promise<void> {
    const allMappings = this.store.getAllDocMappings();

    for (const mapping of allMappings) {
      try {
        const doc = await this.fetchDocument(mapping.memoryDocId);
        if (!doc) {
          // Document deleted from MetaMemory, remove from wiki
          this.store.deleteDocMapping(mapping.memoryDocId);
          if (result) result.deleted++;
          this.logger.info({ doc: mapping.memoryPath }, 'Removed mapping for deleted document');
          // Note: We don't delete the wiki page itself to avoid data loss.
          // The orphaned page can be manually cleaned up.
        }
      } catch {
        // If we can't fetch, assume it's deleted
        this.store.deleteDocMapping(mapping.memoryDocId);
        if (result) result.deleted++;
      }
    }
  }

  // --- Helpers ---

  private resolveFolderNodeToken(folderId: string): string {
    if (folderId === 'root' || !folderId) return '';
    const mapping = this.store.getFolderMapping(folderId);
    return mapping?.feishuNodeToken || '';
  }

  private async resolveParentNodeToken(
    spaceId: string,
    folderId: string,
    folderTree: FolderTreeNode,
  ): Promise<string> {
    if (!folderId || folderId === 'root') return '';

    const existing = this.store.getFolderMapping(folderId);
    if (existing) return existing.feishuNodeToken;

    // Need to sync the folder first
    const dummyResult: SyncResult = { created: 0, updated: 0, skipped: 0, deleted: 0, errors: [], durationMs: 0 };
    const folderNode = this.findFolderInTree(folderTree, folderId);
    if (folderNode) {
      await this.syncFolders(spaceId, folderNode, '', dummyResult);
    }

    const afterSync = this.store.getFolderMapping(folderId);
    return afterSync?.feishuNodeToken || '';
  }

  private findFolderInTree(node: FolderTreeNode, folderId: string): FolderTreeNode | undefined {
    if (node.id === folderId) return node;
    for (const child of node.children || []) {
      const found = this.findFolderInTree(child, folderId);
      if (found) return found;
    }
    return undefined;
  }

  /** Fetch full document content from MetaMemory API. */
  private async fetchDocument(docId: string): Promise<FullDocument | null> {
    try {
      const url = `${(this.memoryClient as any).baseUrl}/api/documents/${docId}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = (this.memoryClient as any).secret;
      if (secret) {
        headers['Authorization'] = `Bearer ${secret}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const data = await res.json() as any;
      // Unwrap if nested
      const doc = data.document || data;
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
    } catch {
      return null;
    }
  }

  private async throttle(): Promise<void> {
    if (this.throttleMs > 0) {
      await new Promise((r) => setTimeout(r, this.throttleMs));
    }
  }

  /** Close the sync store. */
  destroy(): void {
    this.store.close();
  }
}
