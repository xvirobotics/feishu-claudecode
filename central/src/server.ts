import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { CredentialsStore } from './auth/credentials-store.js';
import { authenticate, isAuthFailure } from './auth/auth-middleware.js';
import { MemoryStore } from './memory/memory-store.js';
import { SkillStore } from './skills/skill-store.js';
import { AuditLog, createDefaultAuditLog, type AuditOp } from './observability/audit-log.js';
import * as memoryRoutes from './memory/memory-routes.js';
import * as skillRoutes from './skills/skill-routes.js';
import * as adminRoutes from './admin/admin-routes.js';
import { name as pkgName, version as pkgVersion } from './pkg-meta.js';

export interface ServerOptions {
  port: number;
  dataDir: string;
  instanceName?: string;
  logger: Logger;
}

export interface ServerHandle {
  server: http.Server;
  db: Database.Database;
  credentialsStore: CredentialsStore;
  memoryStore: MemoryStore;
  skillStore: SkillStore;
  auditLog: AuditLog;
  startedAt: number;
  close(): Promise<void>;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024;

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json);
}

class PayloadTooLargeError extends Error {
  statusCode = 413;
  constructor() {
    super('payload_too_large');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_SIZE) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new PayloadTooLargeError());
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', reject);
  });
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  }
}

function deriveOp(method: string, pathname: string): AuditOp | string {
  if (pathname.startsWith('/admin/')) return 'admin';
  if (pathname === '/api/memory/search' || pathname === '/api/skills/search') return 'search';
  if (pathname.endsWith('/publish')) return 'publish';
  if (pathname.endsWith('/install')) return 'install';
  if (method === 'POST') return 'create';
  if (method === 'PATCH' || method === 'PUT') return 'update';
  if (method === 'DELETE') return 'delete';
  if (method === 'GET') {
    const isCollection = pathname === '/api/memory/folders'
      || pathname === '/api/memory/documents'
      || pathname === '/api/skills';
    return isCollection ? 'list' : 'get';
  }
  return method.toLowerCase();
}

