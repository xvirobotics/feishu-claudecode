import WebSocket from 'ws';

export const DEFAULT_FEISHU_WS_PING_TIMEOUT_SEC = 20;
export const DEFAULT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS = 15_000;

const MIN_PING_TIMEOUT_SEC = 5;
const MAX_PING_TIMEOUT_SEC = 300;
const MIN_HANDSHAKE_TIMEOUT_MS = 1_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 120_000;
const TERMINATE_GUARD = Symbol.for('metabot.feishu.ws-terminate-guard');

interface ErrorEmitter {
  readyState: number;
  listenerCount(event: 'error'): number;
  once(event: 'error', listener: (error: unknown) => void): unknown;
}

/**
 * A socket that is terminated before its connection is established emits
 * 'error' ("WebSocket was closed before the connection was established").
 * With no listener attached that error is thrown as an uncaught exception,
 * so give the socket a no-op listener first.
 */
export function guardConnectingWebSocketTermination(socket: ErrorEmitter): void {
  if (socket.readyState === WebSocket.CONNECTING && socket.listenerCount('error') === 0) {
    socket.once('error', () => undefined);
  }
}

/**
 * Wrap WebSocket.prototype.terminate so every terminate() call — including
 * the SDK's internal ones — first guards a connecting socket. Idempotent.
 */
export function installFeishuWsTerminateGuard(): void {
  const prototype = WebSocket.prototype as typeof WebSocket.prototype & {
    [TERMINATE_GUARD]?: boolean;
  };
  if (prototype[TERMINATE_GUARD]) return;

  const terminate = prototype.terminate;
  prototype.terminate = function guardedTerminate(this: WebSocket): void {
    guardConnectingWebSocketTermination(this);
    terminate.call(this);
  };
  Object.defineProperty(prototype, TERMINATE_GUARD, { value: true });
}

export interface FeishuWsRecoveryOptions {
  autoReconnect: true;
  handshakeTimeoutMs: number;
  wsConfig: { pingTimeout: number };
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

/**
 * Enable the liveness controls provided by the public Feishu/Lark SDK.
 * A pong watchdog terminates half-open sockets after a network switch, while
 * the handshake timeout prevents reconnects waiting forever on a stale path.
 */
export function resolveFeishuWsRecoveryOptions(env: NodeJS.ProcessEnv = process.env): FeishuWsRecoveryOptions {
  return {
    autoReconnect: true,
    handshakeTimeoutMs: boundedInteger(
      env.METABOT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS,
      DEFAULT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS,
      MIN_HANDSHAKE_TIMEOUT_MS,
      MAX_HANDSHAKE_TIMEOUT_MS,
    ),
    wsConfig: {
      pingTimeout: boundedInteger(
        env.METABOT_FEISHU_WS_PING_TIMEOUT_SEC,
        DEFAULT_FEISHU_WS_PING_TIMEOUT_SEC,
        MIN_PING_TIMEOUT_SEC,
        MAX_PING_TIMEOUT_SEC,
      ),
    },
  };
}
