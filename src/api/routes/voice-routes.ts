import type * as http from 'node:http';
import { handleVoiceRequest } from '../voice-handler.js';
import type { RouteContext } from './types.js';

export async function handleVoiceRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger } = ctx;

  // POST /api/voice — STT + Agent + optional TTS
  if (method === 'POST' && (url === '/api/voice' || url.startsWith('/api/voice?'))) {
    await handleVoiceRequest(req, res, registry, logger);
    return true;
  }

  return false;
}
