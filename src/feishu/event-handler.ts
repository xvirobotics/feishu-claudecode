import * as lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
  text: string;
  imageKey?: string;
}

export type MessageHandler = (msg: IncomingMessage) => void;

export function createEventDispatcher(
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        const msgType = message.message_type;

        // Only handle text and image messages
        if (msgType !== 'text' && msgType !== 'image') {
          logger.debug({ type: msgType }, 'Ignoring unsupported message type');
          return;
        }

        const userId = sender?.sender_id?.open_id;
        if (!userId) {
          logger.warn('Message missing sender open_id');
          return;
        }

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;

        // Authorization check
        if (!isAuthorized(config, userId, chatId)) {
          logger.warn({ userId, chatId }, 'Unauthorized message');
          return;
        }

        let text = '';
        let imageKey: string | undefined;

        if (msgType === 'image') {
          // Image message: extract image_key
          try {
            const content = JSON.parse(message.content);
            imageKey = content.image_key;
          } catch {
            logger.warn('Failed to parse image message content');
            return;
          }
          if (!imageKey) {
            logger.warn('Image message missing image_key');
            return;
          }
          text = '请分析这张图片';
          logger.info({ userId, chatId, chatType, imageKey }, 'Received image message');
        } else {
          // Text message: extract and clean text
          try {
            const content = JSON.parse(message.content);
            text = content.text || '';
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse message content');
            return;
          }

          // Strip @mention tags (format: @_user_xxx or similar)
          text = text.replace(/@_\w+\s*/g, '').trim();

          // Strip Feishu auto-generated markdown links: [text](url) → text
          text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

          if (!text) {
            logger.debug('Empty message after stripping mentions');
            return;
          }

          logger.info({ userId, chatId, chatType, text: text.slice(0, 100) }, 'Received message');
        }

        onMessage({ messageId, chatId, chatType, userId, text, imageKey });
      } catch (err) {
        logger.error({ err }, 'Error handling message event');
      }
    },
  });

  return dispatcher;
}

function isAuthorized(config: Config, userId: string, chatId: string): boolean {
  const { authorizedUserIds, authorizedChatIds } = config.auth;

  // If no restrictions configured, allow all
  if (authorizedUserIds.length === 0 && authorizedChatIds.length === 0) {
    return true;
  }

  // Check user authorization
  if (authorizedUserIds.length > 0 && authorizedUserIds.includes(userId)) {
    return true;
  }

  // Check chat authorization
  if (authorizedChatIds.length > 0 && authorizedChatIds.includes(chatId)) {
    return true;
  }

  return false;
}
