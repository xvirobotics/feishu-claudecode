import type * as http from 'node:http';
import { handleVoiceRequest } from '../voice-handler.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleVoiceRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger, twilioHandler } = ctx;

  // POST /api/call — initiate outbound phone call
  if (method === 'POST' && url === '/api/call') {
    if (!twilioHandler) {
      jsonResponse(res, 400, { error: 'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.' });
      return true;
    }

    const body = await parseJsonBody(req);
    const phone = (body.phone as string) || '';
    const message = body.message as string | undefined;
    const botName = (body.botName as string) || 'default';
    const chatId = (body.chatId as string) || `twilio-${phone}`;

    if (!phone) {
      jsonResponse(res, 400, { error: 'Missing required field: phone (E.164 format, e.g. +1234567890)' });
      return true;
    }

    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }

    try {
      const result = await twilioHandler.initiateCall({ phone, message, botName, chatId });
      jsonResponse(res, 200, result);
    } catch (err: any) {
      logger.error({ err, phone, botName }, 'Failed to initiate outbound call');
      jsonResponse(res, 500, { error: `Failed to initiate call: ${err.message}` });
    }
    return true;
  }

  // POST /api/voice — STT + Agent + optional TTS
  if (method === 'POST' && (url === '/api/voice' || url.startsWith('/api/voice?'))) {
    await handleVoiceRequest(req, res, registry, logger);
    return true;
  }

  return false;
}
