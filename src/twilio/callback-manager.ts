/**
 * Manages async Twilio callbacks — when a task takes too long to respond
 * on the original call, we hang up and call the user back with the result.
 */

import * as crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import {
  resolveTTSProvider, resolveTTSVoice,
  doubaoTTS, openaiTTS, elevenlabsTTS,
} from '../api/voice-handler.js';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  defaultBotName: string;
  callbackNumber?: string;
  baseUrl: string;
}

interface PendingCallback {
  taskId: string;
  userPhone: string;
  createdAt: number;
  /** Pre-generated TTS audio buffer (mp3). */
  audio?: Buffer;
  /** Raw text response (fallback if TTS fails). */
  text?: string;
  /** Whether the callback call has been initiated. */
  called: boolean;
}

export class CallbackManager {
  private pending = new Map<string, PendingCallback>();
  private logger: Logger;
  private config: TwilioConfig;

  constructor(config: TwilioConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ module: 'twilio-callback' });
  }

  /** Generate a unique task ID for tracking. */
  createTaskId(): string {
    return crypto.randomUUID();
  }

  /** Register a pending callback for when the task completes. */
  registerCallback(taskId: string, userPhone: string): void {
    this.pending.set(taskId, {
      taskId,
      userPhone,
      createdAt: Date.now(),
      called: false,
    });
    this.logger.info({ taskId, userPhone }, 'Callback registered');
  }

  /** Called when a task completes — generates TTS and initiates outbound call. */
  async onTaskComplete(taskId: string, responseText: string): Promise<void> {
    const cb = this.pending.get(taskId);
    if (!cb) {
      this.logger.warn({ taskId }, 'No pending callback for task');
      return;
    }

    cb.text = responseText;

    // Generate TTS audio
    try {
      const ttsProvider = resolveTTSProvider('');
      if (ttsProvider) {
        const ttsVoice = resolveTTSVoice('', ttsProvider, responseText);
        // Truncate for TTS
        const maxChars = ttsProvider === 'doubao' ? 300 : 4000;
        const ttsText = responseText.length > maxChars
          ? responseText.slice(0, maxChars - 10) + '... 内容过长已截断。'
          : responseText;

        if (ttsProvider === 'elevenlabs') {
          cb.audio = await elevenlabsTTS(ttsText, ttsVoice);
        } else if (ttsProvider === 'doubao') {
          cb.audio = await doubaoTTS(ttsText, ttsVoice);
        } else {
          cb.audio = await openaiTTS(ttsText, ttsVoice);
        }
        this.logger.info({ taskId, audioSize: cb.audio.length, ttsProvider }, 'TTS audio generated for callback');
      }
    } catch (err: any) {
      this.logger.error({ err, taskId }, 'TTS generation failed for callback, will use <Say> fallback');
    }

    // Initiate outbound call
    await this.initiateCallback(taskId);
  }

  /** Get the audio buffer for a callback (served via HTTP). */
  getCallbackAudio(taskId: string): Buffer | null {
    return this.pending.get(taskId)?.audio ?? null;
  }

  /** Get the text response for a callback (for <Say> fallback). */
  getCallbackText(taskId: string): string | null {
    return this.pending.get(taskId)?.text ?? null;
  }

  /** Clean up a completed callback. */
  cleanup(taskId: string): void {
    this.pending.delete(taskId);
  }

  /** Initiate an outbound Twilio call to deliver the result. */
  private async initiateCallback(taskId: string): Promise<void> {
    const cb = this.pending.get(taskId);
    if (!cb || cb.called) return;

    cb.called = true;
    const { accountSid, authToken, phoneNumber, baseUrl } = this.config;
    const callbackVoiceUrl = `${baseUrl}/twilio/callback-voice?taskId=${taskId}`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
    const params = new URLSearchParams({
      To: cb.userPhone,
      From: phoneNumber,
      Url: callbackVoiceUrl,
      StatusCallback: `${baseUrl}/twilio/status`,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Twilio API error: ${response.status} ${err}`);
      }

      const result = await response.json() as any;
      this.logger.info({ taskId, callSid: result.sid, to: cb.userPhone }, 'Callback call initiated');
    } catch (err: any) {
      this.logger.error({ err, taskId, to: cb.userPhone }, 'Failed to initiate callback call');
      // Don't delete — let it be cleaned up by TTL
    }
  }

  /** Store audio for a conversation turn (served via /twilio/callback-audio/:taskId). */
  storeConversationAudio(taskId: string, audio: Buffer): void {
    this.pending.set(taskId, {
      taskId,
      userPhone: '',
      createdAt: Date.now(),
      audio,
      called: true,
    });
  }

  /** Generate TTS audio from text. Returns audio buffer or null if TTS is not configured. */
  async generateTTS(text: string): Promise<Buffer | null> {
    const ttsProvider = resolveTTSProvider('');
    if (!ttsProvider) return null;

    const ttsVoice = resolveTTSVoice('', ttsProvider, text);
    const maxChars = ttsProvider === 'doubao' ? 300 : 4000;
    const ttsText = text.length > maxChars
      ? text.slice(0, maxChars - 10) + '... 内容过长已截断。'
      : text;

    if (ttsProvider === 'elevenlabs') return elevenlabsTTS(ttsText, ttsVoice);
    if (ttsProvider === 'doubao') return doubaoTTS(ttsText, ttsVoice);
    return openaiTTS(ttsText, ttsVoice);
  }

  /** Initiate an outbound call for the /api/call endpoint. */
  async initiateOutboundCall(options: {
    userPhone: string;
    message?: string;
    botName: string;
    chatId: string;
  }): Promise<{ callSid: string; taskId: string }> {
    const { accountSid, authToken, phoneNumber, baseUrl } = this.config;
    const taskId = this.createTaskId();

    // If message is provided, generate TTS audio
    if (options.message) {
      try {
        const audio = await this.generateTTS(options.message);
        this.pending.set(taskId, {
          taskId,
          userPhone: options.userPhone,
          createdAt: Date.now(),
          audio: audio ?? undefined,
          text: options.message,
          called: false,
        });
      } catch (err: any) {
        this.logger.error({ err, taskId }, 'TTS failed for outbound call message');
        // Store text-only fallback
        this.pending.set(taskId, {
          taskId,
          userPhone: options.userPhone,
          createdAt: Date.now(),
          text: options.message,
          called: false,
        });
      }
    }

    // Build TwiML URL for when the call is answered
    const twimlUrl = options.message
      ? `${baseUrl}/twilio/outbound-voice?taskId=${taskId}&chatId=${encodeURIComponent(options.chatId)}&botName=${encodeURIComponent(options.botName)}`
      : `${baseUrl}/twilio/outbound-voice?chatId=${encodeURIComponent(options.chatId)}&botName=${encodeURIComponent(options.botName)}`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
    const params = new URLSearchParams({
      To: options.userPhone,
      From: phoneNumber,
      Url: twimlUrl,
      StatusCallback: `${baseUrl}/twilio/status`,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Twilio API error: ${response.status} ${err}`);
    }

    const result = await response.json() as any;
    this.logger.info({ taskId, callSid: result.sid, to: options.userPhone }, 'Outbound call initiated');
    return { callSid: result.sid, taskId };
  }

  /** Periodic cleanup of stale callbacks (>1 hour). */
  cleanupStale(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [taskId, cb] of this.pending) {
      if (cb.createdAt < cutoff) {
        this.pending.delete(taskId);
        this.logger.info({ taskId }, 'Cleaned up stale callback');
      }
    }
  }
}
