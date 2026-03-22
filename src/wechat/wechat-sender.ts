/**
 * WeChat implementation of IMessageSender.
 *
 * WeChat (via iLink) does NOT support editing sent messages, so we use
 * a "streaming text" approach: send an initial message with message_state=0 (NEW),
 * update with message_state=1 (GENERATING), and finalize with message_state=2 (FINISH).
 *
 * For status updates during execution, we render CardState to plain text.
 */

import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState, CardStatus } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { ILinkClient } from './ilink-client.js';

const STATUS_EMOJI: Record<CardStatus, string> = {
  thinking: '\u{1F535}',      // 🔵
  running: '\u{1F535}',       // 🔵
  complete: '\u{2705}',       // ✅
  error: '\u{274C}',          // ❌
  waiting_for_input: '\u{1F7E1}', // 🟡
};

const STATUS_LABEL: Record<CardStatus, string> = {
  thinking: 'Thinking...',
  running: 'Running...',
  complete: 'Complete',
  error: 'Error',
  waiting_for_input: 'Waiting for Input',
};

// WeChat text message limit is ~4KB for comfortable display
const MAX_MESSAGE_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Render CardState → plain text for WeChat
// ---------------------------------------------------------------------------

function renderCardText(state: CardState): string {
  const parts: string[] = [];

  const emoji = STATUS_EMOJI[state.status];
  const label = STATUS_LABEL[state.status];
  parts.push(`${emoji} ${label}`);

  // Tool calls summary
  if (state.toolCalls.length > 0) {
    parts.push('');
    for (const t of state.toolCalls) {
      const icon = t.status === 'running' ? '\u23F3' : '\u2705'; // ⏳ / ✅
      parts.push(`${icon} ${t.name} ${t.detail}`);
    }
  }

  // Response text
  if (state.responseText) {
    parts.push('');
    parts.push(stripMarkdown(state.responseText));
  } else if (state.status === 'thinking') {
    parts.push('');
    parts.push('Claude is thinking...');
  }

  // Pending question
  if (state.pendingQuestion) {
    parts.push('');
    parts.push('---');
    const q = state.pendingQuestion.questions[0];
    if (q) {
      parts.push(`[${q.header}] ${q.question}`);
      parts.push('');
      q.options.forEach((opt, i) => {
        parts.push(`${i + 1}. ${opt.label} - ${opt.description}`);
      });
      parts.push(`${q.options.length + 1}. Other (type custom answer)`);
      parts.push('');
    }
    parts.push('Reply with a number or type your answer directly.');
  }

  // Retry info
  if (state.retryInfo) {
    parts.push(`\u23F3 ${state.retryInfo}`);
  }

  // Error
  if (state.errorMessage) {
    parts.push('');
    parts.push(`Error: ${state.errorMessage}`);
  }

  // Stats (final state only)
  if (state.status === 'complete' || state.status === 'error') {
    const statParts: string[] = [];
    if (state.model) statParts.push(state.model);
    if (state.durationMs !== undefined) statParts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
    if (state.costUsd !== undefined) statParts.push(`$${state.costUsd.toFixed(4)}`);
    if (statParts.length > 0) {
      parts.push('');
      parts.push(statParts.join(' · '));
    }
  }

  return truncateText(parts.join('\n'));
}

