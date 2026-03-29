import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import { getTeamStatus } from '../team-status.js';
import type { RouteContext } from './types.js';

export async function handleTeamRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, peerManager, intentRouter, circuitBreaker, budgetManager, teamManager, meetingService, voiceIdentityStore } = ctx;

  // GET /api/team/status
  if (method === 'GET' && url === '/api/team/status') {
    const status = await getTeamStatus(registry);
    jsonResponse(res, 200, status);
    return true;
  }

  // POST /api/route — route a message to the best bot
  if (method === 'POST' && url === '/api/route') {
    const body = await parseJsonBody(req);
    const message = body.message as string;
    const currentBot = body.currentBot as string | undefined;
    if (!message) {
      jsonResponse(res, 400, { error: 'Missing required field: message' });
      return true;
    }
    const allBots = [...registry.list(), ...(peerManager?.getPeerBots() ?? [])];
    const result = await intentRouter.route(message, allBots, currentBot);
    jsonResponse(res, 200, result);
    return true;
  }

  // GET /api/router/mode
  if (method === 'GET' && url === '/api/router/mode') {
    jsonResponse(res, 200, { mode: intentRouter.getMode() });
    return true;
  }

  // PUT /api/router/mode
  if (method === 'PUT' && url === '/api/router/mode') {
    const body = await parseJsonBody(req);
    const mode = body.mode as string;
    if (!['auto', 'suggest', 'manual'].includes(mode)) {
      jsonResponse(res, 400, { error: 'Invalid mode. Use: auto, suggest, manual' });
      return true;
    }
    intentRouter.setMode(mode as 'auto' | 'suggest' | 'manual');
    jsonResponse(res, 200, { mode });
    return true;
  }

  // GET /api/budgets
  if (method === 'GET' && url === '/api/budgets') {
    jsonResponse(res, 200, { budgets: budgetManager.getAllBudgets() });
    return true;
  }

  // PUT /api/budgets/:botName
  if (method === 'PUT' && url.match(/^\/api\/budgets\/[^/]+$/)) {
    const botName = decodeURIComponent(url.split('/')[3]);
    const body = await parseJsonBody(req);
    const dailyLimitUsd = body.dailyLimitUsd as number;
    if (typeof dailyLimitUsd !== 'number') {
      jsonResponse(res, 400, { error: 'Missing required field: dailyLimitUsd' });
      return true;
    }
    budgetManager.setLimit(botName, dailyLimitUsd);
    jsonResponse(res, 200, { botName, dailyLimitUsd });
    return true;
  }

  // GET /api/costs/report
  if (method === 'GET' && url.startsWith('/api/costs/report')) {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const period = (parsed.searchParams.get('period') || 'daily') as 'daily' | 'weekly' | 'monthly';
    jsonResponse(res, 200, { period, report: budgetManager.getReport(period) });
    return true;
  }

  // GET /api/circuits
  if (method === 'GET' && url === '/api/circuits') {
    jsonResponse(res, 200, { circuits: circuitBreaker.getStatus() });
    return true;
  }

  // POST /api/circuits/:botName/reset
  if (method === 'POST' && url.match(/^\/api\/circuits\/[^/]+\/reset$/)) {
    const botName = decodeURIComponent(url.split('/')[3]);
    circuitBreaker.reset(botName);
    jsonResponse(res, 200, { reset: true, botName });
    return true;
  }

  // GET /api/teams
  if (method === 'GET' && url === '/api/teams') {
    jsonResponse(res, 200, { teams: teamManager.list() });
    return true;
  }

  // POST /api/teams
  if (method === 'POST' && url === '/api/teams') {
    const body = await parseJsonBody(req);
    const name = body.name as string;
    const members = body.members as string[] | undefined;
    const budgetDailyUsd = body.budgetDailyUsd as number | undefined;
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing required field: name' });
      return true;
    }
    try {
      const team = teamManager.create(name, members, budgetDailyUsd);
      jsonResponse(res, 201, team);
    } catch (err: any) {
      jsonResponse(res, 409, { error: err.message });
    }
    return true;
  }

  // GET /api/teams/:id
  if (method === 'GET' && url.match(/^\/api\/teams\/[^/]+$/) && !url.endsWith('/teams/')) {
    const id = decodeURIComponent(url.split('/')[3]);
    const team = teamManager.get(id) || teamManager.getByName(id);
    if (!team) {
      jsonResponse(res, 404, { error: 'Team not found' });
      return true;
    }
    jsonResponse(res, 200, team);
    return true;
  }

  // PUT /api/teams/:id
  if (method === 'PUT' && url.match(/^\/api\/teams\/[^/]+$/)) {
    const id = decodeURIComponent(url.split('/')[3]);
    const body = await parseJsonBody(req);
    const updated = teamManager.update(id, body as any);
    if (!updated) {
      jsonResponse(res, 404, { error: 'Team not found' });
      return true;
    }
    jsonResponse(res, 200, updated);
    return true;
  }

  // DELETE /api/teams/:id
  if (method === 'DELETE' && url.match(/^\/api\/teams\/[^/]+$/)) {
    const id = decodeURIComponent(url.split('/')[3]);
    const deleted = teamManager.delete(id);
    jsonResponse(res, deleted ? 200 : 404, { deleted });
    return true;
  }

  // POST /api/meetings
  if (method === 'POST' && url === '/api/meetings') {
    const body = await parseJsonBody(req);
    const title = (body.title as string) || 'Team Meeting';
    const chatId = (body.chatId as string) || 'meeting-default';
    const participants = body.participants as Array<{ botName: string; prompt: string }>;

    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      jsonResponse(res, 400, { error: 'Missing required field: participants (array of {botName, prompt})' });
      return true;
    }

    const meetingPromise = meetingService.startMeeting({
      title, chatId, initiatedBy: 'api', participants,
    });

    if (body.async === true) {
      meetingPromise.catch((err) => ctx.logger.error({ err }, 'Meeting failed'));
      const tempId = `meeting-${Date.now()}`;
      jsonResponse(res, 202, { message: 'Meeting started', meetingId: tempId });
      return true;
    }

    const meeting = await meetingPromise;
    jsonResponse(res, 200, meeting);
    return true;
  }

  // GET /api/meetings
  if (method === 'GET' && url === '/api/meetings') {
    jsonResponse(res, 200, { meetings: meetingService.listMeetings() });
    return true;
  }

  // GET /api/meetings/:id
  if (method === 'GET' && url.match(/^\/api\/meetings\/[^/]+$/)) {
    const id = decodeURIComponent(url.split('/')[3]);
    const meeting = meetingService.getMeeting(id);
    if (!meeting) {
      jsonResponse(res, 404, { error: 'Meeting not found' });
      return true;
    }
    jsonResponse(res, 200, meeting);
    return true;
  }

  // GET /api/voice-identities
  if (method === 'GET' && url === '/api/voice-identities') {
    jsonResponse(res, 200, { identities: voiceIdentityStore.list() });
    return true;
  }

  // POST /api/voice-identities
  if (method === 'POST' && url === '/api/voice-identities') {
    const body = await parseJsonBody(req);
    const id = (body.id as string) || `voice-${Date.now()}`;
    const name = body.name as string;
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing required field: name' });
      return true;
    }
    const identity = voiceIdentityStore.register({
      id,
      name,
      phone: body.phone as string | undefined,
      defaultBotTeam: body.defaultBotTeam as string[] | undefined,
      permissions: body.permissions as string[] | undefined,
    });
    jsonResponse(res, 201, identity);
    return true;
  }

  // DELETE /api/voice-identities/:id
  if (method === 'DELETE' && url.match(/^\/api\/voice-identities\/[^/]+$/)) {
    const id = decodeURIComponent(url.split('/')[3]);
    const deleted = voiceIdentityStore.delete(id);
    jsonResponse(res, deleted ? 200 : 404, { deleted });
    return true;
  }

  return false;
}
