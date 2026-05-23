import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type {
  RegisterAckFrame,
  RegisterFrame,
  WsFrame,
} from '@metabot/shared';
import { startServer, type RunningServer } from '../server.js';

const silentLogger = () => {};

describe('cloud server', () => {
  let srv: RunningServer;

  beforeAll(async () => {
    srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:18443',
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    await srv.close();
  });

  it('GET /healthz returns 200 with ok=true', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe('number');
  });

  it('GET / redirects to /web/hub/', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/web/hub/');
  });

  it('unknown path returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/no-such-route`);
    expect(res.status).toBe(404);
  });

  it('accepts register frame on /ws/instance and replies with register_ack', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/instance`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const registerFrame: RegisterFrame = {
      type: 'register',
      instanceId: 'test-host-001',
      publicKey: 'pk-test',
      bots: [{ name: 'sa', hubVisible: true }],
      version: '0.0.0-test',
      signature: 'sig-test',
      nonce: 'nonce-1',
    };

    const ack = await new Promise<WsFrame>((resolve, reject) => {
      ws.once('message', (data) => {
        try {
          resolve(JSON.parse(data.toString()) as WsFrame);
        } catch (err) {
          reject(err);
        }
      });
      ws.once('error', reject);
      ws.send(JSON.stringify(registerFrame));
    });

    expect(ack.type).toBe('register_ack');
    const ackTyped = ack as RegisterAckFrame;
    expect(ackTyped.assignedBaseUrl).toBe(
      'http://127.0.0.1:18443/i/test-host-001',
    );
    expect(ackTyped.sessionExpiresAt).toBeGreaterThan(Date.now());

    expect(srv.registry.size()).toBe(1);
    expect(srv.registry.get('test-host-001')?.bots.length).toBe(1);

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('rejects upgrade on a non-ws path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/not-a-ws-path`);
    const result = await new Promise<'error' | 'open'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    expect(result).toBe('error');
  });

  it('responds with error frame on malformed JSON', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/instance`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const reply = await new Promise<WsFrame>((resolve, reject) => {
      ws.once('message', (data) => {
        try {
          resolve(JSON.parse(data.toString()) as WsFrame);
        } catch (err) {
          reject(err);
        }
      });
      ws.send('not-json-at-all');
    });

    expect(reply.type).toBe('error');

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });
});
