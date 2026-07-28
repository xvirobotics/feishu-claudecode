import * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { MessageSender } from './message-sender.js';
import {
  type FeishuGroupReplyMode,
  FeishuGroupReplyModeStore,
} from './group-reply-mode-store.js';

// Re-export from shared types so existing imports continue to work
export type { IncomingMessage } from '../types.js';
import type { IncomingMessage } from '../types.js';

export type MessageHandler = (msg: IncomingMessage) => void;

/** Payload delivered when a user clicks a button on an interactive card. */
export interface CardActionEvent {
  chatId: string;
  userId: string;
  messageId: string;
  /** Arbitrary value object set by the card builder on the clicked button. */
  value: Record<string, unknown>;
}

export type CardActionHandler = (event: CardActionEvent) => void;
export type GroupReplyModeNoticeHandler = (
  chatId: string,
  title: string,
  content: string,
  color: string,
) => Promise<void>;

// Cache for group member counts (to avoid calling Feishu API on every message)
const MEMBER_COUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const memberCountCache = new Map<string, { count: number; ts: number }>();

// Cache for recent media messages in group chats (file/image sent without @mention).
// When a user later @mentions the bot, cached media is attached automatically.
const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface CachedMedia {
  messageId: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  ts: number;
}
const pendingMediaCache = new Map<string, CachedMedia[]>(); // key: chatId:userId

function cacheMediaKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

function getCachedMedia(chatId: string, userId: string): CachedMedia[] {
  const key = cacheMediaKey(chatId, userId);
  const items = pendingMediaCache.get(key);
  if (!items) return [];
  const now = Date.now();
  const valid = items.filter(m => now - m.ts < MEDIA_CACHE_TTL_MS);
  if (valid.length === 0) {
    pendingMediaCache.delete(key);
    return [];
  }
  pendingMediaCache.set(key, valid);
  return valid;
}

function clearCachedMedia(chatId: string, userId: string): void {
  pendingMediaCache.delete(cacheMediaKey(chatId, userId));
}

// Feishu delivers webhook events at-least-once: when the handler is slow to
// ack (e.g. a long-running task or media download), the same message event is
// redelivered. Track recently seen message_ids so retries are dropped instead
// of being processed as new messages.
const PROCESSED_MSG_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROCESSED_MSG_MAX_ENTRIES = 500;

export interface MessageDeduper {
  /** True when messageId was already seen within the TTL; records it otherwise. */
  isDuplicate(messageId: string): boolean;
  /**
   * Forget a messageId after a failed processing attempt, so a Feishu
   * redelivery of the same event gets a fresh attempt instead of being
   * dropped as a duplicate.
   */
  release(messageId: string): void;
}

/**
 * Create a per-dispatcher message deduper. Per-dispatcher (rather than
 * module-level) state so that two bots receiving events for the same
 * message_id (e.g. one group message @-mentioning both bots) don't suppress
 * each other.
 *
 * Memory is hard-bounded: `maxEntries` is an invariant, not a cleanup hint.
 * On insert when the map is full, expired entries are swept first; if still
 * full, the oldest entries are evicted regardless of TTL. Entries are deleted
 * before re-insert on expiry, so Map iteration order stays first-seen order
 * and "oldest" is well-defined. Evicting a live entry trades a sliver of
 * dedup coverage (an extremely late redelivery of an evicted id would be
 * reprocessed) for a guaranteed memory ceiling.
 */
export function createMessageDeduper(
  ttlMs: number = PROCESSED_MSG_TTL_MS,
  maxEntries: number = PROCESSED_MSG_MAX_ENTRIES,
): MessageDeduper {
  const seen = new Map<string, number>(); // messageId -> first-seen ts
  return {
    isDuplicate(messageId) {
      const now = Date.now();
      const ts = seen.get(messageId);
      if (ts !== undefined && now - ts < ttlMs) return true;
      if (ts !== undefined) seen.delete(messageId); // expired: re-insert below so recency order holds
      if (seen.size >= maxEntries) {
        for (const [id, t] of seen) {
          if (now - t >= ttlMs) seen.delete(id);
        }
        while (seen.size >= maxEntries) {
          const oldest = seen.keys().next().value;
          if (oldest === undefined) break;
          seen.delete(oldest);
        }
      }
      seen.set(messageId, now);
      return false;
    },
    release(messageId) {
      seen.delete(messageId);
    },
  };
}

