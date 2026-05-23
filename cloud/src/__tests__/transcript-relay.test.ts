import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import type {
  RegisterFrame,
  RequestFrame,
  ResponseFrame,
  WsFrame,
} from '@metabot/shared';
import { startServer, type RunningServer } from '../server.js';

const silentLogger = () => {};
const SESSION_SECRET = 'cloud-pr5a-test-secret-1234567890';

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf;
  return b
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Mint an `mb_session` HS256 JWT the way local-side `signSession` does, so
 * cloud's `verifySession` accepts it. Kept inline (rather than imported) so
 * the cloud tests stay independent of the local package.
 */
function makeSessionCookie(openId: string, name = 'tester'): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(
    JSON.stringify({ open_id: openId, name, iat: now, exp: now + 3600 }),
  );
  const sig = b64urlEncode(
    crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(`${header}.${body}`)
      .digest(),
  );
  return `${header}.${body}.${sig}`;
}

interface FakeInstanceOpts {
  port: number;
  instanceId: string;
  chatIds?: string[];
  accessAllowOpenIds?: string[];
  hubVisible?: boolean;
  /** If provided, handle `request` frames; otherwise drop them (used for timeout test). */
  onRequest?: (frame: RequestFrame, ws: WebSocket) => void;
}

async function registerFakeInstance(opts: FakeInstanceOpts): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${opts.port}/ws/instance`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const register: RegisterFrame = {
    type: 'register',
    instanceId: opts.instanceId,
    publicKey: 'pk-test',
    bots: [
      {
        name: 'sa',
        hubVisible: opts.hubVisible ?? false,
        accessAllowOpenIds: opts.accessAllowOpenIds,
        chatIds: opts.chatIds,
      },
    ],
    version: '0.0.0-test',
    signature: 'sig',
    nonce: 'n',
  };
  await new Promise<void>((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as WsFrame;
        if (frame.type === 'register_ack') resolve();
        else reject(new Error(`expected register_ack, got ${frame.type}`));
      } catch (err) {
        reject(err);
      }
    });
    ws.send(JSON.stringify(register));
  });

  ws.on('message', (data) => {
    let frame: WsFrame;
    try {
      frame = JSON.parse(data.toString()) as WsFrame;
    } catch {
      return;
    }
    if (frame.type === 'request' && opts.onRequest) {
      opts.onRequest(frame, ws);
    }
  });

  return ws;
}

describe('cloud transcript relay', () => {
  let srv: RunningServer;

  beforeAll(async () => {
    srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:18443',
      sessionSecret: SESSION_SECRET,
      transcriptRequestTimeoutMs: 200,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    await srv.close();
  });

  it('returns 503 when the instance is not registered', async () => {
    const res = await fetch(
      `http://127.0.0.1:${srv.port}/i/ghost-host/api/transcript/oc_demo`,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('instance offline');
    expect(body.instanceId).toBe('ghost-host');
  });

  it('returns 401 when the request has no mb_session cookie', async () => {
    const ws = await registerFakeInstance({
      port: srv.port,
      instanceId: 'host-401',
      chatIds: ['oc_chat_a'],
      accessAllowOpenIds: ['ou_user_a'],
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/i/host-401/api/transcript/oc_chat_a`,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('login required');
      expect(body.loginUrl).toContain('/api/auth/feishu/login');
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    }
  });

  it('returns 403 when the cookie open_id is not in the whitelist', async () => {
    const ws = await registerFakeInstance({
      port: srv.port,
      instanceId: 'host-403',
      chatIds: ['oc_chat_b'],
      accessAllowOpenIds: ['ou_owner_only'],
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/i/host-403/api/transcript/oc_chat_b`,
        { headers: { cookie: `mb_session=${makeSessionCookie('ou_outsider')}` } },
      );
      expect(res.status).toBe(403);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    }
  });

  it('relays a 200 response from the local instance to the browser', async () => {
    const payload = {
      chat: { chatId: 'oc_chat_ok', totalTurns: 1 },
      turn: 1,
      messages: [{ role: 'user', text: 'hi' }],
    };
    let seenRoute: string | null = null;
    let seenParams: unknown = null;
    const ws = await registerFakeInstance({
      port: srv.port,
      instanceId: 'host-ok',
      chatIds: ['oc_chat_ok'],
      accessAllowOpenIds: ['ou_owner'],
      onRequest: (frame, socket) => {
        seenRoute = frame.route;
        seenParams = frame.params;
        const reply: ResponseFrame = {
          type: 'response',
          id: frame.id,
          status: 200,
          body: payload,
        };
        socket.send(JSON.stringify(reply));
      },
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/i/host-ok/api/transcript/oc_chat_ok?turn=1`,
        { headers: { cookie: `mb_session=${makeSessionCookie('ou_owner')}` } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(payload);
      expect(seenRoute).toBe('transcript.get');
      expect(seenParams).toEqual({ chatId: 'oc_chat_ok', turn: 1 });
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    }
  });

  it('passes a non-200 dispatcher response through with its status', async () => {
    const ws = await registerFakeInstance({
      port: srv.port,
      instanceId: 'host-404',
      chatIds: ['oc_chat_404'],
      accessAllowOpenIds: ['ou_owner'],
      onRequest: (frame, socket) => {
        const reply: ResponseFrame = {
          type: 'response',
          id: frame.id,
          status: 404,
          body: { error: 'session not found', reason: 'session' },
        };
        socket.send(JSON.stringify(reply));
      },
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/i/host-404/api/transcript/oc_chat_404`,
        { headers: { cookie: `mb_session=${makeSessionCookie('ou_owner')}` } },
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.reason).toBe('session');
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    }
  });

  it('returns 504 when the local instance never answers', async () => {
    const ws = await registerFakeInstance({
      port: srv.port,
      instanceId: 'host-timeout',
      chatIds: ['oc_chat_slow'],
      accessAllowOpenIds: ['ou_owner'],
      // onRequest deliberately omitted — drop incoming `request` frames.
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/i/host-timeout/api/transcript/oc_chat_slow`,
        { headers: { cookie: `mb_session=${makeSessionCookie('ou_owner')}` } },
      );
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body.error).toBe('instance request timed out');
      expect(body.timeoutMs).toBe(200);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    }
  });

  it('returns 503 when the instance disconnects mid-request', async () => {
    const ws = await registerFakeInstance({
      port: srv.port,
      instanceId: 'host-drop',
      chatIds: ['oc_chat_drop'],
      accessAllowOpenIds: ['ou_owner'],
      onRequest: (_frame, socket) => {
        // Drop the connection without replying — registry.remove() should
        // surface InstanceDisconnectedError on the awaiting promise.
        socket.terminate();
      },
    });
    const res = await fetch(
      `http://127.0.0.1:${srv.port}/i/host-drop/api/transcript/oc_chat_drop`,
      { headers: { cookie: `mb_session=${makeSessionCookie('ou_owner')}` } },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(['instance offline', 'instance disconnected mid-request']).toContain(
      body.error,
    );
    ws.close();
  });

  it('serves the transcript SPA index for an unmatched sub-path', async () => {
    const ws = await registerFakeInstance({
      port: srv.port,
      instanceId: 'host-spa',
      chatIds: ['oc_chat_spa'],
      accessAllowOpenIds: ['ou_owner'],
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/i/host-spa/web/transcript/oc_chat_spa`,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Transcript SPA placeholder');
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    }
  });

  it('bypasses auth when disableTranscriptAuth=true (grey-launch mode)', async () => {
    // Start a second short-lived server with auth disabled.
    const greySrv = await startServer({
      port: 0,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:18443',
      sessionSecret: SESSION_SECRET,
      disableTranscriptAuth: true,
      transcriptRequestTimeoutMs: 200,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      logger: silentLogger,
    });
    const ws = await registerFakeInstance({
      port: greySrv.port,
      instanceId: 'host-grey',
      chatIds: ['oc_grey'],
      accessAllowOpenIds: [], // empty whitelist would normally 403
      onRequest: (frame, socket) => {
        const reply: ResponseFrame = {
          type: 'response',
          id: frame.id,
          status: 200,
          body: { chat: { chatId: 'oc_grey', totalTurns: 0 }, turn: 1, messages: [] },
        };
        socket.send(JSON.stringify(reply));
      },
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${greySrv.port}/i/host-grey/api/transcript/oc_grey`,
      );
      expect(res.status).toBe(200);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
      await greySrv.close();
    }
  });
});
