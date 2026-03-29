import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { MemoryDocument, MemoryFolder } from '../types';
import styles from './MemoryView.module.css';

/* ---- Icons ---- */

function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconArrowLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

/* ---- API helpers ---- */

const MEMORY_BASE = '/memory';

interface FolderTreeNode {
  id: string;
  name: string;
  children?: FolderTreeNode[];
  document_count?: number;
}

/** Flatten nested folder tree into a flat array with parent_id */
function flattenTree(node: FolderTreeNode, parentId: string | null): MemoryFolder[] {
  const result: MemoryFolder[] = [];
  // Skip the root node itself, only add its children
  if (parentId !== null || node.id !== 'root') {
    result.push({ id: node.id, name: node.name, parent_id: parentId });
  }
  for (const child of node.children || []) {
    result.push(...flattenTree(child, parentId === null && node.id === 'root' ? null : node.id));
  }
  return result;
}

async function fetchFolders(): Promise<MemoryFolder[]> {
  const res = await fetch(`${MEMORY_BASE}/api/folders`);
  if (!res.ok) return [];
  const data = await res.json();
  // API returns a nested tree {id, name, children: [...]}
  if (data && data.children) {
    return flattenTree(data, null);
  }
  return data.folders || data || [];
}

async function fetchDocuments(folderId?: string): Promise<MemoryDocument[]> {
  const url = folderId
    ? `${MEMORY_BASE}/api/documents?folder_id=${folderId}`
    : `${MEMORY_BASE}/api/documents`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.documents || data || [];
}

async function fetchDocument(docId: string): Promise<MemoryDocument | null> {
  const res = await fetch(`${MEMORY_BASE}/api/documents/${docId}`);
  if (!res.ok) return null;
  return res.json();
}