async function isPrivateLikeGroup(chatId: string, sender: MessageSender): Promise<boolean> {
  const cached = memberCountCache.get(chatId);
  if (cached && Date.now() - cached.ts < MEMBER_COUNT_CACHE_TTL_MS) {
    return cached.count === 2;
  }
  const count = await sender.getChatMemberCount(chatId);
  if (count !== undefined) {
    memberCountCache.set(chatId, { count, ts: Date.now() });
    return count === 2;
  }
  return false;
}

export function isBotMentioned(mentions: unknown, botOpenId?: string): boolean {
  if (!botOpenId || !Array.isArray(mentions)) {
    return false;
  }

  return mentions.some((mention) => {
    if (!mention || typeof mention !== 'object') {
      return false;
    }
    const id = (mention as { id?: { open_id?: unknown } }).id;
    return id?.open_id === botOpenId;
  });
}

export interface GroupReplyModeCommand {
  action: 'status' | 'set' | 'help';
  mode?: FeishuGroupReplyMode;
}

export function parseGroupReplyModeCommand(text: string): GroupReplyModeCommand | undefined {
  const match = text.trim().match(/^\/(?:group-reply|group_mode|群回复)(?:\s+(.+))?$/i);
  if (!match) return undefined;
  const arg = match[1]?.trim().toLowerCase();
  if (!arg || arg === 'status' || arg === '状态') return { action: 'status' };
  if (['mention', 'at', '@', '仅@', '只@', '必须@'].includes(arg)) {
    return { action: 'set', mode: 'mention' };
  }
  if (['all', '全部', '所有消息', '全量'].includes(arg)) {
    return { action: 'set', mode: 'all' };
  }
  return { action: 'help' };
}

export function shouldProcessGroupMessage(options: {
  botMentioned: boolean;
  storedMode?: FeishuGroupReplyMode;
  configGroupNoMention?: boolean;
  privateLikeGroup?: boolean;
}): boolean {
  if (options.botMentioned) return true;
  if (options.storedMode) return options.storedMode === 'all';
  return options.configGroupNoMention === true || options.privateLikeGroup === true;
}

function groupReplyModeDescription(mode: FeishuGroupReplyMode): string {
  return mode === 'all' ? '回复群里的所有消息' : '只有被 @ 时才回复';
}

export async function handleGroupReplyModeCommand(options: {
  text: string;
  botName: string;
  chatId: string;
  userId: string;
  defaultMode: FeishuGroupReplyMode;
  canChangeMode: boolean;
  store: FeishuGroupReplyModeStore;
  sendNotice: GroupReplyModeNoticeHandler;
}): Promise<boolean> {
  const command = parseGroupReplyModeCommand(options.text);
  if (!command) return false;
  const storedMode = options.store.get(options.botName, options.chatId);
  const currentMode = storedMode ?? options.defaultMode;

  if (command.action === 'set' && command.mode) {
    if (!options.canChangeMode) {
      await options.sendNotice(
        options.chatId,
        '无权限切换群回复模式',
        '只有当前飞书群的群主可以修改回复模式。所有群成员都可以 @ 当前 Bot 并使用 `/group-reply status` 查看状态。',
        'red',
      );
      return true;
    }
    options.store.set(options.botName, options.chatId, command.mode, options.userId);
    await options.sendNotice(
      options.chatId,
      '群回复模式已更新',
      `当前 Agent：\`${options.botName}\`\n当前群模式：**${groupReplyModeDescription(command.mode)}**\n\n命令：@ 当前 Bot 后使用 \`/group-reply mention\` 或 \`/group-reply all\``,
      'green',
    );
    return true;
  }

  if (command.action === 'status') {
    await options.sendNotice(
      options.chatId,
      '群回复模式',
      `当前 Agent：\`${options.botName}\`\n当前群模式：**${groupReplyModeDescription(currentMode)}**\n模式来源：${storedMode ? '当前群显式设置' : 'Agent 默认设置'}\n\n命令：@ 当前 Bot 后使用 \`/group-reply mention\` 或 \`/group-reply all\``,
      'blue',
    );
    return true;
  }

  await options.sendNotice(
    options.chatId,
    '群回复模式命令',
    '请先 @ 当前 Bot。用法：\n- `/group-reply mention` — 只有被 @ 时回复\n- `/group-reply all` — 回复群里的所有消息\n- `/group-reply status` — 查看当前模式',
    'orange',
  );
  return true;
}

