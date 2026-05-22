/**
 * WebSocket-based log tail.
 *
 * On HTTP upgrade to `/api/manager/bots/:name/logs?stream=out|error&tail=200`:
 *   1. Authenticate via the manager session cookie.
 *   2. Resolve the bot's actual log path from `pm2 jlist[].pm2_env.pm_*_log_path`
 *      (NEVER hardcode `~/.pm2/logs/<name>-out.log`).
 *   3. Push the last `tail` lines of the file as text frames.
 *   4. fs.watch + tail-from-position any subsequent appended bytes.
 *
 * Closes when the client disconnects.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'node:stream';
import { requireAuth } from './auth.js';
import { findPm2 } from './pm2-control.js';
import type { Logger } from '../utils/logger.js';

const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES     = 5000;
const READ_CHUNK_BYTES   = 64 * 1024;

interface LogStreamOpts {
  sessionSecret: string;
  logger:        Logger;
}

/**
 * Read the last `n` lines of a file efficiently — read 64 KB chunks from the
 * tail until we have enough newlines or hit the start.
 */
async function readLastLines(filePath: string, n: number): Promise<string> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fd.stat();
    if (size === 0) return '';
    const chunks: Buffer[] = [];
    let pos      = size;
    let newlines = 0;
    while (pos > 0 && newlines <= n) {
      const readLen   = Math.min(READ_CHUNK_BYTES, pos);
      pos             = pos - readLen;
      const buf       = Buffer.alloc(readLen);
      await fd.read(buf, 0, readLen, pos);
      chunks.unshift(buf);
      for (const b of buf) if (b === 0x0a) newlines += 1;
    }
    const combined = Buffer.concat(chunks).toString('utf-8');
    const lines = combined.split('\n');
    return lines.slice(-n - 1).join('\n');
  } finally {
    await fd.close();
  }
}

export function attachLogStreamUpgrade(server: http.Server, opts: LogStreamOpts): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket as Duplex, head, wss, opts).catch((err) => {
      try {
        socket.destroy();
      } catch { /* ignore */ }
      opts.logger.warn({ err: err.message }, 'manager log stream upgrade failed');
    });
  });
}

async function handleUpgrade(
  req:    http.IncomingMessage,
  socket: Duplex,
  head:   Buffer,
  wss:    WebSocketServer,
  opts:   LogStreamOpts,
): Promise<void> {
  const url = req.url || '/';

  // Only handle our path. Other upgrades (none in manager today) → 404.
  const m = url.match(/^\/api\/manager\/bots\/([^/?#]+)\/logs(?:\?(.*))?$/);
  if (!m) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const session = requireAuth(req, opts.sessionSecret);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const botName = decodeURIComponent(m[1]);
  const search  = new URLSearchParams(m[2] || '');
  const stream  = search.get('stream') === 'error' ? 'error' : 'out';
  const tailRaw = parseInt(search.get('tail') || '', 10);
  const tail    = Number.isFinite(tailRaw) && tailRaw > 0
    ? Math.min(tailRaw, MAX_TAIL_LINES)
    : DEFAULT_TAIL_LINES;

  const proc = await findPm2(botName);
  if (!proc) {
    socket.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nbot not in pm2');
    socket.destroy();
    return;
  }
  const logPath = stream === 'error' ? proc.pmErrLogPath : proc.pmOutLogPath;
  if (!logPath) {
    socket.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nno log path');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, async (ws) => {
    await pumpLog(ws, logPath, tail, opts.logger);
  });
}

async function pumpLog(ws: WebSocket, logPath: string, tail: number, logger: Logger): Promise<void> {
  let closed = false;
  ws.on('close', () => { closed = true; });
  ws.on('error', () => { closed = true; });

  let position = 0;

  try {
    if (fs.existsSync(logPath)) {
      const initial = await readLastLines(logPath, tail);
      if (initial) safeSend(ws, initial);
      position = fs.statSync(logPath).size;
    } else {
      safeSend(ws, `[manager] log file does not exist yet: ${logPath}\n`);
    }
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message, logPath }, 'manager log initial read failed');
  }

  // Poll-based tail. fs.watch is unreliable on networked FS (vepfs) — polling
  // is dumb but predictable. 500ms feels live enough for log scrolling.
  const POLL_MS = 500;

  async function tick(): Promise<void> {
    if (closed) return;
    try {
      const stat = await fs.promises.stat(logPath);
      if (stat.size < position) {
        // File rotated / truncated. Reset to start of new file.
        position = 0;
        safeSend(ws, '\n[manager] log rotated\n');
      }
      if (stat.size > position) {
        const fd      = await fs.promises.open(logPath, 'r');
        try {
          const len   = stat.size - position;
          const buf   = Buffer.alloc(Math.min(len, 1024 * 1024));
          const { bytesRead } = await fd.read(buf, 0, buf.length, position);
          position   += bytesRead;
          if (bytesRead > 0) safeSend(ws, buf.subarray(0, bytesRead).toString('utf-8'));
        } finally {
          await fd.close();
        }
      }
    } catch { /* tolerate transient stat errors */ }

    if (!closed) setTimeout(tick, POLL_MS);
  }

  setTimeout(tick, POLL_MS);
}

function safeSend(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(text); } catch { /* ignore */ }
  }
}
