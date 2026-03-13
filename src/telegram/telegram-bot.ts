import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
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

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (proxyUrl) {
    botLogger.info({ proxyUrl }, 'Using HTTPS proxy for Telegram API');
  }
  const botOptions = proxyUrl
    ? { client: { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl) } } }
    : {};

  const bot = new Bot(config.telegram.botToken, botOptions);
  const sender = new TelegramSender(bot, botLogger);
  const bridge = new MessageBridge(config, botLogger, sender, memoryServerUrl, memorySecret);

  // Install grammY error handler before polling starts.
  bot.catch((err) => {
    botLogger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'grammY error');
  });

  const isUnauthorized = (err: unknown): boolean => {
    const e: any = err as any;
    return e?.error_code === 401
      || e?.error?.error_code === 401
      || e?.response?.error_code === 401
      || e?.response?.error?.error_code === 401;
  };

  // getMe is useful for logging and @mention handling, but Telegram API
  // timeouts during startup should not take down the whole service.
  let botUsername: string | undefined;
  try {
    const me = await bot.api.getMe();
    botUsername = me.username;
    botLogger.info({ botUsername: me.username, botId: me.id }, 'Telegram bot info fetched');
  } catch (err) {
    if (isUnauthorized(err)) {
      botLogger.error({ err }, 'Telegram bot token is unauthorized (401). Skipping this bot.');
      throw err;
    }
    botLogger.warn({ err }, 'Failed to fetch Telegram bot info during startup; continuing without username metadata');
  }

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type; // 'private', 'group', 'supergroup'

    let text = ctx.message.text || '';

    // In group chats, only respond when mentioned or when message starts with /
    if (chatType === 'group' || chatType === 'supergroup') {
      const mentioned = ctx.message.entities?.some(
        (e) => e.type === 'mention' && botUsername !== undefined && text.includes(`@${botUsername}`),
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
    if (!photos || photos.length === 0) return;
    const largestPhoto = photos[photos.length - 1];
    botLogger.info({ chatId, userId, fileId: largestPhoto.file_id }, 'Received photo message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text: ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u5F20\u56FE\u7247', // 请分析这张图片
      imageKey: largestPhoto.file_id,
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram photo message bridge');
    });
  });

  // Handle document messages
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;

    const doc = ctx.message.document;
    if (!doc) return;
    botLogger.info({ chatId, userId, fileName: doc.file_name, mimeType: doc.mime_type, fileSize: doc.file_size }, 'Received document message');

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
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram document message bridge');
    });
  });

  // Handle video messages
  bot.on('message:video', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;

    const video = ctx.message.video;
    if (!video) return;
    botLogger.info({ chatId, userId, fileName: video.file_name, mimeType: video.mime_type, duration: video.duration }, 'Received video message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text: ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2A\u89C6\u9891', // 请分析这个视频
      fileKey: video.file_id,
      fileName: video.file_name || 'video.mp4',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram video message bridge');
    });
  });

  // Handle audio messages
  bot.on('message:audio', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;

    const audio = ctx.message.audio;
    if (!audio) return;
    botLogger.info({ chatId, userId, fileName: audio.file_name, mimeType: audio.mime_type, duration: audio.duration }, 'Received audio message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text: ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2A\u97F3\u9891\u6587\u4EF6', // 请分析这个音频文件
      fileKey: audio.file_id,
      fileName: audio.file_name || 'audio.mp3',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram audio message bridge');
    });
  });

  // Handle voice messages
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;

    const voice = ctx.message.voice;
    if (!voice) return;
    botLogger.info({ chatId, userId, duration: voice.duration }, 'Received voice message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text: '\u8BF7\u5206\u6790\u8FD9\u6761\u8BED\u97F3\u6D88\u606F', // 请分析这条语音消息
      fileKey: voice.file_id,
      fileName: 'voice.ogg',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram voice message bridge');
    });
  });

  // Handle animation (GIF) messages
  bot.on('message:animation', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;

    const animation = ctx.message.animation;
    if (!animation) return;
    botLogger.info({ chatId, userId, fileName: animation.file_name }, 'Received animation message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text: ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2AGIF', // 请分析这个GIF
      fileKey: animation.file_id,
      fileName: animation.file_name || 'animation.mp4',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram animation message bridge');
    });
  });

  // Start long polling (non-blocking). Important: attach a catch handler
  // so startup/auth/network errors don't crash the whole process.
  void bot.start({
    onStart: () => {
      botLogger.info('Telegram bot is running (long polling)');
    },
  }).catch((err) => {
    botLogger.error({ err }, 'Telegram bot polling stopped with error');
  });

  botLogger.info({
    defaultWorkingDirectory: config.claude.defaultWorkingDirectory,
    maxTurns: config.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: config.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return { name: config.name, bridge, bot, config, sender };
}
