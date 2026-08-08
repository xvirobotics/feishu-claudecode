import * as http from 'node:http';
import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import { loadAppConfig } from '../config.js';
import type { AgentTeamConfig } from '../agent-teams/team-store.js';
import type { BotChannelStatus, BotRegistry } from './bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { DocSync } from '../sync/doc-sync.js';
import type { PeerManager } from './peer-manager.js';

import { AsyncTaskStore } from './async-task-store.js';
import {
  bearerTokenFromAuthorization,
  setupWebSocketServer,
  timingSafeStrEqual,
  type WebSocketHandle,
} from '../web/ws-server.js';
export { bearerTokenFromAuthorization } from '../web/ws-server.js';
import { rateLimiterFromEnv, resolveClientIp } from './request-rate-limiter.js';
import { IntentRouter } from './intent-router.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { BudgetManager } from './budget-manager.js';
import { TeamManager } from './team-manager.js';
import { VoiceMeetingService } from './voice-meeting.js';
import { VoiceIdentityStore } from './voice-identity.js';
import { RtcVoiceChatService } from './rtc-voice-chat.js';
import { ActivityStore } from './activity-store.js';
import { AgentTeamStore } from '../agent-teams/team-store.js';
import { AgentTeamSupervisor } from '../agent-teams/team-supervisor.js';
import { metrics as _metrics } from '../utils/metrics.js';
import type { SessionRegistry } from '../session/session-registry.js';
import {
  jsonResponse,
  acceptCoreChatRun,
  answerCoreChatRun,
  cancelCoreChatRun,
  handleCoreChatRoutes,
  handleVoiceRoutes,
  handleFileRoutes,
  handleTeamRoutes,
  handleTaskRoutes,
  handleBotRoutes,
  handleSyncRoutes,
  handleRtcRoutes,
  handleSessionRoutes,
  handleExecutorRoutes,
  handleAgentTeamRoutes,
  parseCoreChatRunRequest,
} from './routes/index.js';
import type { RouteContext } from './routes/index.js';

interface ApiServerOptions {
  port: number;
  secret?: string;
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
  docSync?: DocSync;
  feishuServiceClient?: lark.Client;
  peerManager?: PeerManager;
  circuitBreaker?: CircuitBreaker;
  budgetManager?: BudgetManager;
  teamManager?: TeamManager;
  agentTeamStore?: AgentTeamStore;
  agentTeams?: AgentTeamConfig[];
  sessionRegistry?: SessionRegistry;
}

const startTime = Date.now();
// Expose start time for metrics route
(globalThis as any).__metabot_start_time = startTime;

const WHOAMI_VERIFY_TIMEOUT_MS = 5_000;

export function resolveApiHost(env: NodeJS.ProcessEnv = process.env): string {
  return (env.API_HOST || env.METABOT_API_HOST || '127.0.0.1').trim() || '127.0.0.1';
}

export function isLocalSecretAuthorized(secret: string | undefined, authorization: string | string[] | undefined): boolean {
  if (!secret) return false;
  const bearer = bearerTokenFromAuthorization(authorization);
  return timingSafeStrEqual(bearer, secret);
}

export function summarizeChannelStatuses(channelStatuses: BotChannelStatus[]) {
  return {
    total: channelStatuses.length,
    connected: channelStatuses.filter((channel) => channel.state === 'connected').length,
    reconnecting: channelStatuses.filter(
      (channel) => channel.state === 'connecting' || channel.state === 'reconnecting',
    ).length,
    idle: channelStatuses.filter((channel) => channel.state === 'idle').length,
    failed: channelStatuses.filter((channel) => channel.state === 'failed').length,
    items: channelStatuses,
  };
}

/**
 * Routes that accept the dual-auth gate: local secret OR a Bearer that
 * metabot-core `/api/whoami` validates. Covers the cross-bridge RPC entry
 * points (`/api/talk`, `/api/tasks`) plus the read-only peer-discovery
 * endpoints that peer-manager polls — without these, peer state can never
 * become healthy across hosts that don't share a local secret.
 */
export function isCrossVerifyRoute(method: string, url: string): boolean {
  if (method === 'POST' && (url === '/api/talk' || url.startsWith('/api/talk?'))) return true;
  if (method === 'POST' && (url === '/api/tasks' || url.startsWith('/api/tasks?'))) return true;
  if (method === 'GET' && url.startsWith('/api/talk/')) return true;
  if (method === 'GET' && (url === '/api/bots' || url.startsWith('/api/bots?'))) return true;
  if (method === 'GET' && (url === '/api/skills' || url.startsWith('/api/skills?'))) return true;
  if (method === 'GET' && (url === '/api/peers' || url.startsWith('/api/peers?'))) return true;
  return false;
}

