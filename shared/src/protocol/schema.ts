import { z } from 'zod';
import type { WsFrame } from './frames.js';

const botMetaSchema = z.object({
  name: z.string().min(1),
  hubVisible: z.boolean(),
  accessAllowOpenIds: z.array(z.string()).optional(),
  chatIds: z.array(z.string()).optional(),
});

const registerSchema = z.object({
  type: z.literal('register'),
  instanceId: z.string().min(1),
  publicKey: z.string().min(1),
  bots: z.array(botMetaSchema),
  version: z.string().min(1),
  signature: z.string().min(1),
  nonce: z.string().min(1),
});

const registerAckSchema = z.object({
  type: z.literal('register_ack'),
  assignedBaseUrl: z.string().url(),
  sessionExpiresAt: z.number().int().nonnegative(),
});

const updateSchema = z.object({
  type: z.literal('update'),
  bots: z.array(botMetaSchema),
});

const requestSchema = z.object({
  type: z.literal('request'),
  id: z.string().min(1),
  route: z.string().min(1),
  params: z.unknown(),
  timeoutMs: z.number().int().positive().optional(),
});

const responseSchema = z.object({
  type: z.literal('response'),
  id: z.string().min(1),
  status: z.number().int(),
  body: z.unknown(),
});

const pingSchema = z.object({
  type: z.literal('ping'),
  ts: z.number(),
});

const pongSchema = z.object({
  type: z.literal('pong'),
  ts: z.number(),
});

const errorSchema = z.object({
  type: z.literal('error'),
  id: z.string().optional(),
  code: z.string().min(1),
  message: z.string(),
});

export const wsFrameSchema = z.discriminatedUnion('type', [
  registerSchema,
  registerAckSchema,
  updateSchema,
  requestSchema,
  responseSchema,
  pingSchema,
  pongSchema,
  errorSchema,
]);

export function parseFrame(raw: unknown): WsFrame {
  return wsFrameSchema.parse(raw) as WsFrame;
}

export const frameSchemas = {
  botMeta: botMetaSchema,
  register: registerSchema,
  register_ack: registerAckSchema,
  update: updateSchema,
  request: requestSchema,
  response: responseSchema,
  ping: pingSchema,
  pong: pongSchema,
  error: errorSchema,
} as const;
