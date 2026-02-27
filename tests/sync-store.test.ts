import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SyncStore } from '../src/sync/sync-store.js';

function createLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => createLogger() } as any;
}

describe('SyncStore', () => {
  let store: SyncStore;
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-store-test-'));
    store = new SyncStore(tmpDir, createLogger());
  }

  afterEach(() => {
    if (store) store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Config ---

  it('gets and sets config values', () => {
    setup();
    expect(store.getConfig('foo')).toBeUndefined();
    store.setConfig('foo', 'bar');
    expect(store.getConfig('foo')).toBe('bar');
  });

  it('overwrites config on duplicate key', () => {
    setup();
    store.setConfig('key', 'val1');
    store.setConfig('key', 'val2');
    expect(store.getConfig('key')).toBe('val2');
  });

  it('gets and sets wiki space ID', () => {
    setup();
    expect(store.getWikiSpaceId()).toBeUndefined();
    store.setWikiSpaceId('space_123');
    expect(store.getWikiSpaceId()).toBe('space_123');
  });

  // --- Document mappings ---

  it('upserts and retrieves document mapping by ID', () => {
    setup();
    const mapping = {
      memoryDocId: 'doc1',
      memoryPath: '/folder/doc.md',
      feishuNodeToken: 'node_abc',
      feishuDocId: 'docx_123',
      contentHash: 'aabbccdd',
      syncedAt: '2024-01-01T00:00:00Z',
    };
    store.upsertDocMapping(mapping);
    const result = store.getDocMapping('doc1');
    expect(result).toEqual(mapping);
  });

  it('retrieves document mapping by path', () => {
    setup();
    store.upsertDocMapping({
      memoryDocId: 'doc2',
      memoryPath: '/research/report.md',
      feishuNodeToken: 'node_def',
      feishuDocId: 'docx_456',
      contentHash: '11223344',
      syncedAt: '2024-01-02T00:00:00Z',
    });
    const result = store.getDocMappingByPath('/research/report.md');
    expect(result?.memoryDocId).toBe('doc2');
  });

  it('returns undefined for missing document mapping', () => {
    setup();
    expect(store.getDocMapping('nonexistent')).toBeUndefined();
    expect(store.getDocMappingByPath('/nope')).toBeUndefined();
  });

  it('updates existing document mapping on upsert', () => {
    setup();
    store.upsertDocMapping({
      memoryDocId: 'doc1',
      memoryPath: '/old-path',
      feishuNodeToken: 'node_1',
      feishuDocId: 'docx_1',
      contentHash: 'aaaa',
      syncedAt: '2024-01-01T00:00:00Z',
    });
    store.upsertDocMapping({
      memoryDocId: 'doc1',
      memoryPath: '/new-path',
      feishuNodeToken: 'node_1',
      feishuDocId: 'docx_1',
      contentHash: 'bbbb',
      syncedAt: '2024-01-02T00:00:00Z',
    });
    const result = store.getDocMapping('doc1');
    expect(result?.memoryPath).toBe('/new-path');
    expect(result?.contentHash).toBe('bbbb');
  });

  it('deletes document mapping', () => {
    setup();
    store.upsertDocMapping({
      memoryDocId: 'doc1',
      memoryPath: '/path',
      feishuNodeToken: 'n1',
      feishuDocId: 'd1',
      contentHash: 'cc',
      syncedAt: '2024-01-01T00:00:00Z',
    });
    store.deleteDocMapping('doc1');
    expect(store.getDocMapping('doc1')).toBeUndefined();
  });

  it('lists all document mappings', () => {
    setup();
    store.upsertDocMapping({
      memoryDocId: 'a', memoryPath: '/a', feishuNodeToken: 'n_a',
      feishuDocId: 'd_a', contentHash: '11', syncedAt: '2024-01-01',
    });
    store.upsertDocMapping({
      memoryDocId: 'b', memoryPath: '/b', feishuNodeToken: 'n_b',
      feishuDocId: 'd_b', contentHash: '22', syncedAt: '2024-01-02',
    });
    const all = store.getAllDocMappings();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.memoryDocId).sort()).toEqual(['a', 'b']);
  });

  // --- Folder mappings ---

  it('upserts and retrieves folder mapping', () => {
    setup();
    const mapping = {
      memoryFolderId: 'folder1',
      memoryPath: '/research',
      feishuNodeToken: 'folder_node_1',
    };
    store.upsertFolderMapping(mapping);
    expect(store.getFolderMapping('folder1')).toEqual(mapping);
  });

  it('updates folder mapping on upsert', () => {
    setup();
    store.upsertFolderMapping({ memoryFolderId: 'f1', memoryPath: '/old', feishuNodeToken: 'n1' });
    store.upsertFolderMapping({ memoryFolderId: 'f1', memoryPath: '/new', feishuNodeToken: 'n2' });
    const result = store.getFolderMapping('f1');
    expect(result?.memoryPath).toBe('/new');
    expect(result?.feishuNodeToken).toBe('n2');
  });

  it('deletes folder mapping', () => {
    setup();
    store.upsertFolderMapping({ memoryFolderId: 'f1', memoryPath: '/x', feishuNodeToken: 'n1' });
    store.deleteFolderMapping('f1');
    expect(store.getFolderMapping('f1')).toBeUndefined();
  });

  it('lists all folder mappings', () => {
    setup();
    store.upsertFolderMapping({ memoryFolderId: 'f1', memoryPath: '/a', feishuNodeToken: 'n1' });
    store.upsertFolderMapping({ memoryFolderId: 'f2', memoryPath: '/b', feishuNodeToken: 'n2' });
    const all = store.getAllFolderMappings();
    expect(all).toHaveLength(2);
  });

  // --- Stats ---

  it('returns correct stats', () => {
    setup();
    store.setWikiSpaceId('space_abc');
    store.upsertDocMapping({
      memoryDocId: 'doc1', memoryPath: '/a', feishuNodeToken: 'n1',
      feishuDocId: 'd1', contentHash: '11', syncedAt: '2024-01-01',
    });
    store.upsertFolderMapping({ memoryFolderId: 'f1', memoryPath: '/b', feishuNodeToken: 'n2' });
    const stats = store.getStats();
    expect(stats.documentCount).toBe(1);
    expect(stats.folderCount).toBe(1);
    expect(stats.wikiSpaceId).toBe('space_abc');
  });

  // --- Clear all ---

  it('clears all mappings and config', () => {
    setup();
    store.setWikiSpaceId('space_abc');
    store.upsertDocMapping({
      memoryDocId: 'doc1', memoryPath: '/a', feishuNodeToken: 'n1',
      feishuDocId: 'd1', contentHash: '11', syncedAt: '2024-01-01',
    });
    store.upsertFolderMapping({ memoryFolderId: 'f1', memoryPath: '/b', feishuNodeToken: 'n2' });
    store.clearAll();
    expect(store.getAllDocMappings()).toHaveLength(0);
    expect(store.getAllFolderMappings()).toHaveLength(0);
    expect(store.getWikiSpaceId()).toBeUndefined();
  });

  // --- Persistence ---

  it('persists data across close and reopen', () => {
    setup();
    store.setWikiSpaceId('space_persist');
    store.upsertDocMapping({
      memoryDocId: 'doc1', memoryPath: '/a', feishuNodeToken: 'n1',
      feishuDocId: 'd1', contentHash: 'xx', syncedAt: '2024-01-01',
    });
    store.close();

    // Reopen with same directory
    const store2 = new SyncStore(tmpDir, createLogger());
    expect(store2.getWikiSpaceId()).toBe('space_persist');
    expect(store2.getDocMapping('doc1')?.contentHash).toBe('xx');
    store2.close();

    // Prevent double-close in afterEach
    store = undefined as any;
  });
});
