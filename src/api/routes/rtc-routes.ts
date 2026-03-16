import type * as http from 'node:http';
import type { RouteContext } from './types.js';
import { jsonResponse, parseJsonBody } from './helpers.js';

export async function handleRtcRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { rtcService, logger } = ctx;

  // POST /api/rtc/start — Start RTC voice chat
  if (method === 'POST' && (url === '/api/rtc/start' || url.startsWith('/api/rtc/start?'))) {
    if (!rtcService) {
      jsonResponse(res, 503, { error: 'RTC not configured. Set VOLC_RTC_APP_ID, VOLC_RTC_APP_KEY, VOLC_ACCESS_KEY_ID, VOLC_SECRET_KEY.' });
      return true;
    }
    try {
      const body = await parseJsonBody(req);
      const result = await rtcService.startVoiceChat({
        systemPrompt: body.systemPrompt as string | undefined,
        welcomeMessage: body.welcomeMessage as string | undefined,
        llmEndpointId: body.llmEndpointId as string | undefined,
        ttsVoice: body.ttsVoice as string | undefined,
        temperature: body.temperature as number | undefined,
        maxTokens: body.maxTokens as number | undefined,
      });
      jsonResponse(res, 200, result);
    } catch (err: any) {
      logger.error({ err }, 'RTC start error');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/rtc/stop — Stop RTC voice chat
  if (method === 'POST' && (url === '/api/rtc/stop' || url.startsWith('/api/rtc/stop?'))) {
    if (!rtcService) {
      jsonResponse(res, 503, { error: 'RTC not configured' });
      return true;
    }
    try {
      const body = await parseJsonBody(req);
      if (!body.sessionId) {
        jsonResponse(res, 400, { error: 'sessionId is required' });
        return true;
      }
      await rtcService.stopVoiceChat(body.sessionId as string);
      jsonResponse(res, 200, { success: true });
    } catch (err: any) {
      logger.error({ err }, 'RTC stop error');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/rtc/token — Generate/refresh RTC token
  if (method === 'POST' && (url === '/api/rtc/token' || url.startsWith('/api/rtc/token?'))) {
    if (!rtcService) {
      jsonResponse(res, 503, { error: 'RTC not configured' });
      return true;
    }
    try {
      const body = await parseJsonBody(req);
      if (!body.roomId || !body.userId) {
        jsonResponse(res, 400, { error: 'roomId and userId are required' });
        return true;
      }
      const token = rtcService.generateToken(body.roomId as string, body.userId as string);
      jsonResponse(res, 200, { token });
    } catch (err: any) {
      logger.error({ err }, 'RTC token error');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/rtc/sessions — List active sessions
  if (method === 'GET' && url === '/api/rtc/sessions') {
    if (!rtcService) {
      jsonResponse(res, 200, { sessions: [], configured: false });
      return true;
    }
    jsonResponse(res, 200, { sessions: rtcService.listSessions(), configured: true });
    return true;
  }

  // GET /api/rtc/config — Check RTC configuration status
  if (method === 'GET' && url === '/api/rtc/config') {
    jsonResponse(res, 200, {
      configured: rtcService?.isConfigured() ?? false,
      appId: process.env.VOLC_RTC_APP_ID || null,
      hasIamKeys: !!(process.env.VOLC_ACCESS_KEY_ID && process.env.VOLC_SECRET_KEY),
      hasLlmEndpoint: !!process.env.VOLC_RTC_LLM_ENDPOINT_ID,
    });
    return true;
  }

  return false;
}
