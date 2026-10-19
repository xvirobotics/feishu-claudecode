import * as fsPromises from 'node:fs/promises';
import type { BotConfigBase } from '../config.js';
import type { CardState } from '../types.js';
import type { StreamProcessor, SessionManager } from '../engines/index.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from './message-sender.interface.js';
import { FINAL_CARD_BASE_DELAY_MS, FINAL_CARD_RETRIES } from './bridge-constants.js';
import { createVoiceReplyOpus } from './voice-reply.js';

export async function sendFinalCardWithRetry(opts: {
  sender: IMessageSender;
  config: BotConfigBase;
  logger: Logger;
  sessionManager: SessionManager;
  messageId: string;
  state: CardState;
  chatId?: string;
}): Promise<void> {
  const { sender, config, logger, sessionManager, messageId, state, chatId } = opts;

  if (chatId && (state.status === 'complete' || state.status === 'error')) {
    sessionManager.addUsage(chatId, state.totalTokens ?? 0, state.costUsd ?? 0, state.durationMs ?? 0);
    const session = sessionManager.getSession(chatId);
    state.sessionCostUsd = session.cumulativeCostUsd;
  }

  for (let attempt = 0; attempt < FINAL_CARD_RETRIES; attempt++) {
    const ok = await sender.updateCard(messageId, state);
    if (ok) {
      void sendVoiceReplyIfEnabled({ sender, config, logger, chatId, state });
      return;
    }
    const delay = FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt);
    logger.warn({ attempt, delay, messageId }, 'Final card update failed, retrying');
    await new Promise((r) => setTimeout(r, delay));
  }

  if (chatId) {
    // Some platforms rate-limit updates to a single message (Feishu 230020:
    // "Update the single messages too frequently"). Once that quota is
    // exhausted, PATCHing the same card can keep failing well past the retry
    // window. A new card is a fresh message and is not subject to the old
    // message's quota, so try that before degrading to a truncated text reply.
    logger.warn({ messageId, chatId }, 'All final card retries failed, sending a new card');
    const fallbackMessageId = await sender.sendCard(chatId, state);
    if (fallbackMessageId) {
      void sendVoiceReplyIfEnabled({ sender, config, logger, chatId, state });
      return;
    }

    logger.error({ messageId, chatId }, 'New card also failed, sending text fallback');
    const statusEmoji = state.status === 'complete' ? '✅' : '❌';
    const summary = state.responseText
      ? state.responseText.slice(0, 2000)
      : state.errorMessage || 'Task finished';
    try {
      await sender.sendText(chatId, `${statusEmoji} ${summary}`);
    } catch {
      // Last resort failed; the card path already logged the delivery failure.
    }
  }
}

export async function sendVoiceReplyIfEnabled(opts: {
  sender: IMessageSender;
  config: BotConfigBase;
  logger: Logger;
  chatId: string | undefined;
  state: CardState;
}): Promise<void> {
  const { sender, config, logger, chatId, state } = opts;
  if (!chatId || state.status !== 'complete' || !state.responseText.trim() || !sender.sendAudioFile) return;

  const audio = await createVoiceReplyOpus(config, state.responseText, logger);
  if (!audio) return;
  try {
    const sent = await sender.sendAudioFile(chatId, audio.filePath, audio.fileName);
    if (!sent) {
      logger.warn({ chatId }, 'Voice reply audio send failed');
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'Unhandled error while sending voice reply');
  } finally {
    await audio.cleanup().catch(() => {});
  }
}

export async function sendPlanContent(opts: {
  sender: IMessageSender;
  logger: Logger;
  chatId: string;
  processor: StreamProcessor;
}): Promise<void> {
  const { sender, logger, chatId, processor } = opts;
  let planContent = processor.getPlanContent() || '';
  if (!planContent.trim()) {
    const planPath = processor.getPlanFilePath();
    if (!planPath) return;
    try {
      planContent = await fsPromises.readFile(planPath, 'utf-8');
    } catch (err) {
      logger.warn({ err, planPath, chatId }, 'Failed to read plan file for display');
      return;
    }
  }
  if (!planContent.trim()) return;

  logger.info({ chatId }, 'Sending plan content to user');
  await sender.sendTextNotice(chatId, '📋 Plan', planContent, 'green');
}
