/**
 * Cloud-split local cloud-client (PR-4).
 *
 * Maintains a single outbound WSS connection from this MetaBot instance to
 * the cloud relay. Responsibilities:
 *   1. Dial `cloudUrl`, send `register` (ed25519-signed), await `register_ack`.
 *   2. Expose `getPublicBaseUrl()` so `MessageBridge.computeTranscriptLink`
 *      can rewrite transcript card links to the cloud-assigned base.
 *   3. Keepalive: 30s ping; if no pong within `pongTimeoutMs` close + reconnect.
 *   4. Exponential reconnect (1s → 60s cap) on any close/error.
 *   5. Dispatch inbound `request` frames through `dispatcher.routes` and reply
 *      with a matching `response` frame.
 *
 * When `cloudUrl` is empty/undefined the client is a no-op: `connect()` logs
 * and returns; `getPublicBaseUrl()` returns `undefined`; the rest of MetaBot
 * keeps working exactly as before (no public cloud exposure).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import {
  parseFrame,
  type BotMeta,
  type RegisterFrame,
  type RequestFrame,
  type ResponseFrame,
  type WsFrame,
} from '@metabot/shared';
import { dispatchRoute, type RouteHandler, routes as defaultRoutes } from './dispatcher.js';
import type { Logger } from '../utils/logger.js';

export interface CloudClientOptions {
  cloudUrl: string;
  instanceId: string;
  publicKey: string;
  privateKeyPath: string;
  version: string;
  bots: BotMeta[];
  logger: Logger;
  /** Override the route table. Defaults to dispatcher.routes. */
  routes?: Record<string, RouteHandler>;
  /** Ping interval in ms. Default 30_000. */
  pingIntervalMs?: number;
  /** Pong wait timeout in ms (must exceed pingIntervalMs). Default 60_000. */
  pongTimeoutMs?: number;
  /** Initial reconnect delay in ms. Default 1000. */
  reconnectInitialMs?: number;
  /** Maximum reconnect delay in ms. Default 60_000. */
  reconnectMaxMs?: number;
}

type Status = 'idle' | 'connecting' | 'registering' | 'registered' | 'closed';

export class CloudClient {
  private readonly cloudUrl: string;
  private readonly instanceId: string;
  private readonly publicKey: string;
  private readonly privateKeyPath: string;
  private readonly version: string;
  private readonly bots: BotMeta[];
  private readonly logger: Logger;
  private readonly routes: Record<string, RouteHandler>;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;

  private ws: WebSocket | undefined;
  private status: Status = 'idle';
  private assignedBaseUrl: string | undefined;
  private reconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private lastPongAt: number = 0;
  private stopped = false;
  private privateKey: crypto.KeyObject | undefined;

  constructor(opts: CloudClientOptions) {
    this.cloudUrl = opts.cloudUrl;
    this.instanceId = opts.instanceId;
    this.publicKey = opts.publicKey;
    this.privateKeyPath = opts.privateKeyPath;
    this.version = opts.version;
    this.bots = opts.bots;
    this.logger = opts.logger.child({ module: 'cloud-client', instanceId: opts.instanceId });
    this.routes = opts.routes ?? defaultRoutes;
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 60_000;
    this.reconnectInitialMs = opts.reconnectInitialMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 60_000;
    this.reconnectDelayMs = this.reconnectInitialMs;
  }

  /** Cloud-assigned public base URL (e.g. https://teamclaude.../i/<id>). */
  getPublicBaseUrl(): string | undefined {
    return this.assignedBaseUrl;
  }

  /** Override or add a route handler at runtime. */
  on(route: string, handler: RouteHandler): void {
    this.routes[route] = handler;
  }

  /** Begin dial loop. Safe to call once; subsequent calls are no-ops. */
  connect(): void {
    if (this.status !== 'idle' && this.status !== 'closed') return;
    this.stopped = false;
    this.dial();
  }

