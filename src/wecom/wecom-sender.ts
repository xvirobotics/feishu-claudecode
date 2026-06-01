import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WSClient, WsFrameHeaders } from '@wecom/aibot-node-sdk';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState, CardStatus } from '../types.js';
import type { Logger } from '../utils/logger.js';

/** WeCom stream content hard limit is 20480 bytes; keep a safe margin. */
const STREAM_MAX_CHARS = 8000;
/** Active-push markdown messages are chunked to avoid WeCom length limits. */
const MARKDOWN_MAX_CHARS = 3500;
/** How long to keep a finished stream mapping around (for late retries). */
const STREAM_TTL_MS = 60_000;

const STATUS_HINT: Record<CardStatus, string> = {
  thinking: '🤔 正在思考...',
  running: '🔧 正在处理...',
  complete: '',
  error: '',
  waiting_for_input: '',
};

interface StreamEntry {
  /** Original incoming frame (carries req_id). Undefined falls back to active push. */
  frame: WsFrameHeaders | undefined;
  streamId: string;
  chatId: string;
  /** Set once a finish=true frame was sent successfully (idempotency for retries). */
  finished: boolean;
}

/**
 * WeCom (企业微信) implementation of {@link IMessageSender}.
 *
 * Maps the bridge's `sendCard → updateCard* → final updateCard` lifecycle onto the
 * WeCom long-connection streaming reply protocol (`aibot_respond_msg` with a shared
 * `stream.id`): the first reply opens the stream, intermediate replies refresh its
 * content (full replacement, not delta), and the terminal reply closes it with
 * `finish=true`. Streaming replies are bound to the req_id of the incoming message
 * frame, so the bot binds each frame via {@link WecomSender.bindFrame} before
 * dispatching to the bridge.
 *
 * Command responses, notices, plan content and output files are delivered via the
 * active-push channel (`aibot_send_msg`), which is not tied to an incoming frame.
 */
export class WecomSender implements IMessageSender {
  /** The terminal stream frame already carries the full response — skip the extra notice. */
  skipCompletionNotice = true;

  /** messageId → stream mapping. */
  private streams = new Map<string, StreamEntry>();
  /** chatId → most recent incoming frame, captured at sendCard time. */
  private boundFrames = new Map<string, WsFrameHeaders>();

  constructor(
    private client: WSClient,
    private logger: Logger,
  ) {}

  /**
   * Associate the latest incoming frame with a chat so the next streaming reply can
   * reuse its req_id. Called by the bot dispatcher right before `bridge.handleMessage`.
   */
  bindFrame(chatId: string, frame: WsFrameHeaders): void {
    this.boundFrames.set(chatId, frame);
  }

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    const frame = this.boundFrames.get(chatId);
    const streamId = generateStreamId();
    const messageId = `wecom:${chatId}:${streamId}`;
    this.streams.set(messageId, { frame, streamId, chatId, finished: false });

    if (!frame) {
      this.logger.warn({ chatId }, 'WeCom sendCard without a bound frame; will fall back to active push');
      return messageId;
    }

    // Best-effort initial stream frame so the user sees immediate feedback.
    // Fire-and-forget so task startup isn't blocked on the ack round-trip.
    this.client.replyStream(frame, streamId, renderStreamContent(state), false).catch((err) => {
      this.logger.debug({ err, chatId }, 'WeCom initial stream reply failed (will retry on update)');
    });
    return messageId;
  }

  async updateCard(messageId: string, state: CardState): Promise<void> {
    const entry = this.streams.get(messageId);
    if (!entry) {
      this.logger.warn({ messageId }, 'Cannot update unknown WeCom stream');
      return;
    }

    const content = renderStreamContent(state);
    const terminal = state.status === 'complete' || state.status === 'error';

    // Terminal: close the stream. Let errors propagate so MessageBridge.sendFinalCard
    // can retry; on success mark finished so retries become no-ops.
    if (terminal) {
      if (entry.finished) return;
      if (entry.frame) {
        await this.client.replyStream(entry.frame, entry.streamId, content, true);
      } else {
        await this.activePush(entry.chatId, content);
      }
      entry.finished = true;
      setTimeout(() => this.streams.delete(messageId), STREAM_TTL_MS);
      return;
    }

    if (!entry.frame) return; // no channel for live updates without a frame

    // Pending question must be delivered reliably → blocking reply.
    if (state.status === 'waiting_for_input') {
      try {
        await this.client.replyStream(entry.frame, entry.streamId, content, false);
      } catch (err) {
        this.logger.debug({ err, messageId }, 'WeCom question stream update failed');
      }
      return;
    }

    // Intermediate progress → non-blocking (skips if a prior ack is still pending,
    // preventing throttled progress frames from queuing up).
    try {
      await this.client.replyStreamNonBlocking(entry.frame, entry.streamId, content, false);
    } catch (err) {
      this.logger.debug({ err, messageId }, 'WeCom intermediate stream update failed');
    }
  }

  async sendTextNotice(chatId: string, title: string, content: string, _color?: string): Promise<void> {
    await this.sendText(chatId, `**${title}**\n\n${content}`);
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.activePush(chatId, text);
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send WeCom text');
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    try {
      const buffer = await fs.readFile(filePath);
      const result = await this.client.uploadMedia(buffer, { type: 'image', filename: path.basename(filePath) });
      await this.client.sendMediaMessage(chatId, 'image', result.media_id);
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send WeCom image');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    try {
      const buffer = await fs.readFile(filePath);
      const result = await this.client.uploadMedia(buffer, { type: 'file', filename: fileName });
      await this.client.sendMediaMessage(chatId, 'file', result.media_id);
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send WeCom file');
      return false;
    }
  }

  async downloadImage(_messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    return this.downloadMedia(imageKey, savePath);
  }

  async downloadFile(_messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    return this.downloadMedia(fileKey, savePath);
  }

  private async downloadMedia(ref: string, savePath: string): Promise<boolean> {
    const { url, aesKey } = decodeMediaRef(ref);
    if (!url) return false;
    try {
      const { buffer } = await this.client.downloadFile(url, aesKey);
      await fs.writeFile(savePath, buffer);
      return true;
    } catch (err) {
      this.logger.error({ err, savePath }, 'Failed to download WeCom media');
      return false;
    }
  }

  /** Push one or more markdown messages to a chat via the active-send channel. */
  private async activePush(chatId: string, markdown: string): Promise<void> {
    for (const chunk of splitText(markdown, MARKDOWN_MAX_CHARS)) {
      await this.client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } });
    }
  }
}

