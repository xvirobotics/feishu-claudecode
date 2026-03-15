import type * as http from 'node:http';

export interface JsonBody {
  [key: string]: unknown;
}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

export class PayloadTooLargeError extends Error {
  statusCode = 413;
  constructor() { super('Request body too large (max 1 MB)'); }
}

export function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function wrapPreviewHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:20px 24px;color:#1a1a1a;line-height:1.6;font-size:14px;background:#fff}
h1,h2,h3{margin-top:1.2em;margin-bottom:.4em}
h2{font-size:16px;color:#555;border-bottom:1px solid #eee;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f5f5f5;font-weight:600}
tr:nth-child(even){background:#fafafa}
img{max-width:100%}
p{margin:.6em 0}
</style></head><body>${body}</body></html>`;
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function parseJsonBody(req: http.IncomingMessage): Promise<JsonBody> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw) as JsonBody;
  } catch {
    throw Object.assign(new Error('Invalid JSON in request body'), { statusCode: 400 });
  }
}
