/**
 * RTC Voice Chat Service — manages real-time voice chat sessions via Volcengine RTC.
 *
 * The server only acts as a control plane:
 *  - Calls StartVoiceChat OpenAPI to create an AI agent in an RTC room
 *  - Generates RTC tokens for clients to join the room
 *  - Calls StopVoiceChat when the call ends
 *
 * All audio processing (ASR → LLM → TTS) happens in Volcengine's cloud.
 */
import * as crypto from 'node:crypto';
import ServiceModule from '@volcengine/openapi/lib/base/service.js';
import type { Logger } from '../utils/logger.js';
import { generateRtcToken } from './rtc-token.js';

// ---------- Types ----------

export interface TranscriptEntry {
  speaker: 'user' | 'ai';
  text: string;
  timestamp: number;
}

export interface RtcSession {
  id: string;
  roomId: string;
  taskId: string;
  userId: string;
  aiUserId: string;
  status: 'active' | 'stopped';
  createdAt: number;
  stoppedAt?: number;
  chatId?: string;
  botName?: string;
  prompt?: string;
  transcript: TranscriptEntry[];
  /** Resolvers waiting for session completion (for wait=true long-poll) */
  _waiters: Array<(session: RtcSession) => void>;
}

export interface StartRtcCallParams {
  /** System prompt for the AI agent */
  systemPrompt?: string;
  /** Welcome message (AI speaks first) */
  welcomeMessage?: string;
  /** Doubao model endpoint ID (overrides env) */
  llmEndpointId?: string;
  /** TTS voice type (default: BV033_streaming) */
  ttsVoice?: string;
  /** LLM temperature (0-1, default: 0.7) */
  temperature?: number;
  /** Max tokens per response (default: 256) */
  maxTokens?: number;
  /** Claude session chatId (for post-call context injection) */
  chatId?: string;
  /** Bot name (for post-call context injection) */
  botName?: string;
  /** Agent's reason for calling (agent-initiated mode) */
  prompt?: string;
}

export interface StartRtcCallResult {
  sessionId: string;
  roomId: string;
  taskId: string;
  token: string;
  appId: string;
  userId: string;
  aiUserId: string;
}

// ---------- Service ----------

export class RtcVoiceChatService {
  private sessions = new Map<string, RtcSession>();
  private logger: Logger;
  private rtcService: any | null = null;

  constructor(logger: Logger) {
    this.logger = logger.child({ module: 'rtc-voice-chat' });
  }

  /** Check if RTC is configured */
  isConfigured(): boolean {
    return !!(
      process.env.VOLC_RTC_APP_ID &&
      process.env.VOLC_RTC_APP_KEY &&
      process.env.VOLC_ACCESS_KEY_ID &&
      process.env.VOLC_SECRET_KEY
    );
  }

  /** Lazy-init the Volcengine OpenAPI service for RTC */
  private getService(): any {
    if (this.rtcService) return this.rtcService;

    const accessKeyId = process.env.VOLC_ACCESS_KEY_ID;
    const secretKey = process.env.VOLC_SECRET_KEY;
    if (!accessKeyId || !secretKey) {
      throw new Error('VOLC_ACCESS_KEY_ID and VOLC_SECRET_KEY are required for RTC');
    }

    const Svc = (ServiceModule as any).default ?? ServiceModule; // eslint-disable-line @typescript-eslint/no-explicit-any
    this.rtcService = new Svc({
      serviceName: 'rtc',
      host: 'rtc.volcengineapi.com',
      region: 'cn-north-1',
      accessKeyId,
      secretKey,
    });
    return this.rtcService;
  }

