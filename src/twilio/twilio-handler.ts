/**
 * Twilio webhook handler — enables Jarvis-style phone call interaction.
 *
 * Call flows:
 *
 * INBOUND:
 *   User calls → greeting → <Record> → /twilio/conversation loop
 *
 * OUTBOUND (via /api/call):
 *   POST /api/call → Twilio outbound call → play message → conversation loop
 *
 * CALLBACK (slow task from inbound):
 *   Task too slow → hang up → task completes → TTS → outbound call → conversation loop
 *
 * CONVERSATION LOOP:
 *   <Record> → /twilio/conversation → STT → Claude (no tools, fast model) → TTS
 *   → <Play> response + <Record> again → loop until hangup or silence
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from '../api/bot-registry.js';
import { CallbackManager, type TwilioConfig } from './callback-manager.js';
import * as twiml from './twiml-builder.js';
import {
  resolveSTTProvider,
  doubaoTranscribe, whisperTranscribe,
  detectAudioExt,
} from '../api/voice-handler.js';

const FAST_RESPONSE_TIMEOUT_MS = 15_000;
const CONVERSATION_TIMEOUT_MS = 25_000;
const ORCHESTRATOR_TIMEOUT_MS = 45_000;

/** Model to use for voice calls (fast, cheap). */
const VOICE_MODEL = process.env.VOICE_MODEL || 'claude-sonnet-4-6';

const VOICE_SYSTEM_PROMPT = [
  '[Voice phone call mode]',
  'You are on a live phone call. Rules:',
  '- Respond in 1-3 concise spoken sentences. Be conversational and natural.',
  '- Do NOT use any tools. You have no tools available.',
  '- Do NOT use markdown, code blocks, or any formatting.',
  '- If the user asks you to do something that requires tools (write code, search files, etc.), say: "I can\'t do that during our call, but I\'ll take note and can help you with that after we hang up."',
  '- Respond in the same language the user speaks.',
].join('\n');

const VOICE_ORCHESTRATOR_PROMPT = [
  '[Voice orchestrator mode]',
  'You are on a live phone call AND can delegate tasks to your agent team. Rules:',
  '- Respond in 1-3 concise spoken sentences. Be conversational and natural.',
  '- You CAN use tools: mb talk (delegate to other bots), mb schedule (schedule tasks), mm search/get (query memory).',
  '- Do NOT use Bash, Write, Edit, or other code tools during the call.',
  '- After delegating, briefly tell the user what you did: "已经让后端团队去处理了"',
  '- Do NOT use markdown, code blocks, or any formatting.',
  '- Respond in the same language the user speaks.',
].join('\n');

const ORCHESTRATOR_ALLOWED_TOOLS = ['Bash']; // mb talk/schedule/mm are Bash commands
const ORCHESTRATOR_MAX_TURNS = 3;

