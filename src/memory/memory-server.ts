import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as url from 'node:url';
import type { Logger } from '../utils/logger.js';
import { MemoryStorage } from './memory-storage.js';
import type { Role } from './memory-storage.js';
import {
  handleGetFolders,
  handleCreateFolder,
  handleUpdateFolder,
  handleDeleteFolder,
  handleListDocuments,
  handleGetDocument,
  handleGetDocumentByPath,
  handleCreateDocument,
  handleUpdateDocument,
  handleDeleteDocument,
  handleSearch,
  handleHealth,
} from './memory-routes.js';

export interface MemoryServerOptions {
  port: number;
  databaseDir: string;
  secret?: string;
  adminToken?: string;
  readerToken?: string;
  logger: Logger;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

// Resolve the static directory — works for both src/ (tsx) and dist/ (compiled)
function resolveStaticDir(): string {
  const thisFile = url.fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);

  // When running from src/ via tsx
  const srcStatic = path.join(thisDir, 'static');
  if (fs.existsSync(srcStatic)) return srcStatic;

  // When running from dist/ (compiled), static files are at dist/memory/static
  const distStatic = path.join(thisDir, '..', 'memory', 'static');
  if (fs.existsSync(distStatic)) return distStatic;

  return srcStatic; // fallback
}

export function startMemoryServer(options: MemoryServerOptions): { server: http.Server; storage: MemoryStorage } {
  const { port, databaseDir, secret, adminToken, readerToken, logger } = options;
  const storage = new MemoryStorage(databaseDir, logger);
  const staticDir = resolveStaticDir();

  // Auth is enabled if any token is configured
  const authEnabled = !!(adminToken || readerToken || secret);

  /** Resolve role from Authorization header.
   *  - adminToken → 'admin'
   *  - readerToken or legacy secret → 'reader'
   *  - No tokens configured → 'admin' (backward compatible, open access)
   *  - Invalid/missing token when auth enabled → null (reject)
   */
  function resolveRole(req: http.IncomingMessage): Role | null {
    if (!authEnabled) return 'admin'; // No auth configured → full access

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) return null;
    if (adminToken && token === adminToken) return 'admin';
    if (readerToken && token === readerToken) return 'reader';
    // Legacy: old secret token gets admin access for backward compat
    if (secret && token === secret) return 'admin';
    return null; // invalid token
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';
    const parsed = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const query = parsed.searchParams;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // Resolve role for API routes
    let role: Role = 'admin';
    if (pathname.startsWith('/api/')) {
      const resolved = resolveRole(req);
      if (resolved === null) {
        jsonResponse(res, 401, { detail: 'Unauthorized' });
        return;
      }
      role = resolved;
    }

    try {
      // --- API Routes ---

      // Health (no auth needed)
      if (method === 'GET' && pathname === '/api/health') {
        const result = handleHealth(storage);
        jsonResponse(res, result.status, result.body);
        return;
      }

      // Folders
      if (method === 'GET' && pathname === '/api/folders') {
        const result = handleGetFolders(storage, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'POST' && pathname === '/api/folders') {
        const body = await parseJsonBody(req);
        const result = handleCreateFolder(storage, body, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'PUT' && pathname.startsWith('/api/folders/')) {
        const folderId = decodeURIComponent(pathname.slice('/api/folders/'.length));
        const body = await parseJsonBody(req);
        const result = handleUpdateFolder(storage, folderId, body, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'DELETE' && pathname.startsWith('/api/folders/')) {
        const folderId = decodeURIComponent(pathname.slice('/api/folders/'.length));
        const result = handleDeleteFolder(storage, folderId, role);
        jsonResponse(res, result.status, result.body);
        return;
      }

      // Documents
      if (method === 'GET' && pathname === '/api/documents/by-path') {
        const result = handleGetDocumentByPath(storage, query, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'GET' && pathname === '/api/documents') {
        const result = handleListDocuments(storage, query, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'GET' && pathname.startsWith('/api/documents/')) {
        const docId = decodeURIComponent(pathname.slice('/api/documents/'.length));
        const result = handleGetDocument(storage, docId, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'POST' && pathname === '/api/documents') {
        const body = await parseJsonBody(req);
        const result = handleCreateDocument(storage, body, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'PUT' && pathname.startsWith('/api/documents/')) {
        const docId = decodeURIComponent(pathname.slice('/api/documents/'.length));
        const body = await parseJsonBody(req);
        const result = handleUpdateDocument(storage, docId, body, role);
        jsonResponse(res, result.status, result.body);
        return;
      }
      if (method === 'DELETE' && pathname.startsWith('/api/documents/')) {
        const docId = decodeURIComponent(pathname.slice('/api/documents/'.length));
        const result = handleDeleteDocument(storage, docId, role);
        jsonResponse(res, result.status, result.body);
        return;
      }

      // Search
      if (method === 'GET' && pathname === '/api/search') {
        const result = handleSearch(storage, query, role);
        jsonResponse(res, result.status, result.body);
        return;
      }

      // --- Static files ---
      if (method === 'GET') {
        let filePath: string;
        if (pathname === '/' || pathname === '') {
          filePath = path.join(staticDir, 'index.html');
        } else {
          // Prevent path traversal
          const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
          filePath = path.join(staticDir, normalized);
          if (!filePath.startsWith(staticDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }
        }

        try {
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath);
          const mime = MIME_TYPES[ext] || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': mime,
            'Access-Control-Allow-Origin': '*',
          });
          res.end(content);
          return;
        } catch {
          // File not found — fall through to 404
        }
      }

      // 404 fallback
      jsonResponse(res, 404, { detail: 'Not found' });
    } catch (err: any) {
      logger.error({ err, method, url: rawUrl }, 'MetaMemory request error');
      jsonResponse(res, 500, { detail: err.message || 'Internal server error' });
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port }, 'MetaMemory port already in use, retrying in 3s (old process may still be running)');
      setTimeout(() => {
        server.close();
        server.listen(port, '0.0.0.0');
      }, 3000);
    } else {
      logger.error({ err, port }, 'MetaMemory server error');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'MetaMemory server started');
  });

  return { server, storage };
}
