import type { WebSocket } from 'ws';
import type { PingFrame, PongFrame } from '@metabot/shared';
import type { InstanceRegistry } from './instance-registry.js';

export interface PingSupervisorOptions {
  registry: InstanceRegistry;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  logger?: (msg: string) => void;
  now?: () => number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 60_000;

export class PingSupervisor {
  private readonly registry: InstanceRegistry;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly logger: (msg: string) => void;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: PingSupervisorOptions) {
    this.registry = opts.registry;
    this.intervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.timeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.logger = opts.logger ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  recordPong(ws: WebSocket): void {
    const rec = this.registry.byWs(ws);
    if (rec) rec.lastSeen = this.now();
  }

  tick(): void {
    const ts = this.now();
    const ping: PingFrame = { type: 'ping', ts };
    const payload = JSON.stringify(ping);
    for (const rec of this.registry.list()) {
      const idle = ts - rec.lastSeen;
      if (idle > this.timeoutMs) {
        this.logger(
          `ping: terminating instance=${rec.instanceId} idleMs=${idle}`,
        );
        try {
          rec.ws.terminate();
        } catch {
          // ignore: connection may already be torn down
        }
        this.registry.remove(rec.instanceId);
        continue;
      }
      try {
        rec.ws.send(payload);
      } catch (err) {
        this.logger(
          `ping: send failed instance=${rec.instanceId} err=${(err as Error).message}`,
        );
      }
    }
  }
}

export function makePong(now: () => number = Date.now): PongFrame {
  return { type: 'pong', ts: now() };
}