export function createEventDispatcher(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
  onCardAction?: CardActionHandler,
  groupReplyModeStore?: FeishuGroupReplyModeStore,
  onGroupReplyModeNotice?: GroupReplyModeNoticeHandler,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});
  const messageDeduper = createMessageDeduper();

  // Register the card action trigger handler (fired when a user clicks a button
  // on an interactive card). The lark SDK types omit this event so we cast.
  if (onCardAction) {
    (dispatcher as unknown as {
      register: (handlers: Record<string, (data: unknown) => unknown>) => void;
    }).register({
      'card.action.trigger': (data: unknown) => {
        try {
          const d = data as {
            operator?: { open_id?: string };
            action?: { value?: unknown };
            context?: { open_message_id?: string; open_chat_id?: string };
          };
          const userId = d.operator?.open_id;
          const messageId = d.context?.open_message_id;
          const chatId = d.context?.open_chat_id;
          const raw = d.action?.value;
          if (!userId || !messageId || !chatId || !raw || typeof raw !== 'object') {
            logger.warn({ data }, 'Card action missing required fields');
            return { toast: { type: 'error', content: 'Invalid card action' } };
          }
          onCardAction({
            chatId,
            userId,
            messageId,
            value: raw as Record<string, unknown>,
          });
          return { toast: { type: 'success', content: '已收到' } };
        } catch (err) {
          logger.error({ err }, 'Error handling card action');
          return { toast: { type: 'error', content: 'Internal error' } };
        }
      },
    });
  }

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      // Set once this delivery is recorded in the deduper; released in the
      // catch below so a failed attempt doesn't suppress the redelivery.
      let inflightMessageId: string | undefined;
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        const msgType = message.message_type;

        // Only handle text, post (rich text), image, and file messages
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'image' && msgType !== 'file') {
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

        // Drop redelivered events: Feishu retries delivery when the ack is
        // slow, and a retry must not become a second task. Intentional drops
        // further down (not @mentioned, empty text, ...) keep the mark — they
        // are terminal decisions and a redelivery must be dropped the same way.
        if (messageId && messageDeduper.isDuplicate(messageId)) {
          logger.debug({ messageId, msgType }, 'Duplicate message delivery ignored');
          return;
        }
        inflightMessageId = messageId;

        const mentions = message.mentions;

        let commandText = '';
        let botMentioned = false;
        if (chatType === 'group') {
          botMentioned = isBotMentioned(mentions, botOpenId);
        }
        if (chatType === 'group' && msgType === 'text') {
          try {
            const content = JSON.parse(message.content);
            commandText = String(content.text || '').replace(/@_\w+\s*/g, '').trim();
          } catch {
            commandText = '';
          }

          const groupReplyCommand = parseGroupReplyModeCommand(commandText);
          if (groupReplyCommand && !botMentioned) {
            logger.debug({ chatId, botName: config.name }, 'Ignoring group reply mode command not addressed to this Bot');
            return;
          }
          if (groupReplyCommand && groupReplyModeStore && onGroupReplyModeNotice) {
            const storedMode = groupReplyModeStore.get(config.name, chatId);
            const inheritedPrivateLike = !storedMode && !config.groupNoMention && messageSender
              ? await isPrivateLikeGroup(chatId, messageSender)
              : false;
            const canChangeMode = groupReplyCommand.action !== 'set'
              || (await messageSender?.isChatOwner(chatId, userId)) === true;
            await handleGroupReplyModeCommand({
              text: commandText,
              botName: config.name,
              chatId,
              userId,
              defaultMode: config.groupNoMention || inheritedPrivateLike ? 'all' : 'mention',
              canChangeMode,
              store: groupReplyModeStore,
              sendNotice: onGroupReplyModeNotice,
            });
            logger.info({ chatId, userId, botName: config.name }, 'Handled group reply mode command');
            return;
          }
        }

        if (chatType === 'group') {
          const storedMode = groupReplyModeStore?.get(config.name, chatId);
          const privateLikeGroup = !storedMode && !config.groupNoMention && messageSender
            ? await isPrivateLikeGroup(chatId, messageSender)
            : false;
          if (!shouldProcessGroupMessage({
            botMentioned,
            storedMode,
            configGroupNoMention: config.groupNoMention,
            privateLikeGroup,
          })) {
            if (msgType === 'image' || msgType === 'file') {
              // Cache media messages for later retrieval when user @mentions bot
              const media = parseMediaMessage(message, msgType, logger);
              if (media) {
                const key = cacheMediaKey(chatId, userId);
                const items = pendingMediaCache.get(key) || [];
                items.push({ ...media, messageId, ts: Date.now() });
                pendingMediaCache.set(key, items);
                logger.info({ chatId, userId, msgType, ...media }, 'Cached group media for later @mention');
              }
              return;
            }
            logger.debug({ chatId, botName: config.name, storedMode }, 'Ignoring group message under mention-only mode');
            return;
          }
          logger.debug({ chatId, botName: config.name, storedMode }, 'Processing group message under reply mode');
        }

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;
        let postExtraImages: string[] = [];

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
        } else if (msgType === 'file') {
          // File message: extract file_key and file_name
          try {
            const content = JSON.parse(message.content);
            fileKey = content.file_key;
            fileName = content.file_name;
          } catch {
            logger.warn('Failed to parse file message content');
            return;
          }
          if (!fileKey || !fileName) {
            logger.warn('File message missing file_key or file_name');
            return;
          }
          text = '请分析这个文件';
          logger.info({ userId, chatId, chatType, fileKey, fileName }, 'Received file message');
        } else if (msgType === 'post') {
          // Rich text (post) message: extract plain text and images from nested structure,
          // preserving the original ordering by inlining [图N] placeholders where images appeared.
          try {
            const content = JSON.parse(message.content);
            logger.debug({ postContent: JSON.stringify(content).slice(0, 500) }, 'Raw post content');
            const interleaved = extractPostInterleaved(content);
            text = interleaved.text;
            if (interleaved.imageKeys.length > 0) {
              imageKey = interleaved.imageKeys[0];
              postExtraImages = interleaved.imageKeys.slice(1);
            }
            logger.debug({ extractedText: text.slice(0, 200), imageKey, postImageCount: interleaved.imageKeys.length }, 'Extracted post content');
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse post message content');
            return;
          }
        } else {
          // Text message: extract and clean text
          try {
            const content = JSON.parse(message.content);
            text = content.text || '';
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse message content');
            return;
          }
        }

        // Common text cleanup for text and post messages
        if (msgType === 'text' || msgType === 'post') {
          // Strip @mention tags (format: @_user_xxx or similar)
          text = text.replace(/@_\w+\s*/g, '').trim();

          // Strip Feishu auto-generated markdown links: [text](url) → text
          text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

          if (!text && !imageKey) {
            logger.debug('Empty message after stripping mentions');
            return;
          }

          // If text is empty but we have an image (e.g. @bot + image in group chat), set default prompt
          if (!text && imageKey) {
            text = '请分析这张图片';
          }

          logger.info({ userId, chatId, chatType, text: text.slice(0, 100), imageKey }, 'Received message');
        }

        // Collect extra media: post images (2nd+) and cached group media
        let extraMedia: IncomingMessage['extraMedia'];
        if (postExtraImages.length > 0) {
          extraMedia = postExtraImages.map(key => ({
            messageId,
            imageKey: key,
          }));
          logger.info({ chatId, postExtraImageCount: postExtraImages.length }, 'Attached extra images from post');
        }
        if (chatType === 'group') {
          const cached = getCachedMedia(chatId, userId);
          if (cached.length > 0) {
            const cachedMedia = cached.map(m => ({
              messageId: m.messageId,
              imageKey: m.imageKey,
              fileKey: m.fileKey,
              fileName: m.fileName,
            }));
            extraMedia = extraMedia ? [...extraMedia, ...cachedMedia] : cachedMedia;
            clearCachedMedia(chatId, userId);
            logger.info({ chatId, userId, mediaCount: cached.length }, 'Attached cached media to @mention message');
          }
        }

        onMessage({ messageId, chatId, chatType, userId, text, imageKey, fileKey, fileName, extraMedia });
      } catch (err) {
        // The message never reached a successful hand-off: forget the dedup
        // mark so a Feishu redelivery gets processed instead of being dropped
        // as a duplicate (otherwise a transient failure loses the message).
        if (inflightMessageId) messageDeduper.release(inflightMessageId);
        logger.error({ err }, 'Error handling message event');
      }
    },
  });

  return dispatcher;
}