export function startServer(options: ServerOptions): ServerHandle {
  const { port, dataDir, logger } = options;
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'central.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const credentialsStore = new CredentialsStore(db, logger.child({ module: 'credentials' }));
  const memoryStore = new MemoryStore(db, logger.child({ module: 'memory' }));
  const skillStore = new SkillStore(db, logger.child({ module: 'skills' }));
  const auditLog = createDefaultAuditLog(dataDir, logger);

  // Admin bootstrap
  const tokenFile = path.join(dataDir, 'admin-bootstrap-token.txt');
  const bootstrapToken = credentialsStore.bootstrapAdmin(tokenFile);
  if (bootstrapToken) {
    logger.warn({ tokenFile }, 'ADMIN TOKEN BOOTSTRAPPED — SAVE IT NOW; this is the only time it is displayed');
    logger.warn({ token: bootstrapToken }, 'central admin token (one-time)');
  }

  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';
    const parsed = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const query = parsed.searchParams;

    const auditStart = Date.now();
    let credentialId = 'anonymous';
    let role = 'anonymous';
    const audited = pathname.startsWith('/api/') || pathname.startsWith('/admin/');
    if (audited) {
      res.on('finish', () => {
        try {
          auditLog.append({
            ts: new Date().toISOString(),
            op: deriveOp(method, pathname),
            path: pathname,
            credentialId,
            role,
            sourceIp: req.socket.remoteAddress || 'unknown',
            status: res.statusCode,
            latencyMs: Date.now() - auditStart,
          });
        } catch { /* audit must never break the request */ }
      });
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    try {
      // Health (open)
      if (method === 'GET' && pathname === '/health') {
        jsonResponse(res, 200, {
          ok: true,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          version: pkgVersion,
        });
        return;
      }

      // Manifest (open)
      if (method === 'GET' && pathname === '/api/manifest') {
        jsonResponse(res, 200, {
          schemaVersion: 1,
          instance: { name: options.instanceName || pkgName },
          capabilities: { memory: true, skills: true },
        });
        return;
      }

      // Authenticate everything else under /api/* or /admin/*
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/admin/')) {
        jsonResponse(res, 404, { error: 'not_found' });
        return;
      }

      const auth = authenticate(req, credentialsStore);
      if (isAuthFailure(auth)) {
        jsonResponse(res, auth.status, { error: auth.error });
        return;
      }
      const cred = auth.credential;
      credentialId = cred.id;
      role = cred.role;

      // ---- Admin routes ----
      if (pathname === '/admin/credentials/issue' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, adminRoutes.issueCredential(credentialsStore, body, cred));
      }
      if (pathname === '/admin/credentials/revoke' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, adminRoutes.revokeCredential(credentialsStore, body, cred));
      }
      if (pathname === '/admin/credentials' && method === 'GET') {
        return jsonResult(res, adminRoutes.listCredentials(credentialsStore, cred));
      }
      if (pathname === '/admin/audit' && method === 'GET') {
        return jsonResult(res, adminRoutes.readAudit(auditLog, query, cred));
      }

      // ---- Memory routes ----
      if (pathname === '/api/memory/folders' && method === 'GET') {
        return jsonResult(res, memoryRoutes.listFolders(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/folders/tree' && method === 'GET') {
        return jsonResult(res, memoryRoutes.getFolderTree(memoryStore, cred));
      }
      if (pathname === '/api/memory/folders' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.createFolder(memoryStore, body, cred));
      }
      if (pathname.startsWith('/api/memory/folders/') && method === 'GET') {
        const idOrPath = decodeURIComponent(pathname.slice('/api/memory/folders/'.length));
        return jsonResult(res, memoryRoutes.getFolder(memoryStore, idOrPath, cred));
      }
      if (pathname.startsWith('/api/memory/folders/') && method === 'DELETE') {
        const idOrPath = decodeURIComponent(pathname.slice('/api/memory/folders/'.length));
        return jsonResult(res, memoryRoutes.deleteFolder(memoryStore, idOrPath, cred));
      }

      if (pathname === '/api/memory/search' && method === 'GET') {
        return jsonResult(res, memoryRoutes.search(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/documents' && method === 'GET') {
        return jsonResult(res, memoryRoutes.listDocuments(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/documents' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.createDocument(memoryStore, body, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && method === 'GET') {
        const idOrPath = decodeURIComponent(pathname.slice('/api/memory/documents/'.length));
        return jsonResult(res, memoryRoutes.getDocument(memoryStore, idOrPath, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && (method === 'PATCH' || method === 'PUT')) {
        const idOrPath = decodeURIComponent(pathname.slice('/api/memory/documents/'.length));
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.updateDocument(memoryStore, idOrPath, body, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && method === 'DELETE') {
        const idOrPath = decodeURIComponent(pathname.slice('/api/memory/documents/'.length));
        return jsonResult(res, memoryRoutes.deleteDocument(memoryStore, idOrPath, cred));
      }

      // ---- Skill routes ----
      if (pathname === '/api/skills' && method === 'GET') {
        return jsonResult(res, skillRoutes.listSkills(skillStore, cred));
      }
      if (pathname === '/api/skills/search' && method === 'GET') {
        return jsonResult(res, skillRoutes.searchSkills(skillStore, query, cred));
      }
      // POST /api/skills/:name/publish — publish skill content for :name
      const publishMatch = pathname.match(/^\/api\/skills\/([^/]+)\/publish$/);
      if (publishMatch && method === 'POST') {
        const name = decodeURIComponent(publishMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, skillRoutes.publishSkill(skillStore, name, body, cred));
      }
      if (pathname.startsWith('/api/skills/') && method === 'GET') {
        const name = decodeURIComponent(pathname.slice('/api/skills/'.length));
        return jsonResult(res, skillRoutes.getSkill(skillStore, name, cred));
      }
      if (pathname.startsWith('/api/skills/') && method === 'DELETE') {
        const name = decodeURIComponent(pathname.slice('/api/skills/'.length));
        return jsonResult(res, skillRoutes.deleteSkill(skillStore, name, cred));
      }

      jsonResponse(res, 404, { error: 'not_found' });
    } catch (err: unknown) {
      const sc = (err as { statusCode?: number }).statusCode;
      if (typeof sc === 'number') {
        jsonResponse(res, sc, { error: (err as Error).message || 'error' });
        return;
      }
      logger.error({ err, method, url: rawUrl }, 'request error');
      jsonResponse(res, 500, { error: 'internal' });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port, dbPath }, 'central server started');
  });

  return {
    server,
    db,
    credentialsStore,
    memoryStore,
    skillStore,
    auditLog,
    startedAt,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      credentialsStore.close();
      db.close();
    },
  };
}

function jsonResult(res: http.ServerResponse, result: { status: number; body: unknown }): void {
  jsonResponse(res, result.status, result.body);
}
