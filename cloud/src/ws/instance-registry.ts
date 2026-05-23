import type { WebSocket } from 'ws';
import {
  parseFrame,
  type RegisterFrame,
  type RegisterAckFrame,
  type BotMeta,
  type WsFrame,
} from '@metabot/shared';

export interface InstanceRecord {
  instanceId: string;
  ws: WebSocket;
  bots: BotMeta[];
  publicKey: string;
  version: string;
  registeredAt: number;
  lastSeen: number;
}

export interface RegisterResult {
  ack: RegisterAckFrame;
  record: InstanceRecord;
}

export interface InstanceRegistryOptions {
  baseUrl: string;
  sessionTtlMs?: number;
  now?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class InstanceRegistry {
  private readonly records = new Map<string, InstanceRecord>();
  private readonly baseUrl: string;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(opts: InstanceRegistryOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  register(ws: WebSocket, rawFrame: unknown): RegisterResult {
    let frame: WsFrame;
    try {
      frame = parseFrame(rawFrame);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RegisterError('invalid_frame', `frame parse failed: ${reason}`);
    }
    if (frame.type !== 'register') {
      throw new RegisterError(
        'unexpected_frame',
        `expected register, got ${frame.type}`,
      );
    }
    const register = frame as RegisterFrame;

    const existing = this.records.get(register.instanceId);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4000, 'replaced_by_new_registration');
      } catch {
        // ignore: connection may already be torn down
      }
    }

    const ts = this.now();
    const record: InstanceRecord = {
      instanceId: register.instanceId,
      ws,
      bots: register.bots,
      publicKey: register.publicKey,
      version: register.version,
      registeredAt: ts,
      lastSeen: ts,
    };
    this.records.set(register.instanceId, record);

    const ack: RegisterAckFrame = {
      type: 'register_ack',
      assignedBaseUrl: `${this.baseUrl}/i/${register.instanceId}`,
      sessionExpiresAt: ts + this.sessionTtlMs,
    };
    return { ack, record };
  }

  touch(instanceId: string): void {
    const rec = this.records.get(instanceId);
    if (rec) rec.lastSeen = this.now();
  }

  get(instanceId: string): InstanceRecord | undefined {
    return this.records.get(instanceId);
  }

  byWs(ws: WebSocket): InstanceRecord | undefined {
    for (const rec of this.records.values()) {
      if (rec.ws === ws) return rec;
    }
    return undefined;
  }

  remove(instanceId: string): void {
    this.records.delete(instanceId);
  }

  list(): InstanceRecord[] {
    return Array.from(this.records.values());
  }

  size(): number {
    return this.records.size;
  }
}

export class RegisterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RegisterError';
  }
}
