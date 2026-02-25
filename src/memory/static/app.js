/* ═══════════════════════════════════════════
   Memory Documents — Web UI Application
   ═══════════════════════════════════════════ */

const API = '';  // same origin

// ── Auth token ──
// Pass token via ?token=xxx in URL — saved to localStorage for subsequent visits.
(function initToken() {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('token');
  if (t) {
    localStorage.setItem('memory_token', t);
    // Clean token from URL bar
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  }
})();

function getAuthHeaders() {
  const token = localStorage.getItem('memory_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ── State ──

let folderTree = null;
let currentFolderId = 'root';
let currentDocId = null;
let editingDocId = null;      // null = new doc, string = editing existing
let expandedFolders = new Set(['root']);  // track which folders are expanded

// ── API helpers ──

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'API error');
  }
  return res.json();
}

// ── Folder Tree Rendering ──

function renderFolderTree(node, depth = 0) {
  if (!node) return document.createDocumentFragment();

  const el = document.createElement('div');
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedFolders.has(node.id);
  const isActive = node.id === currentFolderId;

  // Folder item row
  const item = document.createElement('div');
  item.className = 'folder-item' + (isActive ? ' active' : '');
  item.style.paddingLeft = `${12 + depth * 20}px`;

  // Toggle arrow
  const toggle = document.createElement('span');
  toggle.className = 'folder-toggle' + (isExpanded ? ' expanded' : '') + (!hasChildren ? ' empty' : '');
  toggle.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l8 7-8 7z"/></svg>';
  toggle.onclick = (e) => {
    e.stopPropagation();
    if (!hasChildren) return;
    if (expandedFolders.has(node.id)) {
      expandedFolders.delete(node.id);
    } else {
      expandedFolders.add(node.id);
    }
    refreshFolderTreeUI();
  };

  // Folder icon
  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.textContent = isExpanded && hasChildren ? '📂' : '📁';

  // Folder name
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = node.name;

  // Private badge
  const isPrivate = node.visibility === 'private';
  if (isPrivate) {
    const badge = document.createElement('span');
    badge.className = 'visibility-badge';
    badge.textContent = '🔒';
    badge.title = 'Private folder';
    name.appendChild(badge);
  }

  // Document count
  const count = document.createElement('span');
  if (node.document_count > 0) {
    count.className = 'folder-count';
    count.textContent = node.document_count;
  }

  item.appendChild(toggle);
  item.appendChild(icon);
  item.appendChild(name);
  if (node.document_count > 0) {
    item.appendChild(count);
  }

  item.onclick = (e) => {
    e.stopPropagation();
    // Auto-expand when clicking a folder
    if (!expandedFolders.has(node.id)) {
      expandedFolders.add(node.id);
    }
    navigateTo(`#/folder/${node.id}`);
    closeSidebar();
  };

  el.appendChild(item);

  // Children container
  if (hasChildren) {
    const children = document.createElement('div');
    children.className = 'folder-children' + (isExpanded ? '' : ' collapsed');
    for (const child of node.children) {
      children.appendChild(renderFolderTree(child, depth + 1));
    }
    el.appendChild(children);
  }

  return el;
}

function refreshFolderTreeUI() {
  const container = document.getElementById('folderTree');
  container.innerHTML = '';
  if (folderTree) {
    container.appendChild(renderFolderTree(folderTree));
  }
}

// ── Breadcrumb ──

function renderBreadcrumb(folderId) {
  const bc = document.getElementById('breadcrumb');
  if (!folderTree) { bc.innerHTML = ''; return; }

  const path = findFolderPath(folderTree, folderId);
  if (!path) { bc.innerHTML = ''; return; }

  const parts = path.map((f, i) => {
    if (i === path.length - 1) {
      return `<span class="current">${escapeHtml(f.name)}</span>`;
    }
    return `<a href="#/folder/${f.id}">${escapeHtml(f.name)}</a><span class="sep">/</span>`;
  });
  bc.innerHTML = parts.join('');
}

function findFolderPath(node, targetId, path = []) {
  if (!node) return null;
  path = [...path, node];
  if (node.id === targetId) return path;
  if (node.children) {
    for (const child of node.children) {
      const result = findFolderPath(child, targetId, path);
      if (result) return result;
    }
  }
  return null;
}

// ── Document List ──