  /** Stop reconnection and close the active socket. */
  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.status = 'closed';
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // socket may already be torn down
      }
      this.ws = undefined;
    }
    this.assignedBaseUrl = undefined;
  }

  // ── internal ───────────────────────────────────────────────────────────

  private loadPrivateKey(): crypto.KeyObject {
    if (this.privateKey) return this.privateKey;
    const pem = fs.readFileSync(this.privateKeyPath, 'utf-8');
    this.privateKey = crypto.createPrivateKey(pem);
    return this.privateKey;
  }

  private buildRegisterFrame(): RegisterFrame {
    const nonce = crypto.randomBytes(16).toString('hex');
    const signedPayload = Buffer.from(`${this.instanceId}${nonce}`, 'utf-8');
    const sigBuf = crypto.sign(null, signedPayload, this.loadPrivateKey());
    const signature = sigBuf.toString('base64');
    return {
      type: 'register',
      instanceId: this.instanceId,
      publicKey: this.publicKey,
      bots: this.bots,
      version: this.version,
      nonce,
      signature,
    };
  }

  private dial(): void {
    if (this.stopped) return;
    this.status = 'connecting';
    this.logger.info({ cloudUrl: this.cloudUrl }, 'cloud-client: connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cloudUrl);
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'cloud-client: dial threw');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.status = 'registering';
      try {
        const frame = this.buildRegisterFrame();
        ws.send(JSON.stringify(frame));
        this.logger.info('cloud-client: register sent, awaiting ack');
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, 'cloud-client: failed to send register');
        try { ws.close(); } catch { /* ignore */ }
      }
    });

    ws.on('message', (data: RawData) => this.handleMessage(data));

    ws.on('error', (err: Error) => {
      this.logger.warn({ err: err.message }, 'cloud-client: socket error');
      // 'close' will fire next and trigger reconnect; nothing else to do here.
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn({ code, reason: reason.toString() }, 'cloud-client: socket closed');
      this.clearTimers();
      this.ws = undefined;
      this.assignedBaseUrl = undefined;
      this.lastPongAt = 0;
      this.status = this.stopped ? 'closed' : 'idle';
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleMessage(data: RawData): void {
    let frame: WsFrame;
    try {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      const parsed = JSON.parse(text);
      frame = parseFrame(parsed);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'cloud-client: drop invalid frame');
      return;
    }

    switch (frame.type) {
      case 'register_ack':
        this.assignedBaseUrl = frame.assignedBaseUrl;
        this.status = 'registered';
        this.reconnectDelayMs = this.reconnectInitialMs;
        this.lastPongAt = Date.now();
        this.logger.info(
          { assignedBaseUrl: frame.assignedBaseUrl, sessionExpiresAt: frame.sessionExpiresAt },
          'cloud-client: registered',
        );
        this.startPingLoop();
        break;
      case 'pong':
        this.lastPongAt = Date.now();
        break;
      case 'ping':
        this.send({ type: 'pong', ts: Date.now() });
        break;
      case 'request':
        void this.handleRequest(frame);
        break;
      case 'error':
        this.logger.warn({ code: frame.code, message: frame.message, id: frame.id }, 'cloud-client: cloud reported error');
        break;
      case 'response':
      case 'register':
      case 'update':
      default:
        this.logger.warn({ type: frame.type }, 'cloud-client: unexpected frame from cloud');
    }
  }

  private async handleRequest(frame: RequestFrame): Promise<void> {
    let result: { status: number; body: unknown };
    try {
      result = await dispatchRoute(frame.route, frame.params);
    } catch (err) {
      result = {
        status: 500,
        body: { error: 'dispatcher threw', message: (err as Error).message },
      };
    }
    const response: ResponseFrame = {
      type: 'response',
      id: frame.id,
      status: result.status,
      body: result.body,
    };
    this.send(response);
  }

  private send(frame: WsFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, type: frame.type }, 'cloud-client: send failed');
    }
  }

  private startPingLoop(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => this.sendPing(), this.pingIntervalMs);
  }

  private sendPing(): void {
    if (this.lastPongAt > 0 && Date.now() - this.lastPongAt > this.pongTimeoutMs) {
      this.logger.warn(
        { pongTimeoutMs: this.pongTimeoutMs, sinceLastPongMs: Date.now() - this.lastPongAt },
        'cloud-client: pong timeout, reconnecting',
      );
      const ws = this.ws;
      if (ws) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
      return;
    }
    this.send({ type: 'ping', ts: Date.now() });
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.logger.info({ delayMs: delay }, 'cloud-client: scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.dial();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectMaxMs, this.reconnectDelayMs * 2);
  }
}
