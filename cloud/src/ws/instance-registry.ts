import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  parseFrame,
  type RegisterFrame,
  type RegisterAckFrame,
  type RequestFrame,
  type ResponseFrame,
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

interface PendingEntry {
  instanceId: string;
  resolve: (frame: ResponseFrame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export class RequestTimeoutError extends Error {
  constructor(public readonly id: string, public readonly route: string, timeoutMs: number) {
    super(`request ${id} (${route}) timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export class InstanceOfflineError extends Error {
  constructor(public readonly instanceId: string) {
    super(`instance ${instanceId} is not connected`);
    this.name = 'InstanceOfflineError';
  }
}

export class InstanceDisconnectedError extends Error {
  constructor(public readonly instanceId: string) {
    super(`instance ${instanceId} disconnected while awaiting response`);
    this.name = 'InstanceDisconnectedError';
  }
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
  private readonly pending = new Map<string, PendingEntry>();
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
    this.failPendingFor(instanceId, new InstanceDisconnectedError(instanceId));
  }

  list(): InstanceRecord[] {
    return Array.from(this.records.values());
  }

  size(): number {
    return this.records.size;
  }

  /**
   * Find a bot by `(instanceId, botName)`. Returns the BotMeta (which carries
   * `feishuAppId`/`feishuAppSecret`/`accessAllowOpenIds`) plus the owning
   * instance record. Used by the cloud OAuth routes to look up which Feishu
   * app's credentials should drive the authorize/callback flow.
   */
  findBotOnInstance(
    instanceId: string,
    botName: string,
  ): { record: InstanceRecord; bot: BotMeta } | undefined {
    const record = this.records.get(instanceId);
    if (!record) return undefined;
    const bot = record.bots.find((b) => b.name === botName);
    if (!bot) return undefined;
    return { record, bot };
  }

  /**
   * Fallback lookup when only the bot name is known: scan every instance and
   * return the first match. Multi-host deployments where the same bot name
   * runs on more than one instance will get an arbitrary winner — callers
   * that care must pass `instanceId` to `findBotOnInstance` instead.
   */
  findBotAnywhere(
    botName: string,
  ): { record: InstanceRecord; bot: BotMeta } | undefined {
    for (const record of this.records.values()) {
      const bot = record.bots.find((b) => b.name === botName);
      if (bot) return { record, bot };
    }
    return undefined;
  }

  /**
   * Send a `request` frame to `instanceId` and resolve with the matching
   * `response` frame. The caller supplies `route` + `params`; this method
   * mints the correlation `id`, registers a pending entry, and arms a
   * timeout that rejects with `RequestTimeoutError` if no response lands
   * in time. If the instance is offline or disconnects mid-flight the
   * promise rejects with `InstanceOfflineError` / `InstanceDisconnectedError`.
   */
  async request(
    instanceId: string,
    route: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ResponseFrame> {
    const record = this.records.get(instanceId);
    if (!record) throw new InstanceOfflineError(instanceId);

    const id = crypto.randomUUID();
    const frame: RequestFrame = {
      type: 'request',
      id,
      route,
      params,
      timeoutMs,
    };

    return new Promise<ResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new RequestTimeoutError(id, route, timeoutMs));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { instanceId, resolve, reject, timer });

      try {
        record.ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /**
   * Hand a freshly-arrived `response` frame to the pending request that
   * matches its `id`. Returns `true` if the frame was matched and the
   * pending promise was resolved, `false` if no caller was waiting (the
   * caller should treat that as a protocol violation / stale id).
   */
  resolveResponse(frame: ResponseFrame): boolean {
    const entry = this.pending.get(frame.id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(frame.id);
    entry.resolve(frame);
    return true;
  }

  pendingSize(): number {
    return this.pending.size;
  }

  private failPendingFor(instanceId: string, err: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.instanceId === instanceId) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(err);
      }
    }
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