function renderDocList(docs) {
  const list = document.getElementById('docList');
  if (!docs || docs.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📝</div>
        <div>No documents yet.</div>
        <div style="margin-top: 4px; font-size: 13px;">Click <strong>New</strong> to create one.</div>
      </div>`;
    return;
  }

  list.innerHTML = docs.map(doc => `
    <div class="doc-card" onclick="navigateTo('#/doc/${doc.id}')">
      <div class="doc-card-left">
        <div class="doc-card-title">${escapeHtml(doc.title)}</div>
        <div class="doc-card-meta">
          ${(doc.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}
          ${doc.created_by ? `<span>by ${escapeHtml(doc.created_by)}</span>` : ''}
          <span>${formatDate(doc.updated_at)}</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ── Document View ──

function renderDoc(doc) {
  document.getElementById('docTitle').textContent = doc.title;
  document.getElementById('docTags').innerHTML = (doc.tags || []).map(t =>
    `<span class="tag">${escapeHtml(t)}</span>`
  ).join(' ');
  document.getElementById('docAuthor').textContent = doc.created_by ? `by ${doc.created_by}` : '';
  document.getElementById('docUpdated').textContent = formatDate(doc.updated_at);

  // Configure marked for markdown rendering
  marked.setOptions({
    highlight: (code, lang) => {
      try {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    },
    breaks: true,
  });

  document.getElementById('docContent').innerHTML = marked.parse(doc.content || '');
}

// ── Search Results ──

function renderSearchResults(results, query) {
  const titleEl = document.getElementById('searchTitle');
  titleEl.textContent = `Search: "${query}"`;

  const list = document.getElementById('searchResults');
  if (!results || results.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div>No results found for "${escapeHtml(query)}"</div>
      </div>`;
    return;
  }

  list.innerHTML = results.map(r => `
    <div class="doc-card" onclick="navigateTo('#/doc/${r.id}')">
      <div class="doc-card-left">
        <div class="doc-card-title">${escapeHtml(r.title)}</div>
        <div class="snippet">${r.snippet || ''}</div>
        <div class="doc-card-meta">
          ${(r.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}
          <span>${formatDate(r.updated_at)}</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ── Views ──

function showView(viewId) {
  for (const v of document.querySelectorAll('.view')) {
    v.classList.add('hidden');
  }
  document.getElementById(viewId).classList.remove('hidden');
}

async function showFolder(folderId) {
  currentFolderId = folderId;
  currentDocId = null;

  // Ensure folder path is expanded
  expandPathTo(folderId);

  await refreshFolderTree();
  renderBreadcrumb(folderId);

  const folder = findFolder(folderTree, folderId);
  document.getElementById('viewTitle').textContent = folder ? folder.name : 'Documents';

  try {
    const docs = await api(`/api/documents?folder_id=${folderId}&limit=100`);
    renderDocList(Array.isArray(docs) ? docs : []);
  } catch (err) {
    renderDocList([]);
  }
  showView('docListView');
}

async function showDocument(docId) {
  currentDocId = docId;
  try {
    const doc = await api(`/api/documents/${docId}`);
    renderDoc(doc);
    showView('docView');
  } catch (err) {
    showView('docListView');
  }
}

function showEdit(docId) {
  editingDocId = docId;
  if (docId) {
    document.getElementById('editViewTitle').textContent = 'Edit Document';
    api(`/api/documents/${docId}`).then(doc => {
      document.getElementById('editTitle').value = doc.title;
      document.getElementById('editTags').value = (doc.tags || []).join(', ');
      document.getElementById('editContent').value = doc.content || '';
    });
  } else {
    document.getElementById('editViewTitle').textContent = 'New Document';
    document.getElementById('editTitle').value = '';
    document.getElementById('editTags').value = '';
    document.getElementById('editContent').value = '';
  }
  showView('editView');
}

async function showSearch(query) {
  try {
    const raw = await api(`/api/search?q=${encodeURIComponent(query)}`);
    const results = Array.isArray(raw) ? raw : (raw && raw.results ? raw.results : []);
    renderSearchResults(results, query);
  } catch (err) {
    renderSearchResults([], query);
  }
  showView('searchView');
}

// ── Folder helpers ──

function findFolder(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findFolder(child, id);
      if (found) return found;
    }
  }
  return null;
}

function expandPathTo(folderId) {
  if (!folderTree) return;
  const path = findFolderPath(folderTree, folderId);
  if (path) {
    for (const f of path) {
      expandedFolders.add(f.id);
    }
  }
}

async function refreshFolderTree() {
  try {
    const raw = await api('/api/folders');
    // Handle wrapped responses
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      folderTree = raw.folders || raw;
    } else {
      folderTree = raw;
    }
  } catch (err) {
    folderTree = { id: 'root', name: 'Root', path: '/', children: [], document_count: 0 };
  }
  refreshFolderTreeUI();
}

// ── Sidebar toggle (mobile) ──

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
  document.body.style.overflow = '';
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

// ── Router ──

function navigateTo(hash) {
  window.location.hash = hash;
}

async function handleRoute() {
  const hash = window.location.hash || '#/folder/root';

  const folderMatch = hash.match(/^#\/folder\/(.+)$/);
  const docMatch = hash.match(/^#\/doc\/(.+)$/);
  const searchMatch = hash.match(/^#\/search\?q=(.+)$/);

  try {
    if (folderMatch) {
      await showFolder(folderMatch[1]);
    } else if (docMatch) {
      await showDocument(docMatch[1]);
    } else if (searchMatch) {
      await showSearch(decodeURIComponent(searchMatch[1]));
    } else {
      await showFolder('root');
    }
  } catch (err) {
    console.error('Route error:', err);
  }
}

// ── Utils ──

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

// ── Event handlers ──

document.addEventListener('DOMContentLoaded', () => {
  // Sidebar toggle
  document.getElementById('sidebarToggle').onclick = toggleSidebar;
  document.getElementById('sidebarOverlay').onclick = closeSidebar;

  // Search
  const searchInput = document.getElementById('searchInput');

  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const q = searchInput.value.trim();
      if (q) {
        navigateTo(`#/search?q=${encodeURIComponent(q)}`);
        closeSidebar();
      }
    }
  };

  // Global keyboard shortcut: Ctrl/Cmd + K to focus search
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // New document
  document.getElementById('newDocBtn').onclick = () => showEdit(null);

  // Edit document
  document.getElementById('editDocBtn').onclick = () => {
    if (currentDocId) showEdit(currentDocId);
  };

  // Delete document
  document.getElementById('deleteDocBtn').onclick = async () => {
    if (!currentDocId) return;
    if (!confirm('Delete this document? This action cannot be undone.')) return;
    await api(`/api/documents/${currentDocId}`, { method: 'DELETE' });
    navigateTo(`#/folder/${currentFolderId}`);
  };

  // Back button
  document.getElementById('backBtn').onclick = () => {
    navigateTo(`#/folder/${currentFolderId}`);
  };

  // Save document
  document.getElementById('saveDocBtn').onclick = async () => {
    const title = document.getElementById('editTitle').value.trim();
    const content = document.getElementById('editContent').value;
    const tagsStr = document.getElementById('editTags').value;
    const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);

    if (!title) {
      document.getElementById('editTitle').focus();
      document.getElementById('editTitle').style.borderColor = 'var(--danger)';
      setTimeout(() => { document.getElementById('editTitle').style.borderColor = ''; }, 2000);
      return;
    }

    try {
      if (editingDocId) {
        await api(`/api/documents/${editingDocId}`, {
          method: 'PUT',
          body: JSON.stringify({ title, content, tags }),
        });
        navigateTo(`#/doc/${editingDocId}`);
      } else {
        const doc = await api('/api/documents', {
          method: 'POST',
          body: JSON.stringify({ title, content, tags, folder_id: currentFolderId, created_by: 'web-ui' }),
        });
        navigateTo(`#/doc/${doc.id}`);
      }
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
  };

  // Cancel edit
  document.getElementById('cancelEditBtn').onclick = () => {
    if (editingDocId) {
      navigateTo(`#/doc/${editingDocId}`);
    } else {
      navigateTo(`#/folder/${currentFolderId}`);
    }
  };

  // New folder
  document.getElementById('newFolderBtn').onclick = () => {
    document.getElementById('folderModal').classList.remove('hidden');
    document.getElementById('folderNameInput').value = '';
    setTimeout(() => document.getElementById('folderNameInput').focus(), 100);
  };

  document.getElementById('folderNameInput').onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('createFolderBtn').click();
    if (e.key === 'Escape') document.getElementById('cancelFolderBtn').click();
  };

  document.getElementById('createFolderBtn').onclick = async () => {
    const name = document.getElementById('folderNameInput').value.trim();
    if (!name) return;
    try {
      await api('/api/folders', {
        method: 'POST',
        body: JSON.stringify({ name, parent_id: currentFolderId }),
      });
      document.getElementById('folderModal').classList.add('hidden');
      await refreshFolderTree();
    } catch (err) {
      alert('Failed to create folder: ' + err.message);
    }
  };

  document.getElementById('cancelFolderBtn').onclick = () => {
    document.getElementById('folderModal').classList.add('hidden');
  };

  // Close modal on backdrop click
  document.getElementById('folderModal').onclick = (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('folderModal').classList.add('hidden');
    }
  };

  // Auth settings
  function updateAuthLabel() {
    const token = localStorage.getItem('memory_token');
    const label = document.getElementById('authStatusLabel');
    label.textContent = token ? 'Token set' : 'No token';
  }

  document.getElementById('authSettingsBtn').onclick = () => {
    const token = localStorage.getItem('memory_token') || '';
    document.getElementById('authTokenInput').value = token;
    document.getElementById('authModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('authTokenInput').focus(), 100);
  };

  document.getElementById('saveAuthBtn').onclick = () => {
    const token = document.getElementById('authTokenInput').value.trim();
    if (token) {
      localStorage.setItem('memory_token', token);
    } else {
      localStorage.removeItem('memory_token');
    }
    document.getElementById('authModal').classList.add('hidden');
    updateAuthLabel();
    handleRoute(); // refresh with new token
  };

  document.getElementById('clearAuthBtn').onclick = () => {
    localStorage.removeItem('memory_token');
    document.getElementById('authModal').classList.add('hidden');
    updateAuthLabel();
    handleRoute();
  };

  document.getElementById('cancelAuthBtn').onclick = () => {
    document.getElementById('authModal').classList.add('hidden');
  };

  document.getElementById('authModal').onclick = (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('authModal').classList.add('hidden');
    }
  };

  document.getElementById('authTokenInput').onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('saveAuthBtn').click();
    if (e.key === 'Escape') document.getElementById('cancelAuthBtn').click();
  };

  updateAuthLabel();

  // Router
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
});
