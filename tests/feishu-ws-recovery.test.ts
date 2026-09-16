import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_FEISHU_WS_PING_TIMEOUT_SEC,
  guardConnectingWebSocketTermination,
  resolveFeishuWsRecoveryOptions,
} from '../src/feishu/ws-recovery.js';
import { BotRegistry } from '../src/api/bot-registry.js';

afterEach(() => vi.useRealTimers());

describe('Feishu WebSocket network-switch recovery', () => {
  it('enables bounded liveness and handshake recovery by default', () => {
    expect(resolveFeishuWsRecoveryOptions({})).toEqual({
      autoReconnect: true,
      handshakeTimeoutMs: DEFAULT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS,
      wsConfig: { pingTimeout: DEFAULT_FEISHU_WS_PING_TIMEOUT_SEC },
    });
  });

  it('accepts safe overrides and rejects invalid values', () => {
    expect(resolveFeishuWsRecoveryOptions({
      METABOT_FEISHU_WS_PING_TIMEOUT_SEC: '35',
      METABOT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS: '25000',
    })).toMatchObject({ handshakeTimeoutMs: 25_000, wsConfig: { pingTimeout: 35 } });

    expect(resolveFeishuWsRecoveryOptions({
      METABOT_FEISHU_WS_PING_TIMEOUT_SEC: '0',
      METABOT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS: 'not-a-number',
    })).toMatchObject({
      handshakeTimeoutMs: DEFAULT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS,
      wsConfig: { pingTimeout: DEFAULT_FEISHU_WS_PING_TIMEOUT_SEC },
    });
  });

  it('terminates a half-open SDK socket when the pong watchdog expires', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const client = new lark.WSClient({
      appId: 'cli_0123456789abcdef',
      appSecret: 'test-only',
      loggerLevel: lark.LoggerLevel.error,
      ...resolveFeishuWsRecoveryOptions({}),
    });
    const internals = client as unknown as {
      wsConfig: { setWSInstance(value: { terminate: () => void }): void };
      armLiveness(): void;
    };
    internals.wsConfig.setWSInstance({ terminate });

    internals.armLiveness();
    await vi.advanceTimersByTimeAsync(DEFAULT_FEISHU_WS_PING_TIMEOUT_SEC * 1_000);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('absorbs the connect-time error emitted after a guarded terminate', () => {
    const socket = new EventEmitter() as EventEmitter & { readyState: number };
    socket.readyState = WebSocket.CONNECTING;

    guardConnectingWebSocketTermination(socket);

    expect(socket.listenerCount('error')).toBe(1);
    expect(() => socket.emit('error', new Error('WebSocket was closed before the connection was established'))).not.toThrow();
  });

  it('leaves an established socket untouched', () => {
    const socket = new EventEmitter() as EventEmitter & { readyState: number };
    socket.readyState = WebSocket.OPEN;

    guardConnectingWebSocketTermination(socket);

    expect(socket.listenerCount('error')).toBe(0);
  });

  it('surfaces live channel state without exposing credentials', () => {
    const registry = new BotRegistry();
    registry.register({
      name: 'personal-bot',
      platform: 'feishu',
      config: { claude: { defaultWorkingDirectory: '/tmp' } } as never,
      bridge: {} as never,
      sender: {} as never,
      connectionStatus: () => ({
        state: 'reconnecting',
        reconnectAttempts: 2,
        lastConnectTime: 123,
        nextConnectTime: 456,
      }),
    });

    expect(registry.listChannelStatuses()).toEqual([{
      name: 'personal-bot',
      platform: 'feishu',
      state: 'reconnecting',
      reconnectAttempts: 2,
      lastConnectTime: 123,
      nextConnectTime: 456,
    }]);
  });

  it('fails closed when a channel status provider throws', () => {
    const registry = new BotRegistry();
    registry.register({
      name: 'broken',
      platform: 'feishu',
      config: { claude: { defaultWorkingDirectory: '/tmp' } } as never,
      bridge: {} as never,
      sender: {} as never,
      connectionStatus: () => { throw new Error('status unavailable'); },
    });

    expect(registry.listChannelStatuses()).toEqual([
      { name: 'broken', platform: 'feishu', state: 'failed', reconnectAttempts: 0 },
    ]);
  });
});
