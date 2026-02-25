import { Bot } from 'grammy';
import type { TelegramBotConfig, BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../types.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import { TelegramSender } from './telegram-sender.js';
import { MessageBridge } from '../bridge/message-bridge.js';

export interface TelegramBotHandle {
  name: string;
  bridge: MessageBridge;
  bot: Bot;
  config: BotConfigBase;
  sender: IMessageSender;
}


export async function startTelegramBot(
  config: TelegramBotConfig,
  logger: Logger,
  memoryServerUrl: string,
  memorySecret?: string,
): Promise<TelegramBotHandle> {
  const botLogger = logger.child({ bot: config.name });

  botLogger.info('Starting Telegram bot...');

  const bot = new Bot(config.telegram.botToken);
  const sender = new TelegramSender(bot, botLogger);
  const bridge = new MessageBridge(config, botLogger, sender, memoryServerUrl, memorySecret);

  // Get bot info for logging
  const me = await bot.api.getMe();
  botLogger.info({ botUsername: me.username, botId: me.id }, 'Telegram bot info fetched');

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type; // 'private', 'group', 'supergroup'

    let text = ctx.message.text || '';

    // In group chats, only respond when mentioned or when message starts with /
    if (chatType === 'group' || chatType === 'supergroup') {
      const botUsername = me.username;
      const mentioned = ctx.message.entities?.some(
        (e) => e.type === 'mention' && text.includes(`@${botUsername}`),
      );
      const isCommand = text.startsWith('/');

      if (!mentioned && !isCommand) {
        return;
      }

      // Strip @mention from text
      if (botUsername) {
        text = text.replace(new RegExp(`@${botUsername}\\b`, 'g'), '').trim();
      }
    }

    // Strip bot command prefix for Telegram-style commands: /help@botname → /help
    text = text.replace(/^(\/\w+)@\w+/, '$1');

    if (!text) return;

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, msg }, 'Unhandled error in Telegram message bridge');
    });
  });

  // Handle photo messages
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;

    // Get the largest photo (last in the array)
    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text: ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u5F20\u56FE\u7247', // 请分析这张图片
      imageKey: largestPhoto.file_id,
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err }, 'Unhandled error in Telegram photo message bridge');
    });
  });

  // Handle document messages
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;

    const doc = ctx.message.document;

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text: ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2A\u6587\u4EF6', // 请分析这个文件
      fileKey: doc.file_id,
      fileName: doc.file_name || 'document',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err }, 'Unhandled error in Telegram document message bridge');
    });
  });

  // Handle errors
  bot.catch((err) => {
    botLogger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'grammY error');
  });

  // Start long polling (non-blocking)
  bot.start({
    onStart: () => {
      botLogger.info('Telegram bot is running (long polling)');
    },
  });

  botLogger.info({
    defaultWorkingDirectory: config.claude.defaultWorkingDirectory,
    allowedTools: config.claude.allowedTools,
    maxTurns: config.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: config.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return { name: config.name, bridge, bot, config, sender };
}
