import type * as http from 'node:http';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../../utils/logger.js';
import type { BotRegistry } from '../bot-registry.js';
import type { TaskScheduler } from '../../scheduler/task-scheduler.js';
import type { DocSync } from '../../sync/doc-sync.js';
import type { PeerManager } from '../peer-manager.js';

import type { AsyncTaskStore } from '../async-task-store.js';
import type { IntentRouter } from '../intent-router.js';
import type { CircuitBreaker } from '../circuit-breaker.js';
import type { BudgetManager } from '../budget-manager.js';
import type { TeamManager } from '../team-manager.js';
import type { VoiceMeetingService } from '../voice-meeting.js';
import type { VoiceIdentityStore } from '../voice-identity.js';
import type { RtcVoiceChatService } from '../rtc-voice-chat.js';
import type { WebSocketHandle } from '../../web/ws-server.js';
import type { SessionRegistry } from '../../session/session-registry.js';
import type { ActivityStore } from '../activity-store.js';

export interface RouteContext {
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
  docSync?: DocSync;
  feishuServiceClient?: lark.Client;
  peerManager?: PeerManager;
  memoryServerUrl?: string;
  memoryAuthToken?: string;
  asyncTaskStore: AsyncTaskStore;
  intentRouter: IntentRouter;
  circuitBreaker: CircuitBreaker;
  budgetManager: BudgetManager;
  teamManager: TeamManager;
  meetingService: VoiceMeetingService;
  voiceIdentityStore: VoiceIdentityStore;
  rtcService?: RtcVoiceChatService;
  ws: { handle?: WebSocketHandle };
  sessionRegistry?: SessionRegistry;
  activityStore?: ActivityStore;
}

/**
 * A route handler function. Returns true if it handled the request, false otherwise.
 */
export type RouteHandler = (
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
) => Promise<boolean>;
