import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState, CardStatus } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { WechatClient } from './wechat-client.js';

const MAX_TEXT_LENGTH = 4000;
const PROGRESS_THROTTLE_MS = 5_000;

/**
 * WeChat implementation of IMessageSender.
 *
 * iLink API constraints:
 * - GENERATING→FINISH with same client_id returns ret:-2
 *
 * Strategy: don't send anything in sendCard (preserve context_token), send tool
 * progress as standalone messages during processing, and send the final response last.
 */
export class WechatSender implements IMessageSender {
  /** Skip the bridge's "Task completed" notice — WeChat already sends final result as a message. */
  skipCompletionNotice = true;

  /** Track which messageIds already had their final message sent. */
  private finalSentSet = new Set<string>();
  /** Throttle progress messages per messageId. */
  private lastProgressSent = new Map<string, number>();
  /** Track how many tool calls we've already reported per messageId. */
  private reportedToolCount = new Map<string, number>();

  constructor(
    private client: WechatClient,
    private logger: Logger,
  ) {}

  async sendCard(chatId: string, _state: CardState): Promise<string | undefined> {
    // Don't send any message — preserve context_token for the final response.
    // Just send a typing indicator and return a synthetic messageId.
    const messageId = `wx:${chatId}:${Date.now()}`;
    this.client.sendTyping(chatId).catch(() => {});
    return messageId;
  }

  async updateCard(messageId: string, state: CardState): Promise<boolean> {
    const { chatId } = this.parseMessageId(messageId);
    if (!chatId) return false;

    // Terminal states: send final result as standalone FINISH message
    if (state.status === 'complete' || state.status === 'error') {
      if (this.finalSentSet.has(messageId)) return true; // idempotency — already delivered
      this.finalSentSet.add(messageId);
      this.lastProgressSent.delete(messageId);
      this.reportedToolCount.delete(messageId);
      setTimeout(() => this.finalSentSet.delete(messageId), 120_000);

      const text = this.renderFinalMessage(state);
      // Use sendText for automatic chunking of long responses
      await this.sendText(chatId, text);
      return true;
    }

    // Waiting for input: send question as standalone message
    if (state.status === 'waiting_for_input' && state.pendingQuestion) {
      const text = this.renderQuestionMessage(state);
      await this.client.sendTextMessage(chatId, text).catch((err) => {
        this.logger.error({ err, chatId }, 'Failed to send WeChat question');
      });
      return true;
    }

    // Intermediate: send tool progress as actual messages (throttled)
    const now = Date.now();
    const lastProgress = this.lastProgressSent.get(messageId) || 0;
    const reported = this.reportedToolCount.get(messageId) || 0;
    const hasNewTools = state.toolCalls.length > reported;

    if (hasNewTools && now - lastProgress > PROGRESS_THROTTLE_MS) {
      this.lastProgressSent.set(messageId, now);
      // Only report new tool calls since last update
      const newTools = state.toolCalls.slice(reported);
      this.reportedToolCount.set(messageId, state.toolCalls.length);

      const text = this.renderProgressMessage(newTools, state.status);
      await this.client.sendTextMessage(chatId, text).catch((err) => {
        this.logger.debug({ err, chatId }, 'Failed to send WeChat progress (may lack context_token)');
      });
    }
    return true;
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

  /** Progress message for new tool calls since last update. */
  private renderProgressMessage(newTools: CardState['toolCalls'], status: CardState['status']): string {
    const parts: string[] = [];
    const label = status === 'thinking' ? '🤔 思考中...' : '🔧 运行中...';
    parts.push(label);

    for (const t of newTools.slice(-5)) {
      const icon = t.status === 'done' ? '✓' : '⏳';
      const detail = t.detail.length > 80 ? t.detail.slice(0, 80) + '...' : t.detail;
      parts.push(`${icon} ${t.name} ${detail}`);
    }

    return parts.join('\n');
  }

  /** Final message: just the response text (or error). */
  private renderFinalMessage(state: CardState): string {
    if (state.status === 'error') {
      return state.errorMessage || '执行出错';
    }

    // Just the response text
    return state.responseText || '(无输出)';
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

  private parseMessageId(messageId: string): { chatId?: string; clientId?: string } {
    // Format: wx:{chatId}:{clientId}
    // chatId may contain colons (unlikely but safe), clientId is the last segment
    const firstColon = messageId.indexOf(':');
    if (firstColon < 0 || messageId.slice(0, firstColon) !== 'wx') return {};

    const rest = messageId.slice(firstColon + 1);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon < 0) return {};

    return {
      chatId: rest.slice(0, lastColon),
      clientId: rest.slice(lastColon + 1),
    };
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
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) {
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
