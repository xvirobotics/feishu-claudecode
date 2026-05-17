import type * as http from 'node:http';
import type { Logger } from '../../utils/logger.js';
import { jsonResponse, readBody } from './helpers.js';

export interface MemoryProxyOptions {
  memoryUrl: string;
  /**
   * Fallback bearer token used only when the inbound request has no
   * Authorization header. When a caller (e.g. a peer using its handshake
   * reader token) supplies one, we forward it verbatim so memory-server's
   * `resolveAccess` can apply Pragmatic v1 folder-visibility filtering.
   */
  memoryAuthToken?: string;
  logger: Logger;
}

/**
 * Reverse-proxy a `/memory/*` request to the embedded MetaMemory server.
 *
 * Authorization passthrough is required for Pragmatic v1 — see
 * `decision_acl_pragmatic_v1.md` and the memory-proxy regression test.
 */
export async function proxyMemoryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
  options: MemoryProxyOptions,
): Promise<void> {
  const { memoryUrl, memoryAuthToken, logger } = options;
  const targetPath = url.slice('/memory'.length) || '/';
  const targetUrl = `${memoryUrl}${targetPath}`;

  try {
    const headers: Record<string, string> = {};
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    const inboundAuth = req.headers.authorization;
    if (typeof inboundAuth === 'string' && inboundAuth.length > 0) {
      headers['Authorization'] = inboundAuth;
    } else if (memoryAuthToken) {
      headers['Authorization'] = `Bearer ${memoryAuthToken}`;
    }

    let bodyContent: string | undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      bodyContent = await readBody(req);
    }

    const proxyRes = await fetch(targetUrl, {
      method,
      headers,
      body: bodyContent,
    });

    const contentType = proxyRes.headers.get('content-type') || 'application/json';
    const responseBody = await proxyRes.text();
    res.writeHead(proxyRes.status, { 'Content-Type': contentType });
    res.end(responseBody);
  } catch (err: any) {
    logger.warn({ err, targetUrl }, 'MetaMemory proxy error');
    jsonResponse(res, 502, { error: `MetaMemory proxy error: ${err.message}` });
  }
}