function stripMarkdown(text: string): string {
  // Light markdown stripping — keep it readable in plain text
  return text
    .replace(/```[\s\S]*?```/g, (m) => {
      // Keep code block content, remove fences
      const lines = m.split('\n');
      return lines.slice(1, -1).join('\n');
    })
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function truncateText(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const half = Math.floor(MAX_MESSAGE_LENGTH / 2) - 20;
  return text.slice(0, half) + '\n\n... (truncated) ...\n\n' + text.slice(-half);
}

// ---------------------------------------------------------------------------
// Conversation context tracking
// ---------------------------------------------------------------------------

/**
 * iLink requires `context_token` for all replies. We track the last
 * context_token per chatId (which is the user's iLink user ID).
 */
interface ConversationContext {
  userId: string;      // from_user_id (the WeChat user)
  contextToken: string;
}

// ---------------------------------------------------------------------------
// WeChat Sender
// ---------------------------------------------------------------------------

const CONTEXT_TTL_MS = 60 * 60 * 1000; // 1 hour

export class WeChatSender implements IMessageSender {
  /** Map of chatId → { userId, contextToken, lastUsed } */
  private contextMap = new Map<string, ConversationContext & { lastUsed: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private client: ILinkClient,
    private logger: Logger,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), CONTEXT_TTL_MS);
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /** Register the context_token for a chat (called by event handler on each incoming message). */
  setContext(chatId: string, userId: string, contextToken: string): void {
    this.contextMap.set(chatId, { userId, contextToken, lastUsed: Date.now() });
  }

  private getContext(chatId: string): ConversationContext | undefined {
    const ctx = this.contextMap.get(chatId);
    if (ctx) ctx.lastUsed = Date.now();
    return ctx;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.contextMap) {
      if (now - entry.lastUsed > CONTEXT_TTL_MS) {
        this.contextMap.delete(key);
      }
    }
  }

  // ---- IMessageSender implementation ----

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    const ctx = this.getContext(chatId);
    if (!ctx) {
      this.logger.warn({ chatId }, 'No context_token for WeChat chat; cannot send message');
      return undefined;
    }

    try {
      // Send initial streaming message
      const text = renderCardText(state);
      const msgState = (state.status === 'complete' || state.status === 'error') ? 2 : 0;
      await this.client.sendTextStreaming(ctx.userId, ctx.contextToken, text, msgState as 0 | 1 | 2);

      // WeChat doesn't return a message ID for edits; use chatId as the "message ID"
      // since we're keyed by conversation anyway
      return `wx:${chatId}`;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send WeChat message');
      return undefined;
    }
  }

  async updateCard(messageId: string, state: CardState): Promise<void> {
    const chatId = messageId.replace(/^wx:/, '');
    const ctx = this.getContext(chatId);
    if (!ctx) return;

    try {
      const text = renderCardText(state);
      const msgState = (state.status === 'complete' || state.status === 'error') ? 2 : 1;
      await this.client.sendTextStreaming(ctx.userId, ctx.contextToken, text, msgState as 0 | 1 | 2);
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to update WeChat message');
    }
  }

  async sendTextNotice(chatId: string, title: string, content: string, _color?: string): Promise<void> {
    const ctx = this.getContext(chatId);
    if (!ctx) return;

    try {
      const text = `${title}\n\n${stripMarkdown(content)}`;
      await this.client.sendText(ctx.userId, ctx.contextToken, truncateText(text));
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send WeChat notice');
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const ctx = this.getContext(chatId);
    if (!ctx) return;

    try {
      await this.client.sendText(ctx.userId, ctx.contextToken, truncateText(text));
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send WeChat text');
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    const ctx = this.getContext(chatId);
    if (!ctx) return false;

    try {
      const upload = await this.client.uploadFile(filePath);
      await this.client.sendImage(
        ctx.userId,
        ctx.contextToken,
        upload.downloadUrl,
        upload.encryptQueryParam,
        upload.aesKeyBase64,
      );
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send WeChat image');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    const ctx = this.getContext(chatId);
    if (!ctx) return false;

    try {
      const upload = await this.client.uploadFile(filePath);
      await this.client.sendFile(
        ctx.userId,
        ctx.contextToken,
        fileName,
        upload.downloadUrl,
        upload.encryptQueryParam,
        upload.aesKeyBase64,
        upload.fileSize,
      );
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send WeChat file');
      return false;
    }
  }

  async downloadImage(_messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    try {
      // imageKey format: "url|aesKey" (set by event handler)
      const [url, aesKey] = imageKey.split('|');
      await this.client.downloadMedia(url, aesKey, savePath);
      return true;
    } catch (err) {
      this.logger.error({ err, imageKey }, 'Failed to download WeChat image');
      return false;
    }
  }

  async downloadFile(_messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    try {
      // fileKey format: "url|aesKey" (set by event handler)
      const [url, aesKey] = fileKey.split('|');
      await this.client.downloadMedia(url, aesKey, savePath);
      return true;
    } catch (err) {
      this.logger.error({ err, fileKey }, 'Failed to download WeChat file');
      return false;
    }
  }
}
