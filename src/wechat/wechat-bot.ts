/**
 * WeChat bot startup and long-poll event loop.
 *
 * Connects to Tencent's iLink API to receive/send WeChat messages.
 * Similar in structure to telegram-bot.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeChatBotConfig, BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../types.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import { ILinkClient, ILinkMessageType, type ILinkMessage } from './ilink-client.js';
import { WeChatSender } from './wechat-sender.js';
import { MessageBridge } from '../bridge/message-bridge.js';

export interface WeChatBotHandle {
  name: string;
  bridge: MessageBridge;
  config: BotConfigBase;
  sender: IMessageSender;
  /** Stop the long-poll loop. */
  stop(): void;
}

// Persist sync buffer across restarts
const SYNC_BUF_DIR = path.join(os.homedir(), '.metabot');

function syncBufPath(botName: string): string {
  return path.join(SYNC_BUF_DIR, `wechat-syncbuf-${botName}.txt`);
}

function loadSyncBuf(botName: string): string | undefined {
  try {
    return fs.readFileSync(syncBufPath(botName), 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveSyncBuf(botName: string, buf: string): void {
  try {
    fs.mkdirSync(SYNC_BUF_DIR, { recursive: true });
    fs.writeFileSync(syncBufPath(botName), buf);
  } catch {
    // Non-critical
  }
}

/**
 * Convert an iLink message to a platform-agnostic IncomingMessage.
 */
function toIncomingMessage(msg: ILinkMessage): IncomingMessage | undefined {
  // Only handle user messages (type 1), skip bot echo (type 2)
  if (msg.message_type !== 1) return undefined;

  // Use from_user_id as chatId (DM-only, each user = one chat)
  const chatId = msg.from_user_id;
  const userId = msg.from_user_id;
  const messageId = `${chatId}:${Date.now()}`;

  switch (msg.type) {
    case ILinkMessageType.TEXT:
      if (!msg.text_item?.text) return undefined;
      return {
        messageId,
        chatId,
        chatType: 'private',
        userId,
        text: msg.text_item.text,
      };

    case ILinkMessageType.IMAGE:
      if (!msg.image_item) return undefined;
      return {
        messageId,
        chatId,
        chatType: 'private',
        userId,
        text: '\u8BF7\u5206\u6790\u8FD9\u5F20\u56FE\u7247', // 请分析这张图片
        imageKey: `${msg.image_item.image_url}|${msg.image_item.aes_key || ''}`,
      };

    case ILinkMessageType.FILE:
      if (!msg.file_item) return undefined;
      return {
        messageId,
        chatId,
        chatType: 'private',
        userId,
        text: '\u8BF7\u5206\u6790\u8FD9\u4E2A\u6587\u4EF6', // 请分析这个文件
        fileKey: `${msg.file_item.file_url}|${msg.file_item.aes_key || ''}`,
        fileName: msg.file_item.file_name,
      };

    case ILinkMessageType.VOICE:
      if (!msg.voice_item) return undefined;
      // Use voice transcription if available, otherwise indicate voice message
      return {
        messageId,
        chatId,
        chatType: 'private',
        userId,
        text: msg.voice_item.voice_text || '\u8BF7\u5206\u6790\u8FD9\u6761\u8BED\u97F3\u6D88\u606F', // 请分析这条语音消息
        fileKey: `${msg.voice_item.voice_url}|${msg.voice_item.aes_key || ''}`,
        fileName: 'voice.silk',
      };

    case ILinkMessageType.VIDEO:
      if (!msg.video_item) return undefined;
      return {
        messageId,
        chatId,
        chatType: 'private',
        userId,
        text: '\u8BF7\u5206\u6790\u8FD9\u4E2A\u89C6\u9891', // 请分析这个视频
        fileKey: `${msg.video_item.video_url}|${msg.video_item.aes_key || ''}`,
        fileName: 'video.mp4',
      };

    default:
      return undefined;
  }
}

export async function startWeChatBot(
  config: WeChatBotConfig,
  logger: Logger,
  memoryServerUrl: string,
  memorySecret?: string,
): Promise<WeChatBotHandle> {
  const botLogger = logger.child({ bot: config.name });
  botLogger.info('Starting WeChat bot...');

  const client = new ILinkClient(
    { botToken: config.wechat.botToken },
    botLogger,
  );

  // Restore sync buffer from disk
  const savedBuf = loadSyncBuf(config.name);
  if (savedBuf) {
    client.setSyncBuf(savedBuf);
    botLogger.info('Restored iLink sync buffer from disk');
  }

  const sender = new WeChatSender(client, botLogger);
  const bridge = new MessageBridge(config, botLogger, sender, memoryServerUrl, memorySecret);

  let running = true;

  // Long-poll loop
  const pollLoop = async () => {
    botLogger.info('WeChat iLink long-poll loop started');
    let consecutiveErrors = 0;

    while (running) {
      try {
        const updates = await client.getUpdates();

        if (updates.errcode !== 0) {
          botLogger.warn({ errcode: updates.errcode, errmsg: updates.errmsg }, 'iLink getupdates error');
          consecutiveErrors++;
          if (consecutiveErrors > 10) {
            botLogger.error('Too many consecutive iLink errors, backing off 60s');
            await sleep(60_000);
            consecutiveErrors = 0;
          } else {
            await sleep(2000);
          }
          continue;
        }

        consecutiveErrors = 0;

        // Persist sync buffer
        const buf = client.getSyncBuf();
        if (buf) saveSyncBuf(config.name, buf);

        if (!updates.msgs || updates.msgs.length === 0) continue;

        for (const rawMsg of updates.msgs) {
          // Register context_token in sender for replies
          sender.setContext(rawMsg.from_user_id, rawMsg.from_user_id, rawMsg.context_token);

          const msg = toIncomingMessage(rawMsg);
          if (!msg) continue;

          botLogger.info(
            { chatId: msg.chatId, text: msg.text.slice(0, 50), hasImage: !!msg.imageKey, hasFile: !!msg.fileKey },
            'Received WeChat message',
          );

          // Send typing indicator
          client.sendTyping(rawMsg.from_user_id, rawMsg.context_token).catch(() => {});

          bridge.handleMessage(msg).catch((err) => {
            botLogger.error({ err, chatId: msg.chatId }, 'Unhandled error in WeChat message bridge');
          });
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          // Normal abort from stop()
          continue;
        }
        botLogger.error({ err }, 'iLink poll loop error');
        consecutiveErrors++;
        await sleep(Math.min(2000 * consecutiveErrors, 30_000));
      }
    }
    botLogger.info('WeChat iLink long-poll loop stopped');
  };

  // Start poll loop in background (don't await)
  void pollLoop();

  botLogger.info('WeChat bot is running');
  botLogger.info({
    defaultWorkingDirectory: config.claude.defaultWorkingDirectory,
    maxTurns: config.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: config.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  const stop = () => {
    running = false;
    client.abortPoll();
    sender.destroy();
  };

  return { name: config.name, bridge, config, sender, stop };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