/** Encode a media reference as `aesKey|url` for later download (aesKey never contains `|`). */
export function encodeMediaRef(aesKey: string | undefined, url: string): string {
  return `${aesKey || ''}|${url}`;
}

/** Decode an `aesKey|url` media reference. */
function decodeMediaRef(ref: string): { aesKey: string | undefined; url: string } {
  const i = ref.indexOf('|');
  if (i < 0) return { aesKey: undefined, url: ref };
  const aesKey = ref.slice(0, i);
  return { aesKey: aesKey || undefined, url: ref.slice(i + 1) };
}

/** Generate a unique stream id (`stream_{timestamp}_{random}`). */
function generateStreamId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `stream_${Date.now()}_${random}`;
}

/**
 * Render a CardState into Markdown for the WeCom stream bubble.
 * Each call produces the full content (WeCom replaces, not appends).
 */
function renderStreamContent(state: CardState): string {
  const parts: string[] = [];

  // Tool-call progress (only while not yet complete).
  if (state.toolCalls.length > 0 && state.status !== 'complete') {
    for (const t of state.toolCalls.slice(-8)) {
      const icon = t.status === 'done' ? '✅' : '⏳';
      const detail = t.detail && t.detail.length > 100 ? t.detail.slice(0, 100) + '…' : t.detail;
      parts.push(`${icon} ${t.name}${detail ? ' `' + detail + '`' : ''}`);
    }
    parts.push('');
  }

  // Main response text (or a status hint while still empty).
  if (state.responseText) {
    parts.push(state.responseText);
  } else {
    const hint = STATUS_HINT[state.status];
    if (hint) parts.push(hint);
  }

  // Pending question.
  if (state.pendingQuestion) {
    parts.push('', '⚠️ 需要你的选择：');
    for (const q of state.pendingQuestion.questions) {
      parts.push('', `**${q.header}** ${q.question}`);
      q.options.forEach((opt, i) => {
        parts.push(`${i + 1}. ${opt.label} — ${opt.description}`);
      });
      parts.push(`${q.options.length + 1}. 其他（输入自定义回答）`);
    }
    parts.push('', '_回复数字选择，或直接输入自定义答案_');
  }

  // Error message.
  if (state.status === 'error' && state.errorMessage) {
    if (state.responseText) parts.push('');
    parts.push(`❌ ${state.errorMessage}`);
  }

  // Stats footer on terminal states (replaces the skipped completion notice).
  if (state.status === 'complete' || state.status === 'error') {
    const stats = renderStats(state);
    if (stats) parts.push('', `> ${stats}`);
  }

  let content = parts.join('\n').trim();
  if (!content) content = '...'; // WeCom rejects empty stream content
  if (content.length > STREAM_MAX_CHARS) {
    const half = Math.floor(STREAM_MAX_CHARS / 2) - 20;
    content = content.slice(0, half) + '\n\n…（内容过长已截断）…\n\n' + content.slice(-half);
  }
  return content;
}

/** Compact one-line stats: model · duration · cost · context usage. */
function renderStats(state: CardState): string {
  const parts: string[] = [];
  if (state.model) parts.push(state.model.replace(/^claude-/, ''));
  if (state.durationMs !== undefined) parts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
  const cost = state.sessionCostUsd ?? state.costUsd;
  if (cost) parts.push(`$${cost.toFixed(3)}`);
  if (state.totalTokens && state.contextWindow) {
    const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
    const tokensK = state.totalTokens >= 1000 ? `${(state.totalTokens / 1000).toFixed(1)}k` : `${state.totalTokens}`;
    parts.push(`${tokensK}/${Math.round(state.contextWindow / 1000)}k (${pct}%)`);
  }
  return parts.join(' · ');
}

/** Split long text on newline boundaries, never exceeding maxLen per chunk. */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}
