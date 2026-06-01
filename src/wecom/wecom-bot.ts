import { WSClient } from '@wecom/aibot-node-sdk';
import type { WsFrame, Logger as SdkLogger } from '@wecom/aibot-node-sdk';
import type { WecomBotConfig, BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { IncomingMessage } from '../types.js';
import { WecomSender, encodeMediaRef } from './wecom-sender.js';
import { MessageBridge } from '../bridge/message-bridge.js';

export interface WecomBotHandle {
  name: string;
  bridge: MessageBridge;
  client: WSClient;
  config: BotConfigBase;
  sender: IMessageSender;
  stop(): void;
}

const DEFAULT_IMAGE_TEXT = '请分析这张图片';
const DEFAULT_FILE_TEXT = '请分析这个文件';
const DEFAULT_VIDEO_TEXT = '请分析这个视频';
const DEFAULT_VOICE_TEXT = '请分析这条语音消息';
const AUTH_WAIT_MS = 15_000;

/**
 * Start a WeCom (企业微信) smart bot over the AIP WebSocket long connection.
 *
 * Uses the official `@wecom/aibot-node-sdk`, which handles authentication, heartbeat,
 * exponential-backoff reconnection and AES file decryption. Incoming messages are
 * mapped to the platform-agnostic {@link IncomingMessage} and routed through the same
 * {@link MessageBridge} as Feishu/Telegram; streaming replies are handled by
 * {@link WecomSender}.
 */
export async function startWecomBot(
  config: WecomBotConfig,
  logger: Logger,
  memoryServerUrl: string,
  memorySecret?: string,
): Promise<WecomBotHandle> {
  const botLogger = logger.child({ bot: config.name });

  botLogger.info('Starting WeCom (企业微信) bot...');

  const client = new WSClient({
    botId: config.wecom.botId,
    secret: config.wecom.secret,
    ...(config.wecom.wsUrl ? { wsUrl: config.wecom.wsUrl } : {}),
    logger: makeSdkLogger(botLogger),
  });

  const sender = new WecomSender(client, botLogger);
  const bridge = new MessageBridge(config, botLogger, sender, memoryServerUrl, memorySecret);

  // Connection lifecycle logging.
  client.on('connected', () => botLogger.info('WeCom WebSocket connected'));
  client.on('authenticated', () => botLogger.info('WeCom bot authenticated'));
  client.on('disconnected', (reason: string) => botLogger.warn({ reason }, 'WeCom connection closed'));
  client.on('reconnecting', (attempt: number) => botLogger.info({ attempt }, 'WeCom reconnecting'));
  client.on('error', (err: Error) => botLogger.error({ err: err?.message || err }, 'WeCom client error'));

  // Single dispatcher for all message types: map → bind frame → hand to bridge.
  const dispatch = (frame: WsFrame): void => {
    const msg = mapToIncomingMessage(frame);
    if (!msg) return;
    sender.bindFrame(msg.chatId, frame);
    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, msg }, 'Unhandled error in WeCom message bridge');
    });
  };
  client.on('message.text', dispatch);
  client.on('message.image', dispatch);
  client.on('message.file', dispatch);
  client.on('message.voice', dispatch);
  client.on('message.video', dispatch);
  client.on('message.mixed', dispatch);

  // Greet the user on their first enter-chat event of the day.
  client.on('event.enter_chat', (frame: WsFrame) => {
    client
      .replyWelcome(frame, { msgtype: 'text', text: { content: welcomeText(config) } })
      .catch((err) => botLogger.debug({ err }, 'WeCom welcome reply failed'));
  });

  client.connect();

  // Wait for authentication so startup logs are accurate, but never hang forever —
  // the SDK keeps retrying in the background if auth is delayed.
  await waitForAuth(client, AUTH_WAIT_MS, botLogger);

  botLogger.info(
    {
      defaultWorkingDirectory: config.claude.defaultWorkingDirectory,
      maxTurns: config.claude.maxTurns ?? 'unlimited',
      maxBudgetUsd: config.claude.maxBudgetUsd ?? 'unlimited',
    },
    'WeCom bot is running',
  );

  return {
    name: config.name,
    bridge,
    client,
    config,
    sender,
    stop() {
      client.disconnect();
    },
  };
}

