import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';
import type { CardState } from '../src/types.js';
import type { IMessageSender } from '../src/bridge/message-sender.interface.js';
import { sendCompletionNotice } from '../src/bridge/notification-policy.js';

function makeConfig(overrides: Partial<BotConfigBase> = {}): BotConfigBase {
  return {
    name: 'test',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/outputs',
      downloadsDir: '/tmp/downloads',
      backend: 'pty',
    },
    ...overrides,
  };
}

function makeState(status: CardState['status']): CardState {
  return {
    status,
    userPrompt: 'prompt',
    responseText: 'response',
    toolCalls: [],
  };
}

function makeSender(overrides: Partial<IMessageSender> = {}): IMessageSender {
  return {
    sendCard: vi.fn(),
    updateCard: vi.fn(),
    sendTextNotice: vi.fn(),
    sendText: vi.fn(),
    sendImageFile: vi.fn(),
    sendLocalFile: vi.fn(),
    downloadImage: vi.fn(),
    downloadFile: vi.fn(),
    ...overrides,
  };
}

describe('sendCompletionNotice', () => {
  afterEach(() => {
    delete process.env.METABOT_VOICE_REPLY;
    delete process.env.FEISHU_VOICE_REPLY;
    delete process.env.METABOT_VOICE_REPLY_DEFAULT_ON;
    vi.restoreAllMocks();
  });

  it('skips short tasks', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 9_999,
    });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('skips senders that already route final responses separately', async () => {
    const sender = makeSender({ skipCompletionNotice: true });
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('skips successful tasks when voice reply is enabled', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig({ voiceReply: { enabled: true } }),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('sends Done for long successful tasks without voice reply', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    expect(sender.sendText).toHaveBeenCalledWith('chat', '✅ Done');
  });

  it('does not announce completion while a background task is still running', async () => {
    const sender = makeSender();
    const state = {
      ...makeState('complete'),
      backgroundEvents: [{ taskId: 'monitor-1', description: 'Monitor release', status: 'running' as const }],
    };

    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state,
      durationMs: 20_000,
    });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('announces completion again once background work has finished', async () => {
    const sender = makeSender();
    const state = {
      ...makeState('complete'),
      backgroundEvents: [{ taskId: 'monitor-1', description: 'Monitor release', status: 'completed' as const }],
    };

    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state,
      durationMs: 20_000,
    });

    expect(sender.sendText).toHaveBeenCalledWith('chat', '✅ Done');
  });

  it('sends Failed for long failed tasks', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig({ voiceReply: { enabled: true } }),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('error'),
      durationMs: 10_000,
    });

    expect(sender.sendText).toHaveBeenCalledWith('chat', '❌ Failed');
  });

  it('logs and swallows send failures', async () => {
    const logger = { warn: vi.fn() };
    const sender = makeSender({ sendText: vi.fn().mockRejectedValue(new Error('nope')) });
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: logger as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat' }), 'Failed to send completion notice');
  });
});
