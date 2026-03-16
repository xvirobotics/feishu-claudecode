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

  // POST /api/rtc/voice — Agent-initiated voice call (creates room + notifies web clients)
  if (method === 'POST' && (url === '/api/rtc/voice' || url.startsWith('/api/rtc/voice?'))) {
    if (!rtcService) {
      jsonResponse(res, 503, { error: 'RTC not configured' });
      return true;
    }
    try {
      const body = await parseJsonBody(req);
      const botName = body.botName as string | undefined;
      const chatId = body.chatId as string | undefined;
      const prompt = body.prompt as string | undefined;

      // Build system prompt: use provided or default
      const systemPrompt = (body.systemPrompt as string | undefined) ||
        (prompt ? `You are a helpful AI voice assistant. The agent wants to discuss: ${prompt}` : undefined);

      const result = await rtcService.startVoiceChat({
        systemPrompt,
        welcomeMessage: (body.welcomeMessage as string | undefined) || '你好，有什么可以帮你的吗？',
        chatId,
        botName,
        prompt,
      });

      // Notify web clients via WebSocket
      const wsHandle = ctx.ws.handle;
      if (wsHandle && wsHandle.clientCount() > 0) {
        wsHandle.broadcastAll({
          type: 'voice_call',
          sessionId: result.sessionId,
          roomId: result.roomId,
          token: result.token,
          appId: result.appId,
          userId: result.userId,
          aiUserId: result.aiUserId,
          chatId: chatId || '',
          botName: botName || '',
          prompt: prompt || '',
        });
      } else {
        logger.warn('No web clients connected to receive voice call notification');
      }

      // Check if caller wants to wait for completion
      const parsedUrl = new URL(url, 'http://localhost');
      const shouldWait = parsedUrl.searchParams.get('wait') === 'true';

      if (shouldWait) {
        // Long-poll: wait for the call to end, then return with transcript
        const session = await rtcService.waitForCompletion(result.sessionId, 10 * 60 * 1000);
        if (session) {
          const transcript = session.transcript.map(
            (e) => `[${e.speaker === 'ai' ? 'AI' : 'User'}]: ${e.text}`
          ).join('\n');
          jsonResponse(res, 200, {
            ...result,
            status: session.status,
            transcript: session.transcript,
            transcriptText: transcript || '(no transcript collected)',
          });
        } else {
          jsonResponse(res, 200, { ...result, status: 'unknown', transcript: [], transcriptText: '' });
        }
      } else {
        jsonResponse(res, 200, { ...result, status: 'waiting_for_user' });
      }
    } catch (err: any) {
      logger.error({ err }, 'RTC voice error');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/rtc/transcript — Web client submits transcript after call ends
  if (method === 'POST' && (url === '/api/rtc/transcript' || url.startsWith('/api/rtc/transcript?'))) {
    if (!rtcService) {
      jsonResponse(res, 503, { error: 'RTC not configured' });
      return true;
    }
    try {
      const body = await parseJsonBody(req);
      const sessionId = body.sessionId as string;
      if (!sessionId) {
        jsonResponse(res, 400, { error: 'sessionId is required' });
        return true;
      }
      const transcript = body.transcript as Array<{ speaker: string; text: string; timestamp: number }>;
      if (!Array.isArray(transcript)) {
        jsonResponse(res, 400, { error: 'transcript must be an array' });
        return true;
      }

      rtcService.setTranscript(sessionId, transcript.map((e) => ({
        speaker: e.speaker === 'ai' ? 'ai' as const : 'user' as const,
        text: e.text,
        timestamp: e.timestamp,
      })));

      // If this session has a chatId+botName, inject transcript into Claude session
      const session = rtcService.getSession(sessionId);
      if (session?.chatId && session?.botName) {
        const bot = ctx.registry.get(session.botName);
        if (bot) {
          const transcriptText = transcript
            .map((e) => `[${e.speaker === 'ai' ? 'AI' : 'User'}]: ${e.text}`)
            .join('\n');
          const injectPrompt = `[Voice Call Transcript — ${new Date().toLocaleString('zh-CN')}]\n\n${transcriptText}\n\nPlease acknowledge this voice conversation and continue with any follow-up actions discussed.`;
          // Fire-and-forget: inject into Claude session
          bot.bridge.executeApiTask({
            prompt: injectPrompt,
            chatId: session.chatId,
            userId: 'voice-call',
            sendCards: true,
          }).catch((err: any) => {
            logger.error({ err, sessionId }, 'Failed to inject transcript into Claude session');
          });
        }
      }

      jsonResponse(res, 200, { success: true });
    } catch (err: any) {
      logger.error({ err }, 'RTC transcript error');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/rtc/transcript — Retrieve transcript for a session
  if (method === 'GET' && url.startsWith('/api/rtc/transcript')) {
    if (!rtcService) {
      jsonResponse(res, 503, { error: 'RTC not configured' });
      return true;
    }
    const parsedUrl = new URL(url, 'http://localhost');
    const sessionId = parsedUrl.searchParams.get('sessionId');
    if (!sessionId) {
      jsonResponse(res, 400, { error: 'sessionId query param is required' });
      return true;
    }
    const session = rtcService.getSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return true;
    }
    jsonResponse(res, 200, {
      sessionId,
      status: session.status,
      transcript: session.transcript,
      chatId: session.chatId,
      botName: session.botName,
    });
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
