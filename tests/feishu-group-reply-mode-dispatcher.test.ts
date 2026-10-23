import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers: Record<string, (data: unknown) => unknown> = {};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  EventDispatcher: class {
    register(handlers: Record<string, (data: unknown) => unknown>) {
      Object.assign(registeredHandlers, handlers);
    }
  },
}));

import { feishuConversationId } from '../src/feishu/conversation.js';
import { createEventDispatcher } from '../src/feishu/event-handler.js';
import { FeishuGroupReplyModeStore } from '../src/feishu/group-reply-mode-store.js';
import { createLogger } from '../src/utils/logger.js';

const dirs: string[] = [];
let sequence = 0;

afterEach(() => {
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function groupTextEvent(options: { text: string; chatId: string; userId?: string; mentionedBotOpenId?: string }) {
  const { text, chatId, userId = 'owner-1', mentionedBotOpenId } = options;
  const mentionTag = mentionedBotOpenId ? '@_user_1 ' : '';
  return {
    sender: { sender_id: { open_id: userId } },
    message: {
      message_id: `message-${++sequence}`,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: `${mentionTag}${text}` }),
      mentions: mentionedBotOpenId
        ? [{ key: '@_user_1', id: { open_id: mentionedBotOpenId }, name: 'Mentioned Bot' }]
        : [],
    },
  };
}

function groupImageEvent(chatId: string, userId = 'member-1') {
  return {
    sender: { sender_id: { open_id: userId } },
    message: {
      message_id: `image-message-${++sequence}`,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'image-key-1' }),
      mentions: [],
    },
  };
}

function createStore(): FeishuGroupReplyModeStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-feishu-dispatcher-'));
  dirs.push(dir);
  return new FeishuGroupReplyModeStore(createLogger('silent'), path.join(dir, 'modes.db'));
}

function setup(
  options: {
    botName?: string;
    botOpenId?: string;
    chatMemberCount?: number;
    configGroupNoMention?: boolean;
    store?: FeishuGroupReplyModeStore;
  } = {},
) {
  const {
    botName = 'agent-a',
    botOpenId = 'bot-open-id-a',
    chatMemberCount = 5,
    configGroupNoMention = false,
    store = createStore(),
  } = options;
  const onMessage = vi.fn();
  const sendNotice = vi.fn(async () => {});
  const sender = {
    getChatMemberCount: vi.fn(async () => chatMemberCount),
    isChatOwner: vi.fn(async (_chatId: string, userId: string) => userId === 'owner-1'),
  };
  createEventDispatcher(
    { name: botName, groupNoMention: configGroupNoMention } as never,
    createLogger('silent'),
    onMessage,
    botOpenId,
    sender as never,
    undefined,
    store,
    sendNotice,
  );
  const handle = registeredHandlers['im.message.receive_v1'];
  if (!handle) throw new Error('message handler not registered');
  return { botName, botOpenId, store, onMessage, sendNotice, sender, handle };
}

