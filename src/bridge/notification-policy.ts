import type { BotConfigBase } from '../config.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from './message-sender.interface.js';
import { isVoiceReplyEnabled } from './voice-reply.js';
import { hasRunningBackgroundWork } from './background-task-lifecycle.js';

export const COMPLETION_NOTICE_MIN_DURATION_MS = 10_000;

/**
 * Sends the small push-only completion notice for long-running tasks.
 * Rich details stay in the card footer; this path is only for notification surfaces.
 */
export async function sendCompletionNotice(opts: {
  sender: IMessageSender;
  config: BotConfigBase;
  logger: Logger;
  chatId: string;
  state: CardState;
  durationMs: number;
}): Promise<void> {
  const { sender, config, logger, chatId, state, durationMs } = opts;

  if (sender.skipCompletionNotice) return;
  if (hasRunningBackgroundWork(state)) return;
  if (state.status === 'complete' && isVoiceReplyEnabled(config)) return;
  if (durationMs < COMPLETION_NOTICE_MIN_DURATION_MS) return;

  const statusEmoji = state.status === 'complete' ? '✅' : '❌';
  const statusWord = state.status === 'complete' ? 'Done' : 'Failed';

  try {
    await sender.sendText(chatId, `${statusEmoji} ${statusWord}`);
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to send completion notice');
  }
}
