/**
 * Integration-style tests for the card flow:
 * - Turn content is embedded in frozen cards (not sent as separate text messages)
 * - Result card is always sent at the bottom (after all turn cards)
 * - Single-turn tasks update the existing card in place
 */
import { describe, it, expect, vi } from 'vitest';
import type { IMessageSender } from '../src/bridge/message-sender.interface.js';
import type { CardState } from '../src/types.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';

function mockConfig() {
  return {
    name: 'test-bot',
    claude: {
      defaultWorkingDirectory: '/tmp/test',
      maxTurns: 10,
      maxBudgetUsd: 1,
      model: undefined,
      thinking: undefined,
      effort: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/test-outputs',
      downloadsDir: '/tmp/test-downloads',
    },
  } as any;
}

function mockSender() {
  let cardCounter = 0;
  const sender: IMessageSender = {
    sendCard: vi.fn(async () => `card_${++cardCounter}`),
    updateCard: vi.fn(async () => {}),
    sendTextNotice: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendImageFile: vi.fn(async () => true),
    sendLocalFile: vi.fn(async () => true),
    downloadImage: vi.fn(async () => true),
    downloadFile: vi.fn(async () => true),
  };
  return sender;
}

function mockLogger() {
  const noop = () => {};
  const logger: any = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return logger;
}

function makeBridge(sender: IMessageSender) {
  return new MessageBridge(mockConfig(), mockLogger(), sender, '');
}

describe('recreateCard — turn content in frozen card', () => {
  it('freezes old card with turn text and creates new card', async () => {
    const sender = mockSender();
    const bridge = makeBridge(sender);

    const state: CardState = {
      status: 'running',
      userPrompt: 'test',
      responseText: 'new turn starting...',
      toolCalls: [],
      startTime: Date.now(),
    };

    const turnText = 'This is the completed Turn 1 response with full content.';
    const newId = await (bridge as any).recreateCard('chat1', 'old_card', state, 'Turn 1', turnText);

    // Old card frozen WITH the turn content (not empty)
    expect(sender.updateCard).toHaveBeenCalledWith('old_card', expect.objectContaining({
      status: 'complete',
      responseText: turnText,
      cardTitle: 'Turn 1',
    }));

    // New card created for next turn
    expect(sender.sendCard).toHaveBeenCalledWith('chat1', expect.objectContaining({
      status: 'thinking',
      responseText: '',
    }));

    expect(newId).toBe('card_1');
  });

  it('freezes card with empty text when no turnText provided', async () => {
    const sender = mockSender();
    const bridge = makeBridge(sender);

    const state: CardState = { status: 'running', userPrompt: 'test', responseText: '', toolCalls: [] };
    await (bridge as any).recreateCard('chat1', 'old_card', state, 'Turn 1');

    expect(sender.updateCard).toHaveBeenCalledWith('old_card', expect.objectContaining({
      status: 'complete',
      responseText: '',
      cardTitle: 'Turn 1',
    }));
  });

  it('retries freeze if first attempt fails', async () => {
    const sender = mockSender();
    const bridge = makeBridge(sender);

    let callCount = 0;
    (sender.updateCard as any).mockImplementation(async () => {
      if (++callCount === 1) throw new Error('network error');
    });

    const state: CardState = { status: 'running', userPrompt: 'test', responseText: '', toolCalls: [] };
    await (bridge as any).recreateCard('chat1', 'old_card', state, 'Turn 1', 'content');

    expect(sender.updateCard).toHaveBeenCalledTimes(2);
  });
});

describe('sendFinalCard — multi-turn vs single-turn', () => {
  it('multi-turn: freezes card with last turn content + sends new Result card', async () => {
    const sender = mockSender();
    const bridge = makeBridge(sender);

    const state: CardState = {
      status: 'complete',
      userPrompt: 'test',
      responseText: '',
      toolCalls: [],
      resultSummary: 'Task done: 3 files modified.',
    };

    const lastTurnText = 'This is the final turn response content.';
    await (bridge as any).sendFinalCard('existing_card', state, 'chat1', lastTurnText, 2);

    // 1) Old card frozen with turn content + label
    expect(sender.updateCard).toHaveBeenCalledWith('existing_card', expect.objectContaining({
      status: 'complete',
      responseText: lastTurnText,
      cardTitle: 'Turn 2',
    }));

    // 2) New Result card sent at bottom with resultSummary
    expect(sender.sendCard).toHaveBeenCalledWith('chat1', expect.objectContaining({
      responseText: 'Task done: 3 files modified.',
      cardTitle: '📊 Result',
    }));

    // 3) No separate text notice for resultSummary
    expect(sender.sendTextNotice).not.toHaveBeenCalled();
  });

  it('multi-turn without resultSummary: Result card shows pointer text', async () => {
    const sender = mockSender();
    const bridge = makeBridge(sender);

    const state: CardState = {
      status: 'complete',
      userPrompt: 'test',
      responseText: '',
      toolCalls: [],
    };

    await (bridge as any).sendFinalCard('card1', state, 'chat1', 'turn content', 1);

    expect(sender.sendCard).toHaveBeenCalledWith('chat1', expect.objectContaining({
      responseText: '_See cards above for full response_',
      cardTitle: '📊 Result',
    }));
  });

  it('single-turn: updates existing card in place', async () => {
    const sender = mockSender();
    const bridge = makeBridge(sender);

    const state: CardState = {
      status: 'complete',
      userPrompt: 'test',
      responseText: 'short response',
      toolCalls: [],
    };

    await (bridge as any).sendFinalCard('card1', state, 'chat1', undefined, 0);

    // Updates existing card (no new card)
    expect(sender.updateCard).toHaveBeenCalledWith('card1', expect.objectContaining({
      responseText: 'short response',
      cardTitle: '📊 Result',
    }));
    expect(sender.sendCard).not.toHaveBeenCalled();
  });

  it('single-turn with resultSummary: sends summary as separate message', async () => {
    const sender = mockSender();
    const bridge = makeBridge(sender);

    const state: CardState = {
      status: 'complete',
      userPrompt: 'test',
      responseText: '',
      toolCalls: [],
      resultSummary: 'All done.',
    };

    await (bridge as any).sendFinalCard('card1', state, 'chat1', undefined, 0);

    // Summary sent as separate text notice
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '📊 Result',
      'All done.',
      'blue',
    );
  });
});