/** Map a WeCom callback frame to the platform-agnostic IncomingMessage. */
function mapToIncomingMessage(frame: WsFrame): IncomingMessage | undefined {
  const body = frame.body;
  if (!body || !body.from?.userid) return undefined;

  const chatType = body.chattype === 'group' ? 'group' : 'private';
  // Single chat replies/pushes target the user's userid; group chats target the chatid.
  const chatId = chatType === 'group' ? body.chatid || body.from.userid : body.from.userid;

  const msg: IncomingMessage = {
    messageId: body.msgid || `${chatId}:${body.create_time || Date.now()}`,
    chatId,
    chatType,
    userId: body.from.userid,
    text: '',
  };

  switch (body.msgtype) {
    case 'text':
      msg.text = (body.text?.content || '').trim();
      break;

    case 'image':
      if (body.image?.url) {
        msg.imageKey = encodeMediaRef(body.image.aeskey, body.image.url);
        msg.text = DEFAULT_IMAGE_TEXT;
      }
      break;

    case 'voice':
      // Voice is already transcribed to text by WeCom.
      msg.text = (body.voice?.content || '').trim() || DEFAULT_VOICE_TEXT;
      break;

    case 'file':
      if (body.file?.url) {
        msg.fileKey = encodeMediaRef(body.file.aeskey, body.file.url);
        msg.fileName = body.file.filename || 'file';
        msg.text = DEFAULT_FILE_TEXT;
      }
      break;

    case 'video':
      if (body.video?.url) {
        msg.fileKey = encodeMediaRef(body.video.aeskey, body.video.url);
        msg.fileName = 'video.mp4';
        msg.text = DEFAULT_VIDEO_TEXT;
      }
      break;

    case 'mixed': {
      const items: Array<{ msgtype: string; text?: { content: string }; image?: { url: string; aeskey?: string } }> =
        body.mixed?.msg_item || [];
      const texts: string[] = [];
      const images: Array<{ url: string; aeskey?: string }> = [];
      for (const item of items) {
        if (item.msgtype === 'text' && item.text?.content) texts.push(item.text.content);
        else if (item.msgtype === 'image' && item.image?.url) images.push(item.image);
      }
      msg.text = texts.join('\n').trim();
      if (images.length > 0) {
        msg.imageKey = encodeMediaRef(images[0].aeskey, images[0].url);
        if (!msg.text) msg.text = DEFAULT_IMAGE_TEXT;
        if (images.length > 1) {
          msg.extraMedia = images.slice(1).map((im, i) => ({
            messageId: `${msg.messageId}:${i + 1}`,
            imageKey: encodeMediaRef(im.aeskey, im.url),
          }));
        }
      }
      break;
    }

    default:
      return undefined;
  }

  if (!msg.text && !msg.imageKey && !msg.fileKey) return undefined;
  return msg;
}

/** Welcome message for the enter-chat event. */
function welcomeText(config: WecomBotConfig): string {
  if (config.description) return config.description;
  return '您好！我是接入 Claude Code 的智能助手，有什么可以帮您的吗？';
}

/** Resolve once the bot authenticates, or after a timeout (SDK keeps retrying either way). */
function waitForAuth(client: WSClient, timeoutMs: number, logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (!done) {
        logger.warn('WeCom authentication not confirmed within timeout; continuing (SDK will keep retrying)');
        finish();
      }
    }, timeoutMs);
    client.once('authenticated', finish);
  });
}

/** Adapt the pino logger to the SDK Logger interface; SDK info is demoted to debug to reduce noise. */
function makeSdkLogger(logger: Logger): SdkLogger {
  const toMsg = (message: string, args: unknown[]): string =>
    args.length === 0
      ? String(message)
      : `${message} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  return {
    debug: (message: string, ...args: unknown[]) => logger.debug(toMsg(message, args)),
    info: (message: string, ...args: unknown[]) => logger.debug(toMsg(message, args)),
    warn: (message: string, ...args: unknown[]) => logger.warn(toMsg(message, args)),
    error: (message: string, ...args: unknown[]) => logger.error(toMsg(message, args)),
  };
}
