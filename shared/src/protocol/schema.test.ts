import { describe, it, expect } from 'vitest';
import { parseFrame } from './schema.js';
import type { WsFrame } from './frames.js';

describe('parseFrame', () => {
  it('accepts a register frame', () => {
    const frame: WsFrame = {
      type: 'register',
      instanceId: 'host-a3f9bc',
      publicKey: 'pk-xxx',
      bots: [{ name: 'sa', hubVisible: true }],
      version: '1.0.0',
      signature: 'sig',
      nonce: 'n1',
    };
    expect(parseFrame(frame)).toEqual(frame);
  });

  it('accepts a request frame with timeoutMs', () => {
    const frame: WsFrame = {
      type: 'request',
      id: 'req-1',
      route: 'transcript.get',
      params: { chatId: 'oc_abc' },
      timeoutMs: 5000,
    };
    expect(parseFrame(frame)).toEqual(frame);
  });

  it('accepts a request frame without timeoutMs', () => {
    const frame: WsFrame = {
      type: 'request',
      id: 'req-1',
      route: 'transcript.get',
      params: {},
    };
    expect(parseFrame(frame)).toEqual(frame);
  });

  it('rejects request with non-positive timeoutMs', () => {
    expect(() =>
      parseFrame({
        type: 'request',
        id: 'r',
        route: 'x',
        params: {},
        timeoutMs: 0,
      }),
    ).toThrow();
  });

  it('rejects unknown frame type', () => {
    expect(() => parseFrame({ type: 'bogus' })).toThrow();
  });

  it('round-trips a response frame', () => {
    const frame: WsFrame = {
      type: 'response',
      id: 'req-1',
      status: 200,
      body: { ok: true },
    };
    expect(parseFrame(frame)).toEqual(frame);
  });
});
