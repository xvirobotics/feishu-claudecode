import * as http from 'node:http';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from './bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { DocSync } from '../sync/doc-sync.js';
import type { PeerManager } from './peer-manager.js';

import type { PushService } from './push-service.js';
import type { DeviceStore } from './device-store.js';
import { AsyncTaskStore } from './async-task-store.js';
import { setupWebSocketServer, serveStaticFiles, type WebSocketHandle } from '../web/ws-server.js';
import { IntentRouter } from './intent-router.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { BudgetManager } from './budget-manager.js';
import { TeamManager } from './team-manager.js';
import { VoiceMeetingService } from './voice-meeting.js';
import { VoiceIdentityStore } from './voice-identity.js';
import { metrics } from '../utils/metrics.js';
import {
  jsonResponse,
  handleVoiceRoutes,
  handleFileRoutes,
  handleTeamRoutes,
  handleTaskRoutes,
  handleBotRoutes,
  handleSyncRoutes,
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
  memoryServerUrl?: string;
  memoryAuthToken?: string;
  pushService?: PushService;
  deviceStore?: DeviceStore;
  circuitBreaker?: CircuitBreaker;
  budgetManager?: BudgetManager;
  teamManager?: TeamManager;
}

const startTime = Date.now();
// Expose start time for metrics route
(globalThis as any).__metabot_start_time = startTime;

export function startApiServer(options: ApiServerOptions): http.Server {
  const { port, secret, registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient, peerManager, memoryServerUrl, memoryAuthToken, pushService, deviceStore } = options;
  const host = secret ? '0.0.0.0' : '127.0.0.1';

  // Initialize shared services
  const asyncTaskStore = new AsyncTaskStore();
  const intentRouter = new IntentRouter(logger);
  const circuitBreaker = options.circuitBreaker ?? new CircuitBreaker(logger);
  const budgetManager = options.budgetManager ?? new BudgetManager(logger);
  const teamManager = options.teamManager ?? new TeamManager(logger);
  const meetingService = new VoiceMeetingService(registry, logger);
  const voiceIdentityStore = new VoiceIdentityStore(logger);

  const ws: { handle?: WebSocketHandle } = {};

  // Build route context (shared across all route handlers)
  const ctx: RouteContext = {
    registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient,
    peerManager, memoryServerUrl, memoryAuthToken, pushService,
    deviceStore, asyncTaskStore, intentRouter, circuitBreaker, budgetManager,
    teamManager, meetingService, voiceIdentityStore, ws,
  };

  // Route handlers in priority order
  const routeHandlers = [
    handleVoiceRoutes,
    handleFileRoutes,
    handleTeamRoutes,
    handleTaskRoutes,
    handleBotRoutes,
    handleSyncRoutes,
  ];

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    // Auth check (exempt /web/, /memory/, /api/files/)
    if (secret && !url.startsWith('/web') && !url.startsWith('/memory') && !url.startsWith('/api/files/')) {
      const auth = req.headers.authorization;
      const urlToken = url.includes('token=') ? new URL(url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token') : null;
      if (auth !== `Bearer ${secret}` && urlToken !== secret) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    try {
      // GET /api/health — always handled here (lightweight)
      if (method === 'GET' && url === '/api/health') {
        const peerStatuses = peerManager?.getPeerStatuses() ?? [];
        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          bots: registry.list().length,
          peerBots: peerManager?.getPeerBots().length ?? 0,
          peers: peerStatuses.length,
          peersHealthy: peerStatuses.filter((p) => p.healthy).length,
          scheduledTasks: scheduler.taskCount(),
          recurringTasks: scheduler.recurringTaskCount(),
        });
        return;
      }

      // Dispatch to route handlers
      for (const handler of routeHandlers) {
        if (await handler(ctx, req, res, method, url)) return;
      }

      // Static file serving for Web UI
      if (serveStaticFiles(req, res, url)) return;

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
  ws.handle = setupWebSocketServer(server, registry, logger, secret, peerManager, pushService);

  server.listen(port, host, () => {
    logger.info({ host, port }, 'API server started');
  });

  return server;
}
