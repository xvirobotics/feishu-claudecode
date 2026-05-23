/**
 * MetaBot cloud-split WS protocol frames.
 *
 * All frames are JSON; the outer envelope is `{ type, ... }` and request/response
 * frames carry an `id` (UUID v4) so a cloud→local request can be correlated to
 * the local→cloud response. See docs/internal/cloud-split.md (planned) for the
 * end-to-end design — this file is the wire contract.
 */

export interface BotMeta {
  name: string;
  hubVisible: boolean;
  accessAllowOpenIds?: string[];
  chatIds?: string[];
}

export interface RegisterFrame {
  type: 'register';
  instanceId: string;
  publicKey: string;
  bots: BotMeta[];
  version: string;
  signature: string;
  nonce: string;
}

export interface RegisterAckFrame {
  type: 'register_ack';
  assignedBaseUrl: string;
  sessionExpiresAt: number;
}

export interface UpdateFrame {
  type: 'update';
  bots: BotMeta[];
}

export interface RequestFrame {
  type: 'request';
  id: string;
  route: string;
  params: unknown;
  timeoutMs?: number;
}

export interface ResponseFrame {
  type: 'response';
  id: string;
  status: number;
  body: unknown;
}

export interface PingFrame {
  type: 'ping';
  ts: number;
}

export interface PongFrame {
  type: 'pong';
  ts: number;
}

export interface ErrorFrame {
  type: 'error';
  id?: string;
  code: string;
  message: string;
}

export type WsFrame =
  | RegisterFrame
  | RegisterAckFrame
  | UpdateFrame
  | RequestFrame
  | ResponseFrame
  | PingFrame
  | PongFrame
  | ErrorFrame;

export type WsFrameType = WsFrame['type'];
