import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState, CardStatus } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { WechatClient } from './wechat-client.js';

const MAX_TEXT_LENGTH = 4000;
const TYPING_THROTTLE_MS = 10_000;

const STATUS_LABEL: Record<CardStatus, string> = {
  thinking: '思考中...',
  running: '运行中...',
  complete: '完成',
  error: '错误',
  waiting_for_input: '等待输入',
};

/**
 * WeChat implementation of IMessageSender.
 *
 * WeChat does NOT support message editing, so:
 * - sendCard(): sends a short "thinking" message + typing indicator
 * - updateCard() intermediate: sends typing indicator (throttled)
 * - updateCard() terminal: sends the final result as a NEW message
 * - updateCard() waiting_for_input: sends question as a NEW message
 */
export class WechatSender implements IMessageSender {
  /** Track which synthetic messageIds already had their final message sent. */
  private finalSentSet = new Set<string>();
  /** Throttle typing per chatId. */
  private lastTypingSent = new Map<string, number>();

  constructor(
    private client: WechatClient,
    private logger: Logger,
  ) {}

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    try {
      const prompt = state.userPrompt.length > 80
        ? state.userPrompt.slice(0, 80) + '...'
        : state.userPrompt;
      await this.client.sendTextMessage(chatId, `[${STATUS_LABEL.thinking}] ${prompt}`);
      await this.client.sendTyping(chatId).catch(() => {});

      const syntheticId = `wx:${chatId}:${Date.now()}`;
      return syntheticId;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send WeChat card');
      return undefined;
    }
  }

  async updateCard(messageId: string, state: CardState): Promise<void> {
    const chatId = this.extractChatId(messageId);
    if (!chatId) return;

    // Terminal states: send final result as new message
    if (state.status === 'complete' || state.status === 'error') {
      if (this.finalSentSet.has(messageId)) return; // idempotency
      this.finalSentSet.add(messageId);
      // Auto-cleanup after 2 minutes
      setTimeout(() => this.finalSentSet.delete(messageId), 120_000);

      const text = this.renderFinalMessage(state);
      await this.sendText(chatId, text);
      return;
    }

    // Waiting for input: send question
    if (state.status === 'waiting_for_input' && state.pendingQuestion) {
      const text = this.renderQuestionMessage(state);
      await this.client.sendTextMessage(chatId, text).catch((err) => {
        this.logger.error({ err, chatId }, 'Failed to send WeChat question');
      });
      return;
    }

    // Intermediate states: send typing indicator (throttled)
    const now = Date.now();
    const lastTyping = this.lastTypingSent.get(chatId) || 0;
    if (now - lastTyping > TYPING_THROTTLE_MS) {
      this.lastTypingSent.set(chatId, now);
      await this.client.sendTyping(chatId).catch(() => {});
    }
  }

  async sendTextNotice(chatId: string, title: string, content: string): Promise<void> {
    const text = `【${title}】\n${content}`;
    await this.sendText(chatId, text);
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      const chunks = splitLongText(text, MAX_TEXT_LENGTH);
      for (const chunk of chunks) {
        await this.client.sendTextMessage(chatId, chunk);
      }
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send WeChat text');
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    try {
      const result = await this.client.uploadMedia(filePath, 1, chatId); // 1=IMAGE
      if (!result) return false;
      await this.client.sendMessage(chatId, [
        { type: 2, image_item: { aes_key: result.aesKey, encrypt_query_param: result.encryptQueryParam } },
      ]);
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send WeChat image');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    try {
      const result = await this.client.uploadMedia(filePath, 3, chatId); // 3=FILE
      if (!result) return false;
      await this.client.sendMessage(chatId, [
        { type: 4, file_item: { aes_key: result.aesKey, encrypt_query_param: result.encryptQueryParam, filename: fileName } },
      ]);
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send WeChat file');
      return false;
    }
  }

  async downloadImage(_messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    // imageKey is "aesKey|encryptQueryParam"
    const [aesKey, encryptQueryParam] = imageKey.split('|', 2);
    if (!aesKey || !encryptQueryParam) return false;
    return this.client.downloadMedia(encryptQueryParam, aesKey, savePath);
  }

  async downloadFile(_messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    const [aesKey, encryptQueryParam] = fileKey.split('|', 2);
    if (!aesKey || !encryptQueryParam) return false;
    return this.client.downloadMedia(encryptQueryParam, aesKey, savePath);
  }

  // --- Rendering ---

  private renderFinalMessage(state: CardState): string {
    const parts: string[] = [];

    // Header
    const label = state.status === 'complete' ? '✅ 完成' : '❌ 错误';
    parts.push(label);

    // Tool calls summary
    if (state.toolCalls.length > 0) {
      parts.push('---');
      for (const t of state.toolCalls) {
        const icon = t.status === 'done' ? '✓' : '…';
        parts.push(`${icon} ${t.name} ${t.detail}`);
      }
    }

    // Response text
    if (state.responseText) {
      parts.push('---');
      parts.push(state.responseText);
    }

    // Error
    if (state.errorMessage) {
      parts.push('');
      parts.push(`错误: ${state.errorMessage}`);
    }

    // Stats
    const statParts: string[] = [];
    if (state.durationMs !== undefined) {
      statParts.push(`耗时: ${(state.durationMs / 1000).toFixed(1)}s`);
    }
    if (state.costUsd !== undefined) {
      statParts.push(`费用: $${state.costUsd.toFixed(4)}`);
    }
    if (statParts.length > 0) {
      parts.push('---');
      parts.push(statParts.join(' | '));
    }

    return parts.join('\n');
  }

  private renderQuestionMessage(state: CardState): string {
    const parts: string[] = [];
    parts.push('⚠️ 需要输入');

    if (state.pendingQuestion) {
      for (const q of state.pendingQuestion.questions) {
        parts.push('');
        parts.push(`[${q.header}] ${q.question}`);
        parts.push('');
        q.options.forEach((opt, i) => {
          parts.push(`${i + 1}. ${opt.label} — ${opt.description}`);
        });
        parts.push(`${q.options.length + 1}. 其他（输入自定义回答）`);
      }
      parts.push('');
      parts.push('回复数字选择，或直接输入自定义答案');
    }

    return parts.join('\n');
  }

  private extractChatId(messageId: string): string | undefined {
    // Format: wx:{chatId}:{timestamp}
    const parts = messageId.split(':');
    if (parts.length >= 3 && parts[0] === 'wx') {
      return parts[1];
    }
    return undefined;
  }
}

function splitLongText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) {
      // No good newline break, split at maxLen
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    if (remaining.startsWith('\n')) {
      remaining = remaining.slice(1);
    }
  }
  return chunks;
}
