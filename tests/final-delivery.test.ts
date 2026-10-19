import { describe, it, expect, vi } from 'vitest';
import { sendFinalCardWithRetry } from '../src/bridge/final-delivery.js';
import type { CardState } from '../src/types.js';

// The real backoff would make these tests wait ~14s. Only the delay matters
// for the fallback behaviour, so keep the retry count but remove the wait.
vi.mock('../src/bridge/bridge-constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bridge/bridge-constants.js')>();
  return { ...actual, FINAL_CARD_BASE_DELAY_MS: 0 };
});

function makeState(responseText = 'done'): CardState {
  return {
    status: 'complete',
    userPrompt: 'question',
    responseText,
    toolCalls: [],
    totalTokens: 10,
    costUsd: 0.01,
    durationMs: 1000,
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as any;
}

function makeSessionManager() {
  return {
    addUsage: vi.fn(),
    getSession: vi.fn().mockReturnValue({ cumulativeCostUsd: 0.42 }),
  } as any;
}

function makeSender(overrides: Record<string, unknown> = {}) {
  return {
    sendCard: vi.fn().mockResolvedValue('new-card-id'),
    updateCard: vi.fn().mockResolvedValue(true),
    sendText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function deliver(sender: any, state = makeState(), chatId: string | null = 'chat-1') {
  return sendFinalCardWithRetry({
    sender,
    config: {} as any,
    logger: makeLogger(),
    sessionManager: makeSessionManager(),
    messageId: 'card-1',
    state,
    chatId: chatId ?? undefined,
  });
}

describe('sendFinalCardWithRetry', () => {
  it('updates the existing card when the update succeeds', async () => {
    const sender = makeSender();

    await deliver(sender);

    expect(sender.updateCard).toHaveBeenCalledWith('card-1', expect.any(Object));
    expect(sender.sendCard).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('sends a new card when every update is rejected (e.g. Feishu 230020)', async () => {
    const sender = makeSender({ updateCard: vi.fn().mockResolvedValue(false) });
    const state = makeState();

    await deliver(sender, state);

    expect(sender.updateCard).toHaveBeenCalledTimes(3);
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    expect(sender.sendCard).toHaveBeenCalledWith('chat-1', state);
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('falls back to text only when the new card also fails', async () => {
    const sender = makeSender({
      updateCard: vi.fn().mockResolvedValue(false),
      sendCard: vi.fn().mockResolvedValue(undefined),
    });

    await deliver(sender);

    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(sender.sendText.mock.calls[0][0]).toBe('chat-1');
    expect(sender.sendText.mock.calls[0][1]).toMatch(/^✅ /);
  });

  it('truncates the text fallback to 2000 characters', async () => {
    const sender = makeSender({
      updateCard: vi.fn().mockResolvedValue(false),
      sendCard: vi.fn().mockResolvedValue(undefined),
    });

    await deliver(sender, makeState('x'.repeat(5000)));

    const text: string = sender.sendText.mock.calls[0][1];
    expect(text).toHaveLength(2002); // "✅ " + 2000 chars
  });

  it('does not try fallbacks when no chatId is available', async () => {
    const sender = makeSender({ updateCard: vi.fn().mockResolvedValue(false) });

    await deliver(sender, makeState(), null);

    expect(sender.sendCard).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});