describe('Feishu group reply mode dispatcher', () => {
  it.each(['text', 'post'])('dispatches a bare bot mention in a %s message with chat history instructions', async (messageType) => {
    const ctx = setup();
    const event = groupTextEvent({ text: '  ', chatId: 'bare-mention-chat', mentionedBotOpenId: ctx.botOpenId });
    await ctx.handle({ ...event, message: {
      ...event.message,
      message_type: messageType,
      ...(messageType === 'post' ? { content: JSON.stringify({
        zh_cn: { title: '', content: [[{ tag: 'at', user_id: ctx.botOpenId }]] },
      }) } : {}),
    } });
    expect(ctx.onMessage).toHaveBeenCalledTimes(1);
    expect(ctx.onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'bare-mention-chat',
      text: expect.stringContaining('当前聊天的近期记录（chat_id: bare-mention-chat）'),
    }));
    expect(ctx.onMessage.mock.calls[0][0].text).toContain('lark-cli');
    expect(ctx.onMessage.mock.calls[0][0].text).toContain('包括前面未 @ 你的消息');
    ctx.store.close();
  });

  it.each([
    { thread_id: 'thread-1', root_id: 'root-1', parent_id: 'parent-1' },
    { root_id: 'root-1' },
    { parent_id: 'parent-1' },
    { thread_id: 'thread-1' },
  ])('scopes a bare mention to the topic with metadata %j', async (metadata) => {
    const ctx = setup();
    const event = groupTextEvent({ text: '', chatId: 'bare-topic-chat', mentionedBotOpenId: ctx.botOpenId });
    await ctx.handle({ ...event, message: { ...event.message, ...metadata } });
    expect(ctx.onMessage).toHaveBeenCalledTimes(1);
    const received = ctx.onMessage.mock.calls[0][0];
    expect(received.text).toContain('当前话题的聊天记录（chat_id: bare-topic-chat，');
    expect(received.text).toContain(`thread_id: ${metadata.thread_id || '未提供'}`);
    expect(received.text).toContain(`root_message_id: ${metadata.root_id || metadata.parent_id || event.message.message_id}`);
    expect(received.threadId).toBe(metadata.thread_id);
    expect(received.rootMessageId).toBe(metadata.root_id);
    expect(received.parentMessageId).toBe(metadata.parent_id);
    ctx.store.close();
  });

  it.each([undefined, 'another-bot'])('ignores empty messages without an exact bot mention even in all mode (%s)', async (mentionedBotOpenId) => {
    const ctx = setup({ configGroupNoMention: true });
    await ctx.handle(groupTextEvent({ text: '  ', chatId: 'bare-other-chat', mentionedBotOpenId }));
    expect(ctx.onMessage).not.toHaveBeenCalled();
    ctx.store.close();
  });

  it('still ignores empty direct messages', async () => {
    const ctx = setup();
    const event = groupTextEvent({ text: ' ', chatId: 'empty-direct-chat' });
    await ctx.handle({ ...event, message: { ...event.message, chat_type: 'p2p' } });
    expect(ctx.onMessage).not.toHaveBeenCalled();
    ctx.store.close();
  });

  it('keeps rich-text images and ordinary mention text intact', async () => {
    const ctx = setup();
    const event = groupTextEvent({ text: 'hello', chatId: 'mention-content-chat', mentionedBotOpenId: ctx.botOpenId });
    await ctx.handle(event);
    expect(ctx.onMessage.mock.calls[0][0].text).toBe('hello');
    await ctx.handle({ ...event, message: {
      ...event.message, message_id: `post-${++sequence}`, message_type: 'post',
      content: JSON.stringify({ zh_cn: { title: '', content: [[
        { tag: 'at', user_id: ctx.botOpenId }, { tag: 'img', image_key: 'inline-image' },
      ]] } }),
    } });
    expect(ctx.onMessage.mock.calls[1][0]).toEqual(expect.objectContaining({
      imageKey: 'inline-image', text: '[Image 1]',
    }));
    ctx.store.close();
  });

  it('attaches cached media when the next message is a bare mention', async () => {
    const ctx = setup();
    await ctx.handle(groupImageEvent('bare-media-chat', 'member-1'));
    await ctx.handle(groupTextEvent({
      text: '', chatId: 'bare-media-chat', userId: 'member-1', mentionedBotOpenId: ctx.botOpenId,
    }));
    expect(ctx.onMessage).toHaveBeenCalledTimes(1);
    expect(ctx.onMessage.mock.calls[0][0].extraMedia).toEqual([
      expect.objectContaining({ imageKey: 'image-key-1' }),
    ]);
    ctx.store.close();
  });

  it('does not attach cached media from another topic', async () => {
    const ctx = setup();
    const image = groupImageEvent('media-topic-chat', 'member-1');
    await ctx.handle({ ...image, message: { ...image.message, root_id: 'root-a' } });
    const text = groupTextEvent({ text: 'hello', chatId: 'media-topic-chat', userId: 'member-1', mentionedBotOpenId: ctx.botOpenId });
    await ctx.handle({ ...text, message: { ...text.message, root_id: 'root-b' } });
    expect(ctx.onMessage.mock.calls[0][0].extraMedia).toBeUndefined();
    await ctx.handle({ ...text, message: { ...text.message, root_id: 'root-a' } });
    expect(ctx.onMessage.mock.calls[1][0].extraMedia).toEqual([expect.objectContaining({ imageKey: 'image-key-1' })]);
    ctx.store.close();
  });

  it.each(['group', 'p2p'])('retains thread metadata in %s messages', async (chatType) => {
    const ctx = setup();
    const event = groupTextEvent({ text: 'hello', chatId: 'thread-chat', mentionedBotOpenId: ctx.botOpenId });
    await ctx.handle({ ...event, message: {
      ...event.message, chat_type: chatType, parent_id: 'parent-1', root_id: 'root-1', thread_id: 'thread-1',
    } });
    expect(ctx.onMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: event.message.message_id, chatType,
      chatId: feishuConversationId({ messageId: event.message.message_id, chatId: 'thread-chat', chatType, userId: 'u', text: '', rootMessageId: 'root-1' }),
      parentMessageId: 'parent-1', rootMessageId: 'root-1', threadId: 'thread-1',
    }));
    ctx.store.close();
  });

  it('lets an owner set all mode only through an exact current-bot mention', async () => {
    const chatId = 'chat-owner-all';
    const ctx = setup();

    await ctx.handle(groupTextEvent({ text: '/group-reply all', chatId, mentionedBotOpenId: ctx.botOpenId }));
    expect(ctx.store.get(ctx.botName, chatId)).toBe('all');
    expect(ctx.sender.isChatOwner).toHaveBeenCalledWith(chatId, 'owner-1');
    expect(ctx.sendNotice).toHaveBeenCalledWith(chatId, '群回复模式已更新', expect.any(String), 'green');
    expect(ctx.onMessage).not.toHaveBeenCalled();

    await ctx.handle(groupTextEvent({ text: 'ordinary group message', chatId, userId: 'member-1' }));
    expect(ctx.onMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId, text: 'ordinary group message' }));
    ctx.store.close();
  });

  it('allows exact-mentioned status for members but rejects their mode changes', async () => {
    const chatId = 'chat-member-permissions';
    const ctx = setup();

    await ctx.handle(
      groupTextEvent({
        text: '/group-reply status',
        chatId,
        userId: 'member-1',
        mentionedBotOpenId: ctx.botOpenId,
      }),
    );
    expect(ctx.sendNotice).toHaveBeenCalledWith(chatId, '群回复模式', expect.any(String), 'blue');
    expect(ctx.sender.isChatOwner).not.toHaveBeenCalled();

    await ctx.handle(
      groupTextEvent({
        text: '/group-reply all',
        chatId,
        userId: 'member-1',
        mentionedBotOpenId: ctx.botOpenId,
      }),
    );
    expect(ctx.sendNotice).toHaveBeenCalledWith(chatId, '无权限切换群回复模式', expect.any(String), 'red');
    expect(ctx.store.get(ctx.botName, chatId)).toBeUndefined();
    expect(ctx.onMessage).not.toHaveBeenCalled();
    ctx.store.close();
  });

  it('ignores bare and foreign-mentioned commands and prevents cross-Agent mutations', async () => {
    const chatId = 'chat-multi-agent';
    const store = createStore();
    const agentA = setup({ botName: 'agent-a', botOpenId: 'bot-open-id-a', store });
    const agentB = setup({ botName: 'agent-b', botOpenId: 'bot-open-id-b', store });

    await agentA.handle(groupTextEvent({ text: '/group-reply all', chatId }));
    await agentA.handle(groupTextEvent({ text: '/group-reply all', chatId, mentionedBotOpenId: agentB.botOpenId }));
    expect(store.get('agent-a', chatId)).toBeUndefined();
    expect(agentA.sendNotice).not.toHaveBeenCalled();
    expect(agentA.sender.isChatOwner).not.toHaveBeenCalled();
    expect(agentA.onMessage).not.toHaveBeenCalled();

    await agentB.handle(groupTextEvent({ text: '/group-reply all', chatId, mentionedBotOpenId: agentB.botOpenId }));
    expect(store.get('agent-a', chatId)).toBeUndefined();
    expect(store.get('agent-b', chatId)).toBe('all');
    store.close();
  });

  it('lets stored mention mode override both global-all and two-person defaults', async () => {
    const chatId = 'chat-explicit-mention';
    const ctx = setup({ configGroupNoMention: true, chatMemberCount: 2 });

    await ctx.handle(groupTextEvent({ text: '/group-reply mention', chatId, mentionedBotOpenId: ctx.botOpenId }));
    expect(ctx.store.get(ctx.botName, chatId)).toBe('mention');
    await ctx.handle(groupTextEvent({ text: 'ordinary group message', chatId, userId: 'member-1' }));
    expect(ctx.onMessage).not.toHaveBeenCalled();
    ctx.store.close();
  });

  it('keeps global-all and two-person defaults when no group override exists', async () => {
    const globalChatId = 'chat-global-all';
    const global = setup({ configGroupNoMention: true });
    await global.handle(groupTextEvent({ text: 'global message', chatId: globalChatId, userId: 'member-1' }));
    expect(global.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: globalChatId, text: 'global message' }),
    );
    global.store.close();

    const privateChatId = 'chat-two-person';
    const privateLike = setup({ chatMemberCount: 2 });
    await privateLike.handle(groupTextEvent({ text: 'two-person message', chatId: privateChatId, userId: 'member-1' }));
    expect(privateLike.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: privateChatId, text: 'two-person message' }),
    );
    privateLike.store.close();
  });

  it('caches unmentioned media in mention mode and processes it in all mode', async () => {
    const mentionChatId = 'chat-media-mention';
    const mention = setup();
    await mention.handle(groupImageEvent(mentionChatId));
    expect(mention.onMessage).not.toHaveBeenCalled();
    mention.store.close();

    const allChatId = 'chat-media-all';
    const all = setup();
    all.store.set(all.botName, allChatId, 'all', 'owner-1');
    await all.handle(groupImageEvent(allChatId));
    expect(all.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: allChatId, imageKey: 'image-key-1', text: '请分析这张图片' }),
    );
    all.store.close();
  });
});
