import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleSessionRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!url.startsWith('/api/sessions')) return false;

  const { sessionRegistry } = ctx;
  if (!sessionRegistry) {
    jsonResponse(res, 503, { error: 'Session sync not available' });
    return true;
  }

  // GET /api/sessions?botName=X — list sessions for a bot
  if (method === 'GET' && (url.startsWith('/api/sessions?') || url === '/api/sessions')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const botName = params.get('botName');
    if (!botName) {
      jsonResponse(res, 400, { error: 'botName query parameter required' });
      return true;
    }
    const sessions = sessionRegistry.listSessions(botName);
    jsonResponse(res, 200, { sessions });
    return true;
  }

  // GET /api/sessions/:id/messages — get session message history
  const messagesMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages/);
  if (method === 'GET' && messagesMatch) {
    const sessionId = decodeURIComponent(messagesMatch[1]);
    const session = sessionRegistry.getSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return true;
    }
    const params = new URL(url, 'http://localhost').searchParams;
    const since = params.get('since') ? Number(params.get('since')) : undefined;
    const messages = sessionRegistry.getMessages(sessionId, since);
    jsonResponse(res, 200, { session, messages });
    return true;
  }

  // POST /api/sessions/:id/adopt — link a new chatId to an existing session
  const adoptMatch = url.match(/^\/api\/sessions\/([^/]+)\/adopt$/);
  if (method === 'POST' && adoptMatch) {
    const sessionId = decodeURIComponent(adoptMatch[1]);
    const body = await parseJsonBody(req);
    const { chatId, platform } = body as { chatId?: string; platform?: string };
    if (!chatId) {
      jsonResponse(res, 400, { error: 'chatId required' });
      return true;
    }
    const claudeSessionId = sessionRegistry.linkChatId(sessionId, chatId, platform);
    if (claudeSessionId === undefined && !sessionRegistry.getSession(sessionId)) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return true;
    }
    // Set in SessionManager so future messages resume the conversation
    if (claudeSessionId) {
      const session = sessionRegistry.getSession(sessionId);
      if (session) {
        const bot = ctx.registry.get(session.botName);
        if (bot) {
          bot.bridge.getSessionManager().setSessionId(chatId, claudeSessionId);
        }
      }
    }
    const history = sessionRegistry.getMessages(sessionId);
    jsonResponse(res, 200, { sessionId, claudeSessionId, history });
    return true;
  }

  // GET /api/sessions/:id — get session detail
  const detailMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === 'GET' && detailMatch) {
    const sessionId = decodeURIComponent(detailMatch[1]);
    const session = sessionRegistry.getSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return true;
    }
    const links = sessionRegistry.getLinks(sessionId);
    const messages = sessionRegistry.getMessages(sessionId);
    jsonResponse(res, 200, { session, links, messages });
    return true;
  }

  return false;
}