/** Parse image/file message content, returning media fields or undefined on failure. */
function parseMediaMessage(
  message: any, msgType: string, logger: Logger,
): { imageKey?: string; fileKey?: string; fileName?: string } | undefined {
  try {
    const content = JSON.parse(message.content);
    if (msgType === 'image') {
      const imageKey = content.image_key;
      return imageKey ? { imageKey } : undefined;
    }
    if (msgType === 'file') {
      const fileKey = content.file_key;
      const fileName = content.file_name;
      return (fileKey && fileName) ? { fileKey, fileName } : undefined;
    }
  } catch {
    logger.warn({ msgType }, 'Failed to parse media message for caching');
  }
  return undefined;
}

/**
 * Extract text and images from a Feishu post (rich text) message in a single pass,
 * preserving the original ordering. Images are replaced with [Image N] placeholders
 * (1-indexed) inside the text, and the matching image_keys are returned in the
 * same order, so the caller can re-align them downstream.
 *
 * Handles two content shapes:
 *   With locale wrapper:    { "zh_cn": { "title": "...", "content": [[{tag, ...}, ...], ...] } }
 *   Without locale wrapper: { "title": "...", "content": [[{tag, ...}, ...], ...] }
 */
function extractPostInterleaved(
  content: Record<string, unknown>,
): { text: string; imageKeys: string[] } {
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    bodies.push(content);
  } else {
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  for (const body of bodies) {
    const parts: string[] = [];
    const imageKeys: string[] = [];

    if (body.title && typeof body.title === 'string') {
      parts.push(body.title);
    }

    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line: string[] = [];
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if ((el.tag === 'text' || el.tag === 'a') && typeof el.text === 'string') {
          line.push(el.text);
        } else if (el.tag === 'img' && typeof el.image_key === 'string') {
          imageKeys.push(el.image_key);
          line.push(`[Image ${imageKeys.length}]`);
        }
      }
      if (line.length > 0) {
        parts.push(line.join(''));
      }
    }

    if (parts.length > 0 || imageKeys.length > 0) {
      return { text: parts.join('\n'), imageKeys };
    }
  }

  return { text: '', imageKeys: [] };
}
