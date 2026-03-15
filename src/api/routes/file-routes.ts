import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as http from 'node:http';
import { jsonResponse, escapeHtml, wrapPreviewHtml } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleFileRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { logger } = ctx;

  // POST /api/upload — save uploaded files
  if (method === 'POST' && (url === '/api/upload' || url.startsWith('/api/upload?'))) {
    const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB
    const chunks: Buffer[] = [];
    let totalSize = 0;

    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD_SIZE) {
          req.destroy();
          reject(Object.assign(new Error('File too large (max 50 MB)'), { statusCode: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve());
      req.on('error', reject);
    });

    const buffer = Buffer.concat(chunks);
    const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const originalName = urlObj.searchParams.get('filename') || 'upload';
    const chatId = urlObj.searchParams.get('chatId') || 'web';

    const uploadDir = path.join(os.tmpdir(), 'metabot-uploads', chatId);
    fs.mkdirSync(uploadDir, { recursive: true });

    const safeName = originalName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
    const filePath = path.join(uploadDir, safeName);
    fs.writeFileSync(filePath, buffer);

    logger.info({ chatId, filename: safeName, size: buffer.length }, 'File uploaded');
    jsonResponse(res, 200, { path: filePath, filename: safeName, size: buffer.length });
    return true;
  }

  // GET /api/files/preview/<chatId>/<filename> — convert docx/xlsx to HTML
  if (method === 'GET' && url.startsWith('/api/files/preview/')) {
    const filePart = decodeURIComponent(url.slice('/api/files/preview/'.length).split('?')[0]);
    const fullPath = path.resolve(path.join(os.tmpdir(), 'metabot-uploads', filePart));
    const uploadsRoot = path.resolve(path.join(os.tmpdir(), 'metabot-uploads'));

    if (!fullPath.startsWith(uploadsRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return true;
    }

    try {
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return true;
      }

      const ext = path.extname(fullPath).toLowerCase();
      let html = '';

      if (ext === '.docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.default.convertToHtml({ path: fullPath });
        html = wrapPreviewHtml(path.basename(fullPath), result.value);
      } else if (ext === '.xlsx' || ext === '.xls') {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(fs.readFileSync(fullPath));
        const tables: string[] = [];
        for (const name of workbook.SheetNames) {
          const sheet = workbook.Sheets[name];
          tables.push(`<h2>${escapeHtml(name)}</h2>` + XLSX.utils.sheet_to_html(sheet));
        }
        html = wrapPreviewHtml(path.basename(fullPath), tables.join('\n'));
      } else if (ext === '.pptx' || ext === '.ppt') {
        const { execSync } = await import('child_process');
        const tmpOut = path.join(os.tmpdir(), 'metabot-preview-' + Date.now());
        fs.mkdirSync(tmpOut, { recursive: true });
        try {
          execSync(`soffice --headless --convert-to html --outdir "${tmpOut}" "${fullPath}"`, { timeout: 30000 });
          const htmlFile = fs.readdirSync(tmpOut).find((f: string) => f.endsWith('.html'));
          if (htmlFile) {
            html = fs.readFileSync(path.join(tmpOut, htmlFile), 'utf-8');
          } else {
            throw new Error('LibreOffice conversion produced no output');
          }
        } finally {
          fs.rmSync(tmpOut, { recursive: true, force: true });
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Unsupported format for preview');
        return true;
      }

      const buf = Buffer.from(html, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.length.toString(),
        'Cache-Control': 'private, max-age=300',
      });
      res.end(buf);
    } catch (err: any) {
      logger.error({ err, path: fullPath }, 'File preview conversion error');
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Conversion failed: ' + (err.message || 'unknown error'));
    }
    return true;
  }

  // GET /api/files/<chatId>/<filename> — serve uploaded files
  if (method === 'GET' && url.startsWith('/api/files/')) {
    const filePart = decodeURIComponent(url.slice('/api/files/'.length).split('?')[0]);
    const fullPath = path.resolve(path.join(os.tmpdir(), 'metabot-uploads', filePart));
    const uploadsRoot = path.resolve(path.join(os.tmpdir(), 'metabot-uploads'));

    if (!fullPath.startsWith(uploadsRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return true;
    }

    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
          '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
          '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
          '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
          '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
          '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
        };
        const contentType = mimeMap[ext] || 'application/octet-stream';
        const content = fs.readFileSync(fullPath);
        const fileName = path.basename(fullPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length.toString(),
          'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
          'Cache-Control': 'private, max-age=3600',
        });
        res.end(content);
        return true;
      }
    } catch { /* fall through */ }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
    return true;
  }

  return false;
}
