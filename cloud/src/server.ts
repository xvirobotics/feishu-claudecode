import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseFrame, type ErrorFrame } from '@metabot/shared';
import {
  InstanceRegistry,
  RegisterError,
} from './ws/instance-registry.js';
import { PingSupervisor, makePong } from './ws/ping.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StartServerOptions {
  port?: number;
  host?: string;
  baseUrl?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  staticDir?: string;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  logger?: (msg: string) => void;
}

export interface RunningServer {
  httpServer: http.Server | https.Server;
  wss: WebSocketServer;
  registry: InstanceRegistry;
  ping: PingSupervisor;
  port: number;
  baseUrl: string;
  mode: 'http' | 'https';
  close(): Promise<void>;
}

const DEFAULT_PORT = 18443;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PUBLIC_HOST = 'teamclaude.xvirobotics.com';

function buildApp(staticDir: string): Express {
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  app.get('/', (_req, res) => {
    res.redirect(302, '/web/hub/');
  });

  app.use('/web', express.static(staticDir, { fallthrough: true }));

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not Found\n');
  });

  return app;
}

function sendError(ws: WebSocket, frame: ErrorFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // ignore: connection may already be torn down
  }
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<RunningServer> {
  const logger = opts.logger ?? ((msg: string) => console.log(`[cloud] ${msg}`));
  const envPort = process.env.METABOT_CLOUD_PORT
    ? Number(process.env.METABOT_CLOUD_PORT)
    : undefined;
  const port = opts.port ?? envPort ?? DEFAULT_PORT;
  const host = opts.host ?? process.env.METABOT_CLOUD_HOST ?? DEFAULT_HOST;
  const staticDir =
    opts.staticDir ??
    process.env.METABOT_CLOUD_STATIC_DIR ??
    path.resolve(__dirname, '..', 'static');

  const certPath = opts.tlsCertPath ?? process.env.METABOT_CLOUD_TLS_CERT;
  const keyPath = opts.tlsKeyPath ?? process.env.METABOT_CLOUD_TLS_KEY;

  const app = buildApp(staticDir);

  let httpServer: http.Server | https.Server;
  let mode: 'http' | 'https';
  if (certPath && keyPath) {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    httpServer = https.createServer({ cert, key }, app);
    mode = 'https';
    logger(`tls: enabled (cert=${certPath})`);
  } else {
    httpServer = http.createServer(app);
    mode = 'http';
    logger('tls: disabled (dev mode — set METABOT_CLOUD_TLS_CERT/KEY to enable)');
  }

  const baseUrl =
    opts.baseUrl ??
    process.env.METABOT_CLOUD_BASE_URL ??
    (mode === 'https'
      ? `https://${DEFAULT_PUBLIC_HOST}:${port}`
      : `http://127.0.0.1:${port}`);

  const registry = new InstanceRegistry({ baseUrl });
  const ping = new PingSupervisor({
    registry,
    pingIntervalMs: opts.pingIntervalMs,
    pongTimeoutMs: opts.pongTimeoutMs,
    logger,
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/ws/instance')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress ?? 'unknown';
    logger(`ws: connection opened peer=${peer}`);

    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        sendError(ws, {
          type: 'error',
          code: 'bad_json',
          message: 'frame is not valid JSON',
        });
        return;
      }

      const existing = registry.byWs(ws);
      if (!existing) {
        try {
          const { ack, record } = registry.register(ws, raw);
          ws.send(JSON.stringify(ack));
          logger(
            `ws: registered instance=${record.instanceId} bots=${record.bots.length}`,
          );
        } catch (err) {
          if (err instanceof RegisterError) {
            sendError(ws, {
              type: 'error',
              code: err.code,
              message: err.message,
            });
          } else {
            sendError(ws, {
              type: 'error',
              code: 'register_failed',
              message: (err as Error).message,
            });
          }
          ws.close(4001, 'register_failed');
        }
        return;
      }

      let frame;
      try {
        frame = parseFrame(raw);
      } catch (err) {
        sendError(ws, {
          type: 'error',
          code: 'invalid_frame',
          message: (err as Error).message,
        });
        return;
      }

      switch (frame.type) {
        case 'ping':
          existing.lastSeen = Date.now();
          ws.send(JSON.stringify(makePong()));
          break;
        case 'pong':
          ping.recordPong(ws);
          break;
        case 'update':
          existing.bots = frame.bots;
          existing.lastSeen = Date.now();
          logger(
            `ws: bots updated instance=${existing.instanceId} bots=${frame.bots.length}`,
          );
          break;
        case 'response':
          // PR-3 placeholder: routing/correlation lives in PR-5.
          existing.lastSeen = Date.now();
          break;
        default:
          sendError(ws, {
            type: 'error',
            code: 'unsupported_frame',
            message: `frame type ${frame.type} not handled in PR-3`,
          });
      }
    });

    ws.on('pong', () => ping.recordPong(ws));

    ws.on('close', () => {
      const rec = registry.byWs(ws);
      if (rec) {
        registry.remove(rec.instanceId);
        logger(`ws: closed instance=${rec.instanceId}`);
      } else {
        logger('ws: closed (unregistered)');
      }
    });

    ws.on('error', (err) => {
      logger(`ws: error ${err.message}`);
    });
  });

  ping.start();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort =
    typeof address === 'object' && address ? address.port : port;

  logger(`listening: ${mode}://${host}:${boundPort} baseUrl=${baseUrl}`);

  const close = async (): Promise<void> => {
    ping.stop();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore: client may already be torn down
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return {
    httpServer,
    wss,
    registry,
    ping,
    port: boundPort,
    baseUrl,
    mode,
    close,
  };
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startServer()
    .then((srv) => {
      const shutdown = async (signal: string) => {
        console.log(`[cloud] received ${signal}, shutting down`);
        try {
          await srv.close();
          process.exit(0);
        } catch (err) {
          console.error(`[cloud] shutdown error: ${(err as Error).message}`);
          process.exit(1);
        }
      };
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
    })
    .catch((err) => {
      console.error(`[cloud] start failed: ${err.message}`);
      process.exit(1);
    });
}