  /**
   * Start an RTC voice chat session.
   * Creates an AI agent (Doubao LLM) in an RTC room, returns credentials for the client to join.
   */
  async startVoiceChat(params: StartRtcCallParams = {}): Promise<StartRtcCallResult> {
    const appId = process.env.VOLC_RTC_APP_ID;
    const appKey = process.env.VOLC_RTC_APP_KEY;
    if (!appId || !appKey) {
      throw new Error('VOLC_RTC_APP_ID and VOLC_RTC_APP_KEY are required');
    }

    const sessionId = `rtc-${crypto.randomUUID().slice(0, 8)}`;
    const roomId = `room-${crypto.randomUUID().slice(0, 8)}`;
    const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
    const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
    const aiUserId = `ai-${crypto.randomUUID().slice(0, 8)}`;

    // LLM: prefer EndPointId if set, otherwise use ModelName
    const llmEndpointId = params.llmEndpointId || process.env.VOLC_RTC_LLM_ENDPOINT_ID || '';
    const llmModelName = process.env.VOLC_RTC_LLM_MODEL_NAME || 'doubao-seed-1-6-flash-250828';

    // ASR — dedicated ASR credentials from speech recognition console
    const asrAppId = process.env.VOLC_RTC_ASR_APP_ID || process.env.VOLCENGINE_TTS_APPID || '';
    const asrCluster = process.env.VOLC_RTC_ASR_CLUSTER || 'volcengine_streaming_common';

    // TTS
    const ttsAppId = process.env.VOLCENGINE_TTS_APPID || '';
    const ttsAccessKey = process.env.VOLCENGINE_TTS_ACCESS_KEY || '';
    const ttsVoice = params.ttsVoice || process.env.VOLC_RTC_TTS_VOICE || 'BV001_streaming';

    // Build LLM config — use EndPointId if available, otherwise ModelName
    const llmConfig: Record<string, unknown> = {
      Mode: 'ArkV3',
      SystemMessages: params.systemPrompt ? [params.systemPrompt] : [],
      Temperature: params.temperature ?? 0.7,
      MaxTokens: params.maxTokens ?? 1024,
      HistoryLength: 15,
    };
    if (llmEndpointId) {
      llmConfig.EndPointId = llmEndpointId;
    } else {
      llmConfig.ModelName = llmModelName;
    }

    // Build StartVoiceChat request — matches official rtc-aigc-demo config
    const requestBody = {
      AppId: appId,
      RoomId: roomId,
      TaskId: taskId,
      AgentConfig: {
        UserId: aiUserId,
        TargetUserId: [userId],
        WelcomeMessage: params.welcomeMessage || '你好，有什么可以帮你的吗？',
        AnsMode: 3,
      },
      Config: {
        ASRConfig: {
          Provider: 'volcano',
          ProviderParams: {
            Mode: 'smallmodel',
            AppId: asrAppId,
            Cluster: asrCluster,
          },
        },
        LLMConfig: llmConfig,
        TTSConfig: {
          Provider: 'volcano',
          ProviderParams: {
            app: {
              appid: ttsAppId,
              cluster: 'volcano_tts',
              token: ttsAccessKey,
            },
            audio: {
              voice_type: ttsVoice,
              speed_ratio: 1,
              pitch_ratio: 1,
              volume_ratio: 1,
            },
          },
        },
        InterruptMode: 0,
        SubtitleConfig: {},
        NoiseReductionConfig: {
          Enable: true,
        },
      },
    };

    this.logger.info({ sessionId, roomId, taskId, aiUserId, asrAppId: asrAppId ? 'set' : 'empty' }, 'Starting RTC voice chat');

    // Call Volcengine StartVoiceChat OpenAPI
    const service = this.getService();
    const startVoiceChat = service.createAPI('StartVoiceChat', {
      method: 'POST',
      contentType: 'json',
      Version: '2024-12-01',
    });

    const response = await startVoiceChat(requestBody);
    if (response.ResponseMetadata?.Error) {
      const err = response.ResponseMetadata.Error;
      throw new Error(`StartVoiceChat failed: ${err.Code} ${err.Message}`);
    }

    // Generate RTC token for the client
    const token = generateRtcToken(appId, appKey, roomId, userId);

    // Store session
    const session: RtcSession = {
      id: sessionId,
      roomId,
      taskId,
      userId,
      aiUserId,
      status: 'active',
      createdAt: Date.now(),
      chatId: params.chatId,
      botName: params.botName,
      prompt: params.prompt,
      transcript: [],
      _waiters: [],
    };
    this.sessions.set(sessionId, session);

    this.logger.info({ sessionId, roomId }, 'RTC voice chat started');

    return { sessionId, roomId, taskId, token, appId, userId, aiUserId };
  }

  /** Stop an RTC voice chat session */
  async stopVoiceChat(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn({ sessionId }, 'RTC session not found');
      return;
    }

    if (session.status === 'stopped') return;

    const appId = process.env.VOLC_RTC_APP_ID;
    if (!appId) return;

    this.logger.info({ sessionId, roomId: session.roomId }, 'Stopping RTC voice chat');

    try {
      const service = this.getService();
      const stopVoiceChat = service.createAPI('StopVoiceChat', {
        method: 'POST',
        contentType: 'json',
        Version: '2024-12-01',
      });

      await stopVoiceChat({
        AppId: appId,
        RoomId: session.roomId,
        TaskId: session.taskId,
      });
    } catch (err: any) {
      this.logger.error({ err, sessionId }, 'StopVoiceChat API error');
    }

    session.status = 'stopped';
    session.stoppedAt = Date.now();

    // Notify any waiters (for wait=true long-poll)
    for (const resolve of session._waiters) {
      resolve(session);
    }
    session._waiters = [];

    this.logger.info({ sessionId }, 'RTC voice chat stopped');
  }

  /** Generate a fresh RTC token (for token refresh) */
  generateToken(roomId: string, userId: string): string {
    const appId = process.env.VOLC_RTC_APP_ID;
    const appKey = process.env.VOLC_RTC_APP_KEY;
    if (!appId || !appKey) {
      throw new Error('VOLC_RTC_APP_ID and VOLC_RTC_APP_KEY are required');
    }
    return generateRtcToken(appId, appKey, roomId, userId);
  }

  getSession(sessionId: string): RtcSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): RtcSession[] {
    return [...this.sessions.values()].filter((s) => s.status === 'active');
  }

  /** Store transcript for a session */
  setTranscript(sessionId: string, transcript: TranscriptEntry[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.transcript = transcript;
    this.logger.info({ sessionId, entries: transcript.length }, 'Transcript stored');
  }

  /** Get transcript for a session */
  getTranscript(sessionId: string): TranscriptEntry[] {
    return this.sessions.get(sessionId)?.transcript ?? [];
  }

  /** Wait for a session to complete (for long-poll) */
  waitForCompletion(sessionId: string, timeoutMs = 10 * 60 * 1000): Promise<RtcSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve(null);
    if (session.status === 'stopped') return Promise.resolve(session);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        session._waiters = session._waiters.filter((w) => w !== onDone);
        resolve(session); // Return current state even if not stopped
      }, timeoutMs);

      const onDone = (s: RtcSession) => {
        clearTimeout(timer);
        resolve(s);
      };
      session._waiters.push(onDone);
    });
  }

  /** Cleanup expired sessions (older than 2 hours) */
  cleanup(): void {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (session.stoppedAt && session.stoppedAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }
}
