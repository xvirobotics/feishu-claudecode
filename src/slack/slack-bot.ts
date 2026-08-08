import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import type { SlackBotConfig, BotConfigBase } from '../config.js';
import type { IncomingMessage } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import { MessageBridge } from '../bridge/message-bridge.js';
import { jsonResponse, readBody } from '../api/routes/helpers.js';
import type { BotRegistry } from '../api/bot-registry.js';
import { SlackSender, resolveSlackBotUserId } from './slack-sender.js';

const SIGNATURE_VERSION = 'v0';
const MAX_SIGNATURE_AGE_SECONDS = 60 * 5;

export interface SlackBotHandle {
  name: string;
  bridge: MessageBridge;
  config: BotConfigBase;
  sender: IMessageSender;
  botUserId?: string;
}

export interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event?: SlackEvent;
}

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  client_msg_id?: string;
  files?: SlackFile[];
}

export async function startSlackBot(config: SlackBotConfig, logger: Logger): Promise<SlackBotHandle> {
  const botLogger = logger.child({ bot: config.name, platform: 'slack' });
  botLogger.info('Starting Slack bot...');

  const sender = new SlackSender(config, botLogger);
  const bridge = new MessageBridge(config, botLogger, sender);
  let botUserId = config.slack.botUserId;
  if (!botUserId) {
    try {
      botUserId = await resolveSlackBotUserId(config.slack.botToken);
      if (botUserId) {
        config.slack.botUserId = botUserId;
        botLogger.info({ botUserId }, 'Slack bot info fetched');
      } else {
        botLogger.warn(
          'Slack auth.test did not return bot user ID; channel messages require app_mention events unless slackBotUserId is configured',
        );
      }
    } catch (err) {
      botLogger.warn(
        { err },
        'Failed to fetch Slack bot info during startup; continuing with configured metadata only',
      );
    }
  }

  botLogger.info(
    {
      defaultWorkingDirectory: config.claude.defaultWorkingDirectory,
      maxTurns: config.claude.maxTurns ?? 'unlimited',
      maxBudgetUsd: config.claude.maxBudgetUsd ?? 'unlimited',
    },
    'Configuration',
  );

  return { name: config.name, bridge, config, sender, botUserId };
}

export function isSlackEventsRoute(method: string, url: string): boolean {
  return method === 'POST' && /^\/api\/slack\/events(?:\/[^/?]+)?(?:\?|$)/.test(url);
}

export async function handleSlackEventsRoute(
  registry: BotRegistry,
  logger: Logger,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
): Promise<boolean> {
  if (!isSlackEventsRoute(req.method || 'GET', url)) return false;
  const botName = slackBotNameFromUrl(url);
  if (!botName) {
    jsonResponse(res, 400, { error: 'Missing Slack bot name. Use /api/slack/events/<botName>.' });
    return true;
  }
  const bot = registry.getByPlatform(botName, 'slack');
  if (!bot || !('slack' in bot.config)) {
    jsonResponse(res, 404, { error: `Slack bot not found: ${botName}` });
    return true;
  }
  const slackConfig = bot.config as SlackBotConfig;

  const rawBody = await readBody(req);
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!verifySlackSignature(slackConfig.slack.signingSecret, rawBody, timestamp, signature)) {
    jsonResponse(res, 401, { error: 'Invalid Slack signature' });
    return true;
  }

  let payload: SlackEventEnvelope;
  try {
    payload = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON in Slack request body' });
    return true;
  }

  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    jsonResponse(res, 200, { challenge: payload.challenge });
    return true;
  }

  if (payload.type !== 'event_callback' || !payload.event) {
    jsonResponse(res, 200, { ok: true, ignored: true });
    return true;
  }

  const dispatch = slackEventToIncomingMessage(payload.event, slackConfig, logger);
  if (!dispatch) {
    jsonResponse(res, 200, { ok: true, ignored: true });
    return true;
  }

  bot.bridge.handleMessage(dispatch).catch((err) => {
    logger.error({ err, botName, chatId: dispatch.chatId }, 'Unhandled error in Slack message bridge');
  });
  jsonResponse(res, 200, { ok: true });
  return true;
}

export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestampHeader: string | string[] | undefined,
  signatureHeader: string | string[] | undefined,
  nowMs = Date.now(),
): boolean {
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const base = `${SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const expected = `${SIGNATURE_VERSION}=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  return timingSafeEqual(expected, signature);
}

export function slackEventToIncomingMessage(
  event: SlackEvent,
  config: SlackBotConfig,
  logger?: Logger,
): IncomingMessage | undefined {
  if (
    event.bot_id ||
    event.subtype === 'bot_message' ||
    event.subtype === 'message_changed' ||
    event.subtype === 'message_deleted'
  ) {
    return undefined;
  }
  if (!event.channel || !event.user) return undefined;
  if (event.type !== 'message' && event.type !== 'app_mention') return undefined;

  const channelType = event.channel_type || (event.type === 'app_mention' ? 'channel' : 'unknown');
  const isDirectMessage = channelType === 'im';
  const text = event.text || '';
  const botUserId = config.slack.botUserId;
  const mentionToken = botUserId ? `<@${botUserId}>` : undefined;
  const mentioned = event.type === 'app_mention' || (mentionToken ? text.includes(mentionToken) : false);

  if (!isDirectMessage && !mentioned && !config.groupNoMention) {
    return undefined;
  }

  const cleanText = stripBotMention(text, botUserId).trim();
  const files = event.files || [];
  const firstFile = files[0];
  const fileKey = firstFile?.url_private_download || firstFile?.url_private || firstFile?.id;
  const isImage = firstFile?.mimetype?.startsWith('image/');
  const fallbackText = isImage ? '请分析这张图片' : fileKey ? '请分析这个文件' : '';
  const finalText = cleanText || fallbackText;
  if (!finalText) return undefined;

  if (firstFile && !fileKey) {
    logger?.warn({ file: firstFile }, 'Slack file event missing downloadable URL and ID');
  }

  return {
    messageId: event.client_msg_id || event.ts || `${event.channel}:${Date.now()}`,
    chatId: event.channel,
    chatType: channelType,
    userId: event.user,
    text: finalText,
    timestamp: event.ts ? Math.floor(Number.parseFloat(event.ts) * 1000) : undefined,
    ...(fileKey && isImage ? { imageKey: fileKey } : {}),
    ...(fileKey && !isImage ? { fileKey } : {}),
    ...(firstFile?.name ? { fileName: firstFile.name } : {}),
  };
}

function slackBotNameFromUrl(url: string): string | undefined {
  const parsed = new URL(url, 'http://localhost');
  const match = parsed.pathname.match(/^\/api\/slack\/events\/([^/]+)$/);
  if (match) return decodeURIComponent(match[1]);
  const bot = parsed.searchParams.get('bot');
  return bot || undefined;
}

function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${escapeRegExp(botUserId)}>`, 'g'), '').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