export class TwilioHandler {
  private config: TwilioConfig;
  private registry: BotRegistry;
  private logger: Logger;
  readonly callbacks: CallbackManager;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: TwilioConfig, registry: BotRegistry, logger: Logger) {
    this.config = config;
    this.registry = registry;
    this.logger = logger.child({ module: 'twilio' });
    this.callbacks = new CallbackManager(config, logger);

    // Cleanup stale callbacks every 10 minutes
    this.cleanupInterval = setInterval(() => this.callbacks.cleanupStale(), 10 * 60 * 1000);
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  /**
   * Route a Twilio request to the correct handler.
   * Returns true if the URL was handled, false otherwise.
   */
  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string): Promise<boolean> {
    if (method === 'POST' && url === '/twilio/voice') {
      await this.handleIncomingCall(req, res);
      return true;
    }

    if (method === 'POST' && url === '/twilio/recording') {
      await this.handleRecording(req, res);
      return true;
    }

    if (method === 'POST' && url === '/twilio/conversation') {
      await this.handleConversation(req, res);
      return true;
    }

    if (method === 'POST' && url === '/twilio/status') {
      await this.handleStatus(req, res);
      return true;
    }

    if (method === 'POST' && url === '/twilio/callback-voice') {
      await this.handleCallbackVoice(req, res);
      return true;
    }

    if (method === 'POST' && url === '/twilio/outbound-voice') {
      await this.handleOutboundVoice(req, res);
      return true;
    }

    if (method === 'GET' && url === '/twilio/callback-audio') {
      this.handleCallbackAudio(req, res);
      return true;
    }

    return false;
  }

  /** Initiate an outbound call (used by /api/call). */
  async initiateCall(options: {
    phone: string;
    message?: string;
    botName: string;
    chatId: string;
  }): Promise<{ success: boolean; callSid: string; taskId: string }> {
    const result = await this.callbacks.initiateOutboundCall({
      userPhone: options.phone,
      message: options.message,
      botName: options.botName,
      chatId: options.chatId,
    });
    this.logger.info({ ...options, callSid: result.callSid }, 'Outbound call initiated via API');
    return { success: true, ...result };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Endpoint handlers
  // ───────────────────────────────────────────────────────────────────────────

  /** POST /twilio/voice — incoming call. Routes to conversation loop. */
  private async handleIncomingCall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseFormBody(req);
    const callerPhone = body.From || body.Caller || '';
    const chatId = `twilio-${callerPhone || 'unknown'}`;
    const botName = this.config.defaultBotName;

    this.logger.info({ caller: callerPhone, chatId }, 'Incoming Twilio call');

    const conversationUrl = this.buildConversationUrl(chatId, botName);
    this.respondTwiml(res, twiml.greetingAndContinue(conversationUrl));
  }

  /** POST /twilio/recording — first recording from inbound call (fast/slow path). */
  private async handleRecording(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseFormBody(req);
    const recordingUrl = body.RecordingUrl;
    const callerPhone = body.From || body.Caller || this.config.callbackNumber || '';

    if (!recordingUrl) {
      this.respondTwiml(res, twiml.sayAndHangup('没有收到录音。再见。'));
      return;
    }

    this.logger.info({ recordingUrl, caller: callerPhone }, 'Recording received');

    const audioBuffer = await this.downloadRecording(recordingUrl);
    if (!audioBuffer) {
      this.respondTwiml(res, twiml.sayAndHangup('录音处理出错。再见。'));
      return;
    }

    const transcript = await this.transcribe(audioBuffer);
    if (!transcript) {
      this.respondTwiml(res, twiml.sayAndHangup('没有检测到语音。再见。'));
      return;
    }

    this.logger.info({ transcript, caller: callerPhone }, 'Voice command transcribed');

    const bot = this.registry.get(this.config.defaultBotName);
    if (!bot) {
      this.respondTwiml(res, twiml.sayAndHangup('Bot 不可用。再见。'));
      return;
    }

    const chatId = `twilio-${callerPhone || 'unknown'}`;
    const taskId = this.callbacks.createTaskId();
    const isOrchestrator = process.env.VOICE_ORCHESTRATOR === 'true';

    const taskPromise = bot.bridge.executeApiTask({
      prompt: `${isOrchestrator ? VOICE_ORCHESTRATOR_PROMPT : VOICE_SYSTEM_PROMPT}\n\n${transcript}`,
      chatId,
      userId: `twilio:${callerPhone}`,
      sendCards: false,
      maxTurns: isOrchestrator ? ORCHESTRATOR_MAX_TURNS : 1,
      model: VOICE_MODEL,
      allowedTools: isOrchestrator ? ORCHESTRATOR_ALLOWED_TOOLS : [],
    });

    const timeoutMs = isOrchestrator ? ORCHESTRATOR_TIMEOUT_MS : FAST_RESPONSE_TIMEOUT_MS;
    const raceResult = await Promise.race([
      taskPromise.then((r) => ({ type: 'complete' as const, result: r })),
      new Promise<{ type: 'timeout'; result: null }>((resolve) =>
        setTimeout(() => resolve({ type: 'timeout', result: null }), timeoutMs),
      ),
    ]);

    if (raceResult.type === 'complete' && raceResult.result) {
      // Fast path — respond and enter conversation loop
      const responseText = raceResult.result.responseText || '完成了。';
      this.logger.info({ taskId, responseLength: responseText.length }, 'Fast response on call');

      const conversationUrl = this.buildConversationUrl(chatId, this.config.defaultBotName);
      const audioUrl = await this.generateAndStoreAudio(taskId, responseText);
      this.respondTwiml(res, twiml.respondAndContinue(audioUrl, responseText, conversationUrl));
    } else {
      // Slow path — hang up and queue callback
      this.logger.info({ taskId, caller: callerPhone }, 'Task slow, queuing callback');

      if (callerPhone) {
        this.callbacks.registerCallback(taskId, callerPhone);
        taskPromise.then(async (result) => {
          const responseText = result.responseText || '任务完成。';
          await this.callbacks.onTaskComplete(taskId, responseText);
        }).catch((err) => {
          this.logger.error({ err, taskId }, 'Task failed');
          this.callbacks.onTaskComplete(taskId, '任务执行出错，请重试。').catch(() => {});
        });
        this.respondTwiml(res, twiml.processingAndHangup());
      } else {
        this.respondTwiml(res, twiml.sayAndHangup('正在处理，但没有回拨号码。请稍后查看结果。'));
      }
    }
  }

  /** POST /twilio/conversation — multi-turn conversation loop. */
  private async handleConversation(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const chatId = parsed.searchParams.get('chatId') || '';
    const botName = parsed.searchParams.get('botName') || this.config.defaultBotName;

    const body = await this.parseFormBody(req);
    const recordingUrl = body.RecordingUrl;

    if (!recordingUrl) {
      // No recording = silence timeout, end call gracefully
      this.respondTwiml(res, twiml.sayAndHangup('通话结束。再见。'));
      return;
    }

    const audioBuffer = await this.downloadRecording(recordingUrl);
    if (!audioBuffer) {
      this.respondTwiml(res, twiml.sayAndHangup('录音处理出错。再见。'));
      return;
    }

    const transcript = await this.transcribe(audioBuffer);
    if (!transcript) {
      this.respondTwiml(res, twiml.sayAndHangup('没有检测到语音。再见。'));
      return;
    }

    this.logger.info({ chatId, botName, transcript }, 'Conversation turn');

    const bot = this.registry.get(botName);
    if (!bot) {
      this.respondTwiml(res, twiml.sayAndHangup('Bot 不可用。再见。'));
      return;
    }

    // Execute with fast model, persistent chatId; orchestrator mode allows tools
    const isOrchestrator = process.env.VOICE_ORCHESTRATOR === 'true';
    const taskPromise = bot.bridge.executeApiTask({
      prompt: `${isOrchestrator ? VOICE_ORCHESTRATOR_PROMPT : VOICE_SYSTEM_PROMPT}\n\n${transcript}`,
      chatId,
      userId: 'twilio:conversation',
      sendCards: false,
      maxTurns: isOrchestrator ? ORCHESTRATOR_MAX_TURNS : 1,
      model: VOICE_MODEL,
      allowedTools: isOrchestrator ? ORCHESTRATOR_ALLOWED_TOOLS : [],
    });

    // Safety timeout to avoid Twilio HTTP timeout (~30s); orchestrator gets more time
    const timeoutMs = isOrchestrator ? ORCHESTRATOR_TIMEOUT_MS : CONVERSATION_TIMEOUT_MS;
    const raceResult = await Promise.race([
      taskPromise.then((r) => ({ type: 'complete' as const, result: r })),
      new Promise<{ type: 'timeout'; result: null }>((resolve) =>
        setTimeout(() => resolve({ type: 'timeout', result: null }), timeoutMs),
      ),
    ]);

    const conversationUrl = this.buildConversationUrl(chatId, botName);

    if (raceResult.type === 'complete' && raceResult.result) {
      const responseText = raceResult.result.responseText || '好的。';
      this.logger.info({ chatId, responseLength: responseText.length }, 'Conversation response');

      const taskId = this.callbacks.createTaskId();
      const audioUrl = await this.generateAndStoreAudio(taskId, responseText);
      this.respondTwiml(res, twiml.respondAndContinue(audioUrl, responseText, conversationUrl));
    } else {
      // Timeout — tell user to wait, keep conversation alive
      this.logger.warn({ chatId }, 'Conversation turn timed out');
      this.respondTwiml(res, twiml.respondAndContinue(null, '还在思考中，请稍等再说一次。', conversationUrl));
    }
  }

  /** POST /twilio/status — call status changes (logging). */
  private async handleStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseFormBody(req);
    this.logger.info({ callSid: body.CallSid, status: body.CallStatus }, 'Call status update');
    res.writeHead(200);
    res.end();
  }

  /** POST /twilio/callback-voice — outbound callback call answered. Enter conversation loop. */
  private async handleCallbackVoice(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const taskId = parsed.searchParams.get('taskId') || '';
    const callerPhone = this.config.callbackNumber || '';
    const chatId = `twilio-${callerPhone || 'unknown'}`;
    const botName = this.config.defaultBotName;

    if (!taskId) {
      this.respondTwiml(res, twiml.sayAndHangup('Error: no task reference.'));
      return;
    }

    // Play the result, then enter conversation loop
    const audio = this.callbacks.getCallbackAudio(taskId);
    const text = this.callbacks.getCallbackText(taskId) || '任务完成。';
    const conversationUrl = this.buildConversationUrl(chatId, botName);

    const audioUrl = audio
      ? `${this.config.baseUrl}/twilio/callback-audio?taskId=${taskId}`
      : null;

    this.respondTwiml(res, twiml.respondAndContinue(audioUrl, text, conversationUrl));

    // Schedule cleanup
    setTimeout(() => this.callbacks.cleanup(taskId), 120_000);
  }

  /** POST /twilio/outbound-voice — outbound call answered (from /api/call). */
  private async handleOutboundVoice(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const taskId = parsed.searchParams.get('taskId') || '';
    const chatId = parsed.searchParams.get('chatId') || '';
    const botName = parsed.searchParams.get('botName') || this.config.defaultBotName;

    const conversationUrl = this.buildConversationUrl(chatId, botName);

    if (taskId) {
      // Has a pre-recorded message to play first
      const audio = this.callbacks.getCallbackAudio(taskId);
      const text = this.callbacks.getCallbackText(taskId) || '';
      const audioUrl = audio
        ? `${this.config.baseUrl}/twilio/callback-audio?taskId=${taskId}`
        : null;
      this.respondTwiml(res, twiml.respondAndContinue(audioUrl, text, conversationUrl));
      setTimeout(() => this.callbacks.cleanup(taskId), 120_000);
    } else {
      // No message — greet and start conversation
      this.respondTwiml(res, twiml.greetingAndContinue(conversationUrl));
    }
  }

  /** GET /twilio/callback-audio?taskId=xxx — serve TTS audio. */
  private handleCallbackAudio(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const taskId = parsed.searchParams.get('taskId') || '';
    const audio = this.callbacks.getCallbackAudio(taskId);

    if (!audio) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length.toString(),
      'Cache-Control': 'no-cache',
    });
    res.end(audio);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private buildConversationUrl(chatId: string, botName: string): string {
    return `${this.config.baseUrl}/twilio/conversation?chatId=${encodeURIComponent(chatId)}&botName=${encodeURIComponent(botName)}`;
  }

  /** Download a Twilio recording. Returns audio buffer or null on error. */
  private async downloadRecording(recordingUrl: string): Promise<Buffer | null> {
    try {
      const audioUrl = `${recordingUrl}.wav`;
      const audioRes = await fetch(audioUrl, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64'),
        },
      });
      if (!audioRes.ok) throw new Error(`Download failed: ${audioRes.status}`);
      return Buffer.from(await audioRes.arrayBuffer());
    } catch (err: any) {
      this.logger.error({ err, recordingUrl }, 'Failed to download recording');
      return null;
    }
  }

  /** Transcribe audio buffer to text. Returns transcript or empty string. */
  private async transcribe(audioBuffer: Buffer): Promise<string> {
    try {
      const sttProvider = resolveSTTProvider('');
      const ext = detectAudioExt(undefined, audioBuffer);
      const transcript = sttProvider === 'whisper'
        ? await whisperTranscribe(audioBuffer, ext, 'zh', this.logger)
        : await doubaoTranscribe(audioBuffer, ext, this.logger);
      return transcript.trim();
    } catch (err: any) {
      this.logger.error({ err }, 'STT failed');
      return '';
    }
  }

  /** Generate TTS audio, store it, and return the URL (or null for <Say> fallback). */
  private async generateAndStoreAudio(taskId: string, text: string): Promise<string | null> {
    try {
      const audio = await this.callbacks.generateTTS(text);
      if (audio) {
        this.callbacks.storeConversationAudio(taskId, audio);
        setTimeout(() => this.callbacks.cleanup(taskId), 120_000);
        return `${this.config.baseUrl}/twilio/callback-audio?taskId=${taskId}`;
      }
    } catch (err: any) {
      this.logger.error({ err }, 'TTS failed, using <Say> fallback');
    }
    return null;
  }

  /** Validate Twilio request signature (optional). */
  validateSignature(req: http.IncomingMessage, body: string): boolean {
    const signature = req.headers['x-twilio-signature'] as string | undefined;
    if (!signature) return false;

    const url = `${this.config.baseUrl}${req.url || '/'}`;
    const params = new URLSearchParams(body);
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const data = url + sorted.map(([k, v]) => k + v).join('');

    const expected = crypto.createHmac('sha1', this.config.authToken)
      .update(data)
      .digest('base64');

    return signature === expected;
  }

  /** Parse URL-encoded form body (Twilio sends application/x-www-form-urlencoded). */
  private parseFormBody(req: http.IncomingMessage): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(raw);
        const result: Record<string, string> = {};
        for (const [key, value] of params) {
          result[key] = value;
        }
        resolve(result);
      });
      req.on('error', reject);
    });
  }

  /** Send TwiML XML response. */
  private respondTwiml(res: http.ServerResponse, xml: string): void {
    const buf = Buffer.from(xml, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'application/xml',
      'Content-Length': buf.length.toString(),
    });
    res.end(buf);
  }
}
