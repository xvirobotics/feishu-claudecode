import type { WechatBotConfig, BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { IncomingMessage } from '../types.js';
import { WechatClient, type ILinkMessage, type ILinkMessageItem } from './wechat-client.js';
import { WechatSender } from './wechat-sender.js';
import { MessageBridge } from '../bridge/message-bridge.js';

export interface WechatBotHandle {
  name: string;
  bridge: MessageBridge;
  client: WechatClient;
  config: BotConfigBase;
  sender: IMessageSender;
  stop(): void;
}

export async function startWechatBot(
  config: WechatBotConfig,
  logger: Logger,
  memoryServerUrl: string,
  memorySecret?: string,
): Promise<WechatBotHandle> {
  const botLogger = logger.child({ bot: config.name });

  botLogger.info('Starting WeChat bot...');

  const client = new WechatClient(config.wechat.ilinkBaseUrl, botLogger);

  // Try to load persisted token, then fall back to config token, then QR login
  const dataDir = './data';
  const saved = WechatClient.loadToken(dataDir, config.name);

  if (saved) {
    client.setToken(saved.botToken);
    if (saved.typingTicket) {
      client.setTypingTicket(saved.typingTicket);
    }
    botLogger.info('Loaded persisted WeChat token');
  } else if (config.wechat.botToken) {
    client.setToken(config.wechat.botToken);
    botLogger.info('Using WeChat token from config');
    // Fetch typing ticket
    await client.fetchConfig();
    client.saveToken(dataDir, config.name);
  } else {
    // QR login (handles fetchConfig internally)
    const { qrUrl } = await client.login();
    botLogger.info({ qrUrl }, 'WeChat QR login completed');
    client.saveToken(dataDir, config.name);
  }

  const sender = new WechatSender(client, botLogger);
  const bridge = new MessageBridge(config, botLogger, sender, memoryServerUrl, memorySecret);

  // Start long polling
  const abortController = new AbortController();
  pollLoop(client, bridge, botLogger, abortController.signal);

  botLogger.info('WeChat bot is running (long polling)');
  botLogger.info({
    defaultWorkingDirectory: config.claude.defaultWorkingDirectory,
    maxTurns: config.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: config.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return {
    name: config.name,
    bridge,
    client,
    config,
    sender,
    stop() {
      abortController.abort();
    },
  };
}

async function pollLoop(
  client: WechatClient,
  bridge: MessageBridge,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  let backoffMs = 1000;
  const maxBackoff = 60_000;

  while (!signal.aborted) {
    try {
      const messages = await client.getUpdates();
      backoffMs = 1000; // Reset on success

      for (const msg of messages) {
        // Only process user messages (type 1), skip bot echo (type 2)
        if (msg.message_type === 2) continue;
        // Skip generating/partial messages
        if (msg.message_state === 1) continue;

        const incoming = mapToIncomingMessage(msg);
        if (incoming) {
          bridge.handleMessage(incoming).catch((err) => {
            logger.error({ err, from: msg.from_user_id }, 'Unhandled error in WeChat message bridge');
          });
        }
      }
    } catch (err: any) {
      if (signal.aborted) break;

      // Auth error → token expired
      if (err?.message?.includes('401') || err?.message?.includes('403')) {
        logger.error('WeChat token expired or invalid. Please re-authenticate (restart with QR login).');
        break;
      }

      logger.error({ err, backoffMs }, 'WeChat polling error, retrying...');
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoff);
    }
  }
}

function mapToIncomingMessage(msg: ILinkMessage): IncomingMessage | undefined {
  if (!msg.item_list || msg.item_list.length === 0) return undefined;
  if (!msg.from_user_id) return undefined;

  const firstItem = msg.item_list[0];
  const chatId = msg.from_user_id; // For private chats, reply to sender

  const base: IncomingMessage = {
    messageId: msg.message_id != null ? String(msg.message_id) : `${msg.from_user_id}:${msg.create_time_ms || Date.now()}`,
    chatId,
    chatType: 'private', // iLink currently sends private messages
    userId: msg.from_user_id,
    text: '',
  };

  // Process first item
  applyItem(base, firstItem, true);

  // Process extra items as extraMedia
  if (msg.item_list.length > 1) {
    base.extraMedia = [];
    for (let i = 1; i < msg.item_list.length; i++) {
      const item = msg.item_list[i];
      const extra: { messageId: string; imageKey?: string; fileKey?: string; fileName?: string } = {
        messageId: base.messageId + `:${i}`,
      };
      applyItemToExtra(extra, item);
      base.extraMedia.push(extra);
    }
  }

  if (!base.text && !base.imageKey && !base.fileKey) return undefined;

  return base;
}

/** Encode CDN media ref as "aesKey|encryptQueryParam" for download later. */
function encodeCdnRef(media: { aes_key?: string; encrypt_query_param?: string }): string {
  return `${media.aes_key || ''}|${media.encrypt_query_param || ''}`;
}

function applyItem(msg: IncomingMessage, item: ILinkMessageItem, isFirst: boolean): void {
  switch (item.type) {
    case 1: // Text
      if (item.text_item?.text) {
        msg.text = isFirst ? item.text_item.text : `${msg.text}\n${item.text_item.text}`;
      }
      break;
    case 2: // Image
      if (item.image_item) {
        msg.imageKey = encodeCdnRef(item.image_item);
        if (!msg.text) msg.text = '请分析这张图片';
      }
      break;
    case 3: // Voice
      if (item.voice_item) {
        if (item.voice_item.transcription) {
          msg.text = item.voice_item.transcription;
        } else {
          msg.fileKey = encodeCdnRef(item.voice_item);
          msg.fileName = 'voice.silk';
          if (!msg.text) msg.text = '请分析这条语音消息';
        }
      }
      break;
    case 4: // File
      if (item.file_item) {
        msg.fileKey = encodeCdnRef(item.file_item);
        msg.fileName = item.file_item.filename || 'file';
        if (!msg.text) msg.text = '请分析这个文件';
      }
      break;
    case 5: // Video
      if (item.video_item) {
        msg.fileKey = encodeCdnRef(item.video_item);
        msg.fileName = 'video.mp4';
        if (!msg.text) msg.text = '请分析这个视频';
      }
      break;
  }
}

function applyItemToExtra(
  extra: { messageId: string; imageKey?: string; fileKey?: string; fileName?: string },
  item: ILinkMessageItem,
): void {
  switch (item.type) {
    case 2:
      if (item.image_item) {
        extra.imageKey = encodeCdnRef(item.image_item);
      }
      break;
    case 4:
      if (item.file_item) {
        extra.fileKey = encodeCdnRef(item.file_item);
        extra.fileName = item.file_item.filename || 'file';
      }
      break;
    case 5:
      if (item.video_item) {
        extra.fileKey = encodeCdnRef(item.video_item);
        extra.fileName = 'video.mp4';
      }
      break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