function metabotCoreBaseUrl(): string | undefined {
  const candidates = [process.env.METABOT_CORE_AGENT_BUS_URL, process.env.METABOT_CORE_URL];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed) return trimmed.replace(/\/+$/, '');
  }
  return undefined;
}

/**
 * Verify a Bearer header against metabot-core `GET /api/whoami`. Returns true
 * only on HTTP 200. Fails closed on any error (network, non-200, timeout).
 */
async function verifyBearerViaMetabotCore(
  authHeader: string,
  logger: Logger,
): Promise<boolean> {
  const base = metabotCoreBaseUrl();
  if (!base) {
    logger.warn(
      'cross-bridge talk attempted but METABOT_CORE_AGENT_BUS_URL/METABOT_CORE_URL is unset — cannot verify',
    );
    return false;
  }
  try {
    const resp = await fetch(`${base}/api/whoami`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(WHOAMI_VERIFY_TIMEOUT_MS),
    });
    return resp.ok;
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'whoami verification failed');
    return false;
  }
}

export function startApiServer(options: ApiServerOptions): http.Server {
  const { port, secret, registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient, peerManager } = options;
  const host = resolveApiHost();

  // Initialize shared services
  const asyncTaskStore = new AsyncTaskStore();
  const intentRouter = new IntentRouter(logger);
  const circuitBreaker = options.circuitBreaker ?? new CircuitBreaker(logger);
  const budgetManager = options.budgetManager ?? new BudgetManager(logger);
  const teamManager = options.teamManager ?? new TeamManager(logger);
  const agentTeamStore = options.agentTeamStore ?? new AgentTeamStore(logger);
  const meetingService = new VoiceMeetingService(registry, logger);
  const voiceIdentityStore = new VoiceIdentityStore(logger);
  const activityStore = new ActivityStore(logger);
  const agentTeamSupervisor = new AgentTeamSupervisor({ registry, store: agentTeamStore, logger });
  if (options.agentTeams?.length) {
    agentTeamStore.reconcileTeams(options.agentTeams);
    logger.info({ count: options.agentTeams.length }, 'Agent teams reconciled from config');
  }
  const agentTeamsConfigWatcher = watchAgentTeamsConfig({
    botsConfigPath,
    store: agentTeamStore,
    logger,
  });
  const rtcService = new RtcVoiceChatService(logger);
  if (rtcService.isConfigured()) {
    logger.info('RTC voice chat service enabled');
  }

  const ws: { handle?: WebSocketHandle } = {};

  // Per-IP in-memory rate limiter (global ceiling + failed-auth backoff).
  // Configurable via METABOT_RATE_LIMIT_MAX / METABOT_RATE_LIMIT_AUTH_FAILS,
  // disabled via METABOT_RATE_LIMIT_DISABLED=1.
  const rateLimiter = rateLimiterFromEnv();
  rateLimiter.startSweep();

  // Build route context (shared across all route handlers)
  const ctx: RouteContext = {
    registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient,
    peerManager,
    asyncTaskStore, intentRouter, circuitBreaker, budgetManager,
    teamManager, meetingService, voiceIdentityStore,
    rtcService: rtcService.isConfigured() ? rtcService : undefined,
    ws,
    sessionRegistry: options.sessionRegistry,
    activityStore,
    agentTeamStore,
    agentTeamSupervisor,
  };

  if (peerManager) {
    peerManager.setRelayHandler(async (message) => {
      const parsedContent = parseRelayContent(message.content);
      if (parsedContent && parsedContent.type === 'core-chat-run') {
        const payload = typeof parsedContent.request === 'object' && parsedContent.request !== null
          ? parsedContent.request as Record<string, unknown>
          : parsedContent;
        const parsed = parseCoreChatRunRequest(payload);
        if (!parsed.request) {
          logger.warn({ messageId: message.id, targetBot: message.targetBot, error: parsed.error }, 'invalid core-chat relay payload');
          return;
        }
        const accepted = acceptCoreChatRun(ctx, parsed.request);
        if (accepted.status >= 400) {
          logger.warn({ messageId: message.id, targetBot: message.targetBot, status: accepted.status, body: accepted.body }, 'core-chat relay rejected');
        }
        return;
      }
      if (parsedContent && parsedContent.type === 'core-chat-control') {
        const runId = typeof parsedContent.runId === 'string' ? parsedContent.runId : '';
        const action = parsedContent.action;
        if (!runId || (action !== 'answer' && action !== 'cancel')) {
          logger.warn({ messageId: message.id, targetBot: message.targetBot }, 'invalid core-chat control payload');
          return;
        }
        if (action === 'answer') {
          const toolUseId = typeof parsedContent.toolUseId === 'string' ? parsedContent.toolUseId : '';
          const answer = typeof parsedContent.answer === 'string' ? parsedContent.answer : '';
          const result = answerCoreChatRun(runId, toolUseId, answer);
          if (result.status >= 400) logger.warn({ runId, result }, 'core-chat answer rejected');
        } else {
          const result = await cancelCoreChatRun(ctx, runId);
          if (result.status >= 400) logger.warn({ runId, result }, 'core-chat cancel rejected');
        }
        return;
      }

      const botName = typeof parsedContent?.botName === 'string' && parsedContent.botName
        ? parsedContent.botName
        : message.targetBot;
      const prompt = typeof parsedContent?.prompt === 'string' && parsedContent.prompt
        ? parsedContent.prompt
        : (typeof parsedContent?.content === 'string' && parsedContent.content ? parsedContent.content : message.content);
      const chatId = typeof parsedContent?.chatId === 'string' && parsedContent.chatId
        ? parsedContent.chatId
        : (message.chatId || `agent-inbox-${botName}`);
      const sendCards = typeof parsedContent?.sendCards === 'boolean' ? parsedContent.sendCards : true;
      const bot = registry.get(botName);
      if (!bot) {
        logger.warn({ messageId: message.id, botName, targetBot: message.targetBot }, 'relay inbox target bot not found locally');
        return;
      }
      logger.info({ messageId: message.id, botName, chatId, fromBot: message.fromBot, fromOwner: message.fromOwner }, 'executing relay inbox talk message');
      await bot.bridge.executeApiTask({
        prompt,
        chatId,
        userId: message.fromBot || message.fromOwner || 'agent-bus',
        sendCards,
      });
    });
  }

  for (const bot of registry.listRegistered()) {
    bot.bridge.setAgentTeamStore(agentTeamStore);
  }
  agentTeamSupervisor.start();

  // Route handlers in priority order
  const routeHandlers = [
    handleCoreChatRoutes,
    handleVoiceRoutes,
    handleFileRoutes,
    handleTeamRoutes,
    handleTaskRoutes,
    handleBotRoutes,
    handleSyncRoutes,
    handleRtcRoutes,
    handleSessionRoutes,
    handleExecutorRoutes,
    handleAgentTeamRoutes,
  ];

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    // The browser UI now lives exclusively in the Core Console. Keep the old
    // Bridge URL as a compatibility redirect so bookmarks converge on the
    // single token-authenticated chat surface instead of exposing two apps.
    if (method === 'GET' && (url === '/web' || url.startsWith('/web/'))) {
      const coreUrl = (process.env.METABOT_CORE_URL || 'http://localhost:9200').replace(/\/+$/, '');
      res.writeHead(308, { Location: `${coreUrl}/chat` });
      res.end();
      return;
    }

    // Resolve the client IP. We default to socket.remoteAddress because this
    // bridge is typically NOT behind a trusted reverse proxy; X-Forwarded-For is
    // only honoured when METABOT_TRUST_PROXY=1 (see resolveClientIp).
    const clientIp = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);

    // Rate limiting (global per-IP ceiling + failed-auth backoff). GET
    // /api/health is exempt so liveness/readiness probes are never throttled.
    const isHealthProbe = method === 'GET' && url === '/api/health';
    if (!isHealthProbe) {
      const decision = rateLimiter.check(clientIp);
      if (decision) {
        res.setHeader('Retry-After', String(decision.retryAfterSec));
        jsonResponse(res, decision.status, { error: 'Too Many Requests', reason: decision.reason });
        return;
      }
    }

    // Auth check (output-file routes remain publicly fetchable by opaque URL).
    //
    // /api/talk and /api/tasks routes accept dual auth: the local secret
    // (metabot CLI shortcut, local cross-bot dispatch) OR any Bearer that
    // metabot-core `GET /api/whoami` validates (cross-bridge peer calls,
    // `metabot talk` from any user with a metabot-core token). Every other
    // API stays single-secret.
    // GET /api/health is exempt: it returns only minimal liveness info (see
    // handler below) so probes/load-balancers can hit it without a secret.
    const isPublicHealth = method === 'GET' && url === '/api/health';
    if (!isPublicHealth) {
      const auth = req.headers.authorization;
      // Timing-safe comparison so the secret can't be recovered byte-by-byte.
      const localOk = isLocalSecretAuthorized(secret, auth);

      const rejectUnauthorized = () => {
        // Count this as a failed auth attempt; trips the per-IP lockout once the
        // threshold is crossed. The next request from this IP will see 429.
        rateLimiter.recordAuthFailure(clientIp);
        jsonResponse(res, 401, { error: 'Unauthorized' });
      };

      if (!localOk) {
        const canCrossVerify = isCrossVerifyRoute(method, url) && bearerTokenFromAuthorization(auth) !== undefined;
        if (!canCrossVerify) {
          rejectUnauthorized();
          return;
        }
        const verified = await verifyBearerViaMetabotCore(auth!, logger);
        if (!verified) {
          rejectUnauthorized();
          return;
        }
      }
      // Successful auth — clear any accumulated failed-auth counter so a
      // legitimate client is never throttled by the backoff guard.
      rateLimiter.recordAuthSuccess(clientIp);
    }

    try {
      // GET /api/health — minimal, unauthenticated-safe liveness probe.
      // Deliberately returns ONLY status + uptime so an unauthenticated caller
      // (deploy/k8s probe) can't enumerate peer count, peer health, or peer
      // URLs for reconnaissance. Detailed topology lives behind the
      // authenticated /api/status route.
      if (method === 'GET' && url === '/api/health') {
        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
        });
        return;
      }

      // GET /api/status — same diagnostics that /api/health used to leak, but
      // gated by the auth check above (local secret or cross-verified Bearer).
      if (method === 'GET' && url === '/api/status') {
        const peerStatuses = peerManager?.getPeerStatuses() ?? [];
        const channelStatuses = registry.listChannelStatuses();

        // Process memory (MB). rss = total resident set, heapUsed = V8 heap in use.
        const mem = process.memoryUsage();
        const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

        // Executor-pool stats: reachable here via the same per-bot persistent
        // registry the /api/executors route uses — no new plumbing required.
        // We expose only aggregate counts (total + active turns), not per-chat
        // detail, to keep /api/status lightweight.
        let executorTotal = 0;
        let executorActive = 0;
        for (const bot of registry.listRegistered()) {
          const reg = bot.bridge.getPersistentRegistry?.();
          if (!reg) continue;
          for (const e of reg.list()) {
            executorTotal++;
            if (e.hasActiveTurn) executorActive++;
          }
        }

        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          bots: registry.list().length,
          peerBots: peerManager?.getPeerBots().length ?? 0,
          peers: peerStatuses.length,
          peersHealthy: peerStatuses.filter((p) => p.healthy).length,
          scheduledTasks: scheduler.taskCount(),
          recurringTasks: scheduler.recurringTaskCount(),
          memory: { rssMb: toMb(mem.rss), heapUsedMb: toMb(mem.heapUsed) },
          executors: { total: executorTotal, active: executorActive },
          channels: summarizeChannelStatuses(channelStatuses),
          rateLimit: { trackedIps: rateLimiter.size() },
        });
        return;
      }

      // Dispatch to route handlers
      for (const handler of routeHandlers) {
        if (await handler(ctx, req, res, method, url)) return;
      }

      // 404 fallback
      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        logger.error({ err, method, url }, 'API request error');
      }
      jsonResponse(res, statusCode, { error: err.message || 'Internal server error' });
    }
  });

  // Set up WebSocket server for Web UI streaming
  ws.handle = setupWebSocketServer(server, registry, logger, secret, peerManager, options.sessionRegistry);

  // Wire WebSocket handle to scheduler so scheduled tasks stream updates to clients
  scheduler.setWebSocketHandle(ws.handle);

  // Wire activity events: each bridge records to ActivityStore and broadcasts to WS clients
  for (const bot of registry.listRegistered()) {
    bot.bridge.onActivityEvent = (event) => {
      const recorded = activityStore.record(event);
      ws.handle?.broadcastAll({ type: 'activity_event', event: recorded });
    };
  }

  server.listen(port, host, () => {
    logger.info({ host, port }, 'API server started');
  });
  server.on('close', () => {
    agentTeamsConfigWatcher?.close();
    agentTeamSupervisor.destroy();
    rateLimiter.stopSweep();
  });

  return server;
}

function parseRelayContent(content: string): Record<string, any> | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, any> : undefined;
  } catch {
    return undefined;
  }
}

function watchAgentTeamsConfig(options: {
  botsConfigPath?: string;
  store: AgentTeamStore;
  logger: Logger;
}): fs.FSWatcher | undefined {
  if (!options.botsConfigPath || process.env.METABOT_AGENT_TEAMS_HOT_RELOAD === '0') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const config = loadAppConfig();
        options.store.reconcileTeams(config.agentTeams);
        options.logger.info({ count: config.agentTeams.length }, 'Agent teams hot-reloaded from bots.json');
      } catch (err: any) {
        options.logger.warn({ err: err?.message || err }, 'Agent teams hot reload failed');
      }
    }, 250);
  };
  try {
    const watcher = fs.watch(options.botsConfigPath, reload);
    watcher.unref?.();
    return watcher;
  } catch (err: any) {
    options.logger.warn({ err: err?.message || err, botsConfigPath: options.botsConfigPath }, 'Agent teams hot reload watcher failed');
    return undefined;
  }
}
