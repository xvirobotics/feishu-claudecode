import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { CloudClient } from '../src/cluster/cloud-client.js';
import type { BotMeta } from '@metabot/shared';
import { parseFrame } from '@metabot/shared';

// Minimal pino-compatible logger that swallows output (the tests don't assert on logs).
const silentLogger: any = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

interface Fixture {
  tmpDir: string;
  privateKeyPath: string;
  publicKeyPem: string;
  publicKeyObj: crypto.KeyObject;
  wss: WebSocketServer;
  url: string;
}

async function setup(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-client-test-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pubPem  = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPath = path.join(tmpDir, 'identity.key');
  fs.writeFileSync(privateKeyPath, privPem, { mode: 0o600 });

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const addr = wss.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}/ws/instance`;

  return {
    tmpDir,
    privateKeyPath,
    publicKeyPem: pubPem,
    publicKeyObj: publicKey,
    wss,
    url,
  };
}

async function teardown(fx: Fixture, client?: CloudClient) {
  if (client) client.disconnect();
  await new Promise<void>((resolve) => fx.wss.close(() => resolve()));
  fs.rmSync(fx.tmpDir, { recursive: true, force: true });
}

const bots: BotMeta[] = [
  { name: 'alpha', hubVisible: true,  accessAllowOpenIds: ['ou_a'] },
  { name: 'beta',  hubVisible: false },
];

describe('CloudClient', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    // wss closed inside teardown; tmpdir cleaned. teardown calls itself per-test.
  });

  it('sends a valid signed register frame on connect and exposes assignedBaseUrl after register_ack', async () => {
    let client: CloudClient | undefined;
    try {
      const registered = new Promise<{ register: any; ws: WebSocket }>((resolve) => {
        fx.wss.on('connection', (ws) => {
          ws.once('message', (data) => {
            const frame = parseFrame(JSON.parse(data.toString()));
            resolve({ register: frame, ws });
          });
        });
      });

      client = new CloudClient({
        cloudUrl: fx.url,
        instanceId: 'ameng-host-abc123',
        publicKey: fx.publicKeyPem,
        privateKeyPath: fx.privateKeyPath,
        version: '1.2.3',
        bots,
        logger: silentLogger,
        pingIntervalMs: 100_000, // disabled for this test
        pongTimeoutMs: 200_000,
      });
      client.connect();

      const { register, ws } = await registered;
      expect(register.type).toBe('register');
      expect(register.instanceId).toBe('ameng-host-abc123');
      expect(register.publicKey).toBe(fx.publicKeyPem);
      expect(register.version).toBe('1.2.3');
      expect(register.bots).toHaveLength(2);
      expect(register.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(typeof register.signature).toBe('string');

      // Verify the ed25519 signature with our public key.
      const sigBuf  = Buffer.from(register.signature, 'base64');
      const payload = Buffer.from(`${register.instanceId}${register.nonce}`, 'utf-8');
      const ok = crypto.verify(null, payload, fx.publicKeyObj, sigBuf);
      expect(ok).toBe(true);

      // Server responds with register_ack.
      const ack = {
        type: 'register_ack',
        assignedBaseUrl: 'https://teamclaude.xvirobotics.com:18443/i/ameng-host-abc123',
        sessionExpiresAt: Date.now() + 86_400_000,
      };
      ws.send(JSON.stringify(ack));

      // Wait for client to absorb the ack.
      const deadline = Date.now() + 2000;
      while (!client.getPublicBaseUrl() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(client.getPublicBaseUrl()).toBe(ack.assignedBaseUrl);
    } finally {
      await teardown(fx, client);
    }
  });

  it('terminates and reconnects when the server stops responding to pings', async () => {
    let client: CloudClient | undefined;
    try {
      let connectionCount = 0;
      const pingObserved: { resolved: boolean } = { resolved: false };
      let resolvePing!: () => void;
      const sawPing = new Promise<void>((r) => { resolvePing = r; });

      fx.wss.on('connection', (ws) => {
        connectionCount += 1;
        ws.on('message', (data) => {
          const text = data.toString();
          let frame: any;
          try { frame = JSON.parse(text); } catch { return; }
          if (frame.type === 'register') {
            ws.send(JSON.stringify({
              type: 'register_ack',
              assignedBaseUrl: 'https://teamclaude.xvirobotics.com:18443/i/test-instance',
              sessionExpiresAt: Date.now() + 86_400_000,
            }));
          } else if (frame.type === 'ping') {
            // First connection: deliberately do NOT respond → pongTimeout fires.
            // Second connection: respond, so the loop is stable.
            if (connectionCount === 1 && !pingObserved.resolved) {
              pingObserved.resolved = true;
              resolvePing();
            } else if (connectionCount >= 2) {
              ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            }
          }
        });
      });

      client = new CloudClient({
        cloudUrl: fx.url,
        instanceId: 'test-instance',
        publicKey: fx.publicKeyPem,
        privateKeyPath: fx.privateKeyPath,
        version: '0.0.1',
        bots,
        logger: silentLogger,
        pingIntervalMs: 30,       // fast for tests
        pongTimeoutMs: 60,        // short → triggers reconnect quickly
        reconnectInitialMs: 10,   // reconnect almost immediately
        reconnectMaxMs: 100,
      });
      client.connect();

      // Wait until the first ping has been observed by the server.
      await sawPing;

      // Within ~1s the client should have torn down and reconnected.
      const deadline = Date.now() + 2000;
      while (connectionCount < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(connectionCount).toBeGreaterThanOrEqual(2);
    } finally {
      await teardown(fx, client);
    }
  });
});