async function searchDocuments(query: string): Promise<MemoryDocument[]> {
  const res = await fetch(
    `${MEMORY_BASE}/api/search?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || data.documents || data || [];
}

/* ---- Component ---- */

export function MemoryView() {
  const [folders, setFolders] = useState<MemoryFolder[]>([]);
  const [documents, setDocuments] = useState<MemoryDocument[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<MemoryDocument | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load folders on mount
  useEffect(() => {
    loadData();
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [f, d] = await Promise.all([fetchFolders(), fetchDocuments()]);
      setFolders(f);
      setDocuments(d);
    } catch {
      setError('Could not connect to MetaMemory server');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFolderClick = useCallback(async (folderId: string) => {
    setSelectedFolder(folderId);
    setSelectedDoc(null);
    setLoading(true);
    try {
      const docs = await fetchDocuments(folderId);
      setDocuments(docs);
    } catch {
      setError('Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleShowAll = useCallback(async () => {
    setSelectedFolder(null);
    setSelectedDoc(null);
    setLoading(true);
    try {
      const docs = await fetchDocuments();
      setDocuments(docs);
    } catch {
      setError('Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDocClick = useCallback(async (doc: MemoryDocument) => {
    setLoading(true);
    try {
      const full = await fetchDocument(doc.id);
      setSelectedDoc(full);
    } catch {
      setError('Failed to load document');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      handleShowAll();
      return;
    }
    setLoading(true);
    setSelectedDoc(null);
    try {
      const results = await searchDocuments(searchQuery);
      setDocuments(results);
    } catch {
      setError('Search failed');
    } finally {
      setLoading(false);
    }
  }, [searchQuery, handleShowAll]);

  // Root folders (no parent)
  const rootFolders = folders.filter((f) => !f.parent_id);

  // Render folder tree recursively
  function renderFolders(parentId: string | null, depth: number) {
    const children = parentId
      ? folders.filter((f) => f.parent_id === parentId)
      : rootFolders;

    return children.map((folder) => (
      <div key={folder.id}>
        <div
          className={`${styles.treeItem} ${
            selectedFolder === folder.id ? styles.treeItemActive : ''
          }`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          onClick={() => handleFolderClick(folder.id)}
        >
          <span className={styles.treeItemIcon}>
            <IconFolder />
          </span>
          {folder.name}
        </div>
        {renderFolders(folder.id, depth + 1)}
      </div>
    ));
  }

  return (
    <div className={styles.container}>
      {/* Folder tree sidebar */}
      <div className={styles.treeSidebar}>
        <div className={styles.treeHeader}>
          <span className={styles.treeTitle}>Folders</span>
          <div className={styles.treeActions}>
            <button
              className={styles.treeActionBtn}
              onClick={loadData}
              title="Refresh"
            >
              <IconRefresh />
            </button>
          </div>
        </div>

        <div className={styles.treeList}>
          <div
            className={`${styles.treeItem} ${
              !selectedFolder ? styles.treeItemActive : ''
            }`}
            onClick={handleShowAll}
          >
            <span className={styles.treeItemIcon}>
              <IconBook />
            </span>
            All Documents
          </div>
          {renderFolders(null, 0)}
        </div>
      </div>

      {/* Main area */}
      <div className={styles.mainArea}>
        {/* Mobile folder pills (hidden on desktop) */}
        <div className={styles.mobileFolderBar}>
          <button
            className={`${styles.folderPill} ${!selectedFolder ? styles.folderPillActive : ''}`}
            onClick={handleShowAll}
          >
            All
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              className={`${styles.folderPill} ${selectedFolder === folder.id ? styles.folderPillActive : ''}`}
              onClick={() => handleFolderClick(folder.id)}
            >
              <IconFolder /> {folder.name}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className={styles.searchBar}>
          <input
            className={styles.searchInput}
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
        </div>

        {error && (
          <div style={{ padding: '16px 20px' }}>
            <div
              style={{
                padding: '12px 16px',
                background: 'var(--error-bg)',
                border: '1px solid rgba(239,91,91,0.15)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--error)',
                fontSize: '13px',
              }}
            >
              {error}
            </div>
          </div>
        )}

        {loading && (
          <div className={styles.loading}>
            <span className={styles.loadingSpinner} />
            Loading...
          </div>
        )}

        {/* Document viewer or list */}
        {selectedDoc ? (
          <div className={styles.docViewer}>
            <button
              className={styles.backBtn}
              onClick={() => setSelectedDoc(null)}
            >
              <IconArrowLeft />
              Back to list
            </button>

            <div className={styles.docViewerHeader}>
              <h1 className={styles.docViewerTitle}>{selectedDoc.title}</h1>
              <div className={styles.docViewerMeta}>
                <span>{selectedDoc.path}</span>
                {selectedDoc.updated_at && (
                  <span>
                    Updated{' '}
                    {new Date(selectedDoc.updated_at).toLocaleDateString()}
                  </span>
                )}
                {selectedDoc.created_by && (
                  <span>by {selectedDoc.created_by}</span>
                )}
              </div>
              {selectedDoc.tags && selectedDoc.tags.length > 0 && (
                <div className={styles.docItemTags} style={{ marginTop: '8px' }}>
                  {selectedDoc.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.docViewerContent}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
              >
                {selectedDoc.content || '*(No content)*'}
              </ReactMarkdown>
            </div>
          </div>
        ) : !loading && documents.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <IconBook />
            </div>
            <div className={styles.emptyTitle}>No documents found</div>
            <div className={styles.emptySubtitle}>
              {searchQuery
                ? 'Try a different search query'
                : 'Connect to MetaMemory to browse documents'}
            </div>
          </div>
        ) : (
          <div className={styles.docList}>
            {documents.map((doc) => (
              <div
                key={doc.id}
                className={styles.docItem}
                onClick={() => handleDocClick(doc)}
              >
                <div className={styles.docItemIcon}>
                  <IconFile />
                </div>
                <div className={styles.docItemContent}>
                  <div className={styles.docItemTitle}>{doc.title}</div>
                  <div className={styles.docItemPath}>{doc.path}</div>
                  {doc.snippet && (
                    <div className={styles.docItemMeta}>
                      <span>{doc.snippet}</span>
                    </div>
                  )}
                  {doc.tags && doc.tags.length > 0 && (
                    <div className={styles.docItemTags}>
                      {doc.tags.map((tag) => (
                        <span key={tag} className={styles.tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
