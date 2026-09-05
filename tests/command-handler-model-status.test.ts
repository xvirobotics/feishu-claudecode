/**
 * Tests for CommandHandler /status, /model, /memory, /sync commands,
 * plus edge cases: unknown slash commands, empty input, unicode, very long input.
 */
import { describe, it, expect } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';

interface RecordedNotice {
  chatId: string;
  title: string;
  content: string;
  color?: string;
}

interface BuildOpts {
  engine?: string;
  sessionModel?: string;
  sessionId?: string;
  hasRunningTask?: boolean;
  memoryError?: boolean;
  docSyncConfigured?: boolean;
}

function buildHandler(opts: BuildOpts = {}) {
  const notices: RecordedNotice[] = [];
  let sessionEngine: string | undefined = opts.engine;
  let sessionModel: string | undefined = opts.sessionModel;
  let reasoningEffort: string | undefined;

  const sender = {
    sendCard: async () => undefined,
    updateCard: async () => true,
    sendTextNotice: async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText: async () => {},
    sendImageFile: async () => true,
    sendLocalFile: async () => true,
    downloadImage: async () => true,
    downloadFile: async () => true,
  };

  const sessionManager = {
    getSession: (_chatId: string) => ({
      engine: sessionEngine,
      model: sessionModel,
      reasoningEffort,
      workingDirectory: '/workspace',
      sessionId: opts.sessionId,
    }),
    resetSession: () => {},
    setSessionEngine: (_chatId: string, engine: string | undefined) => {
      sessionEngine = engine;
    },
    setSessionModel: (_chatId: string, model: string | undefined) => {
      sessionModel = model;
    },
    setReasoningEffort: (_chatId: string, effort: string | undefined) => {
      reasoningEffort = effort;
    },
  } as any;

  const memoryClient = {
    listFolderTree: async () => {
      if (opts.memoryError) throw new Error('connection refused');
      return [];
    },
    formatFolderTree: () => '(empty)',
    search: async (query: string) => {
      if (opts.memoryError) throw new Error('connection refused');
      return [{ id: '1', title: `Result for ${query}` }];
    },
    formatSearchResults: (results: any[]) => results.map((r) => r.title).join('\n'),
    health: async () => {
      if (opts.memoryError) throw new Error('connection refused');
      return { status: 'ok', document_count: 42, folder_count: 5 };
    },
  } as any;

  // Config has engine defaults for all supported engines.
  const config = {
    name: 'test-bot',
    claude: { model: 'claude-opus-4-6' },
    kimi: { model: 'kimi-code/k3' },
    codex: { model: 'gpt-5.6', displayModel: 'gpt-5.6' },
  } as any;

  const handler = new CommandHandler(
    config,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender as any,
    sessionManager,
    memoryClient,
    { log: () => {} } as any,
    () => (opts.hasRunningTask ? { startTime: Date.now() - 500 } : undefined),
    () => {},
    () => 0,
    async () => {},
    () => [],
    async () => {},
  );

  if (opts.docSyncConfigured) {
    handler.setDocSync({
      isSyncing: () => false,
      syncAll: async () => ({ created: 3, updated: 1, skipped: 10, deleted: 0, durationMs: 1200, errors: [] }),
      getStats: () => ({ wikiSpaceId: 'sp_abc123', documentCount: 13, folderCount: 3 }),
    } as any);
  }

  return {
    handler,
    notices,
    getSessionEngine: () => sessionEngine,
    getSessionModel: () => sessionModel,
    getReasoningEffort: () => reasoningEffort,
  };
}

function msg(text: string): IncomingMessage {
  return {
    messageId: 'm1',
    chatId: 'c1',
    chatType: 'p2p',
    userId: 'u1',
    text,
    timestamp: Date.now(),
    isBotMentioned: true,
  } as IncomingMessage;
}

// =====================================================================
// /status
// =====================================================================

describe('CommandHandler /status', () => {
  it('shows status when no task is running', async () => {
    const { handler, notices } = buildHandler({ hasRunningTask: false });
    const handled = await handler.handle(msg('/status'));
    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Status');
    expect(notices[0].content).toContain('Running');
    expect(notices[0].content).toContain('No');
  });

  it('shows "Yes" when a task is running', async () => {
    const { handler, notices } = buildHandler({ hasRunningTask: true });
    await handler.handle(msg('/status'));
    expect(notices[0].content).toMatch(/Yes/);
  });

  it('includes userId, engine, working directory, and session info', async () => {
    const { handler, notices } = buildHandler({ sessionId: 'abc-123-xyz' });
    await handler.handle(msg('/status'));
    const body = notices[0].content;
    expect(body).toContain('u1');               // userId
    expect(body).toContain('codex');             // default engine
    expect(body).toContain('/workspace');        // working directory
    expect(body).toContain('abc-123');           // session id prefix
  });

  it('shows session override label when engine is overridden', async () => {
    const { handler, notices } = buildHandler({ engine: 'kimi' });
    await handler.handle(msg('/status'));
    expect(notices[0].content).toContain('session override');
  });

  it('shows default model when no session model is set', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/status'));
    expect(notices[0].content).toContain('gpt-5.6');
  });
});

// =====================================================================
// /model
// =====================================================================

describe('CommandHandler /model', () => {
  it('shows current model info when no args given', async () => {
    const { handler, notices } = buildHandler({});
    const handled = await handler.handle(msg('/model'));
    expect(handled).toBe(true);
    expect(notices[0].title).toContain('Model');
    expect(notices[0].content).toContain('gpt-5.6');
  });

  it('lists claude models on /model list when engine is claude', async () => {
    const { handler, notices } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/model list'));
    expect(notices[0].content).toContain('claude-opus-4-8');
    expect(notices[0].content).toContain('claude-sonnet-4-6');
    expect(notices[0].content).toContain('claude-haiku-4-5');
  });

  it('lists kimi models on /model list when engine is kimi', async () => {
    const { handler, notices } = buildHandler({ engine: 'kimi' });
    await handler.handle(msg('/model list'));
    expect(notices[0].content).toContain('kimi-code/k3');
    expect(notices[0].content).toContain('kimi-code/kimi-for-coding-highspeed');
  });

  it('lists codex models on /model list when engine is codex', async () => {
    const { handler, notices } = buildHandler({ engine: 'codex' });
    await handler.handle(msg('/model list'));
    expect(notices[0].content).toContain('gpt-6-astra');
    expect(notices[0].content).toContain('gpt-5.6');
    expect(notices[0].content).toContain('gpt-5.6-terra');
    expect(notices[0].content).toContain('gpt-5.6-luna');
    expect(notices[0].content).toContain('gpt-5.5');
    expect(notices[0].content).toContain('gpt-5.5-codex');
  });

  it('accepts /model ls as alias for list', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/model ls'));
    expect(notices[0].content).toContain('gpt-5.6');
  });

  it('switches engine to kimi on /model kimi', async () => {
    const { handler, notices, getSessionEngine } = buildHandler({});
    await handler.handle(msg('/model kimi'));
    expect(getSessionEngine()).toBe('kimi');
    expect(notices[0].color).toBe('green');
    expect(notices[0].content).toContain('kimi');
  });

  it('switches engine to codex on /model codex', async () => {
    const { handler, getSessionEngine } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/model codex'));
    expect(getSessionEngine()).toBe('codex');
  });

  it('switches engine to claude on /model claude', async () => {
    const { handler, notices, getSessionEngine } = buildHandler({ engine: 'kimi' });
    await handler.handle(msg('/model claude'));
    expect(getSessionEngine()).toBe('claude');
    expect(notices[0].color).toBe('green');
  });

  it('tells user when already on the requested engine', async () => {
    const { handler, notices, getSessionEngine } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/model claude'));
    // Should not change — already on claude
    expect(getSessionEngine()).toBe('claude');
    expect(notices[0].color).toBe('blue');
    expect(notices[0].title).toContain('Already');
  });

  it('sets a model name on /model <name>', async () => {
    const { handler, notices, getSessionModel } = buildHandler({});
    await handler.handle(msg('/model claude-opus-4-8'));
    expect(getSessionModel()).toBe('claude-opus-4-8');
    expect(notices[0].color).toBe('green');
    expect(notices[0].content).toContain('claude-opus-4-8');
  });

  it('refuses to change the model while a task is active', async () => {
    const { handler, notices, getSessionModel } = buildHandler({ hasRunningTask: true });
    await handler.handle(msg('/model claude-opus-4-8'));
    expect(getSessionModel()).toBeUndefined();
    expect(notices[0].title).toContain('Task In Progress');
    expect(notices[0].color).toBe('orange');
  });

  it('clears overrides on /model reset', async () => {
    const { handler, notices, getSessionEngine, getSessionModel } = buildHandler({
      engine: 'kimi',
      sessionModel: 'kimi-k2',
    });
    await handler.handle(msg('/model reset'));
    expect(getSessionEngine()).toBeUndefined();
    expect(getSessionModel()).toBeUndefined();
    expect(notices[0].color).toBe('green');
    expect(notices[0].title).toContain('Overrides Cleared');
  });

  it('clears overrides on /model clear alias', async () => {
    const { handler, getSessionEngine } = buildHandler({ engine: 'kimi' });
    await handler.handle(msg('/model clear'));
    expect(getSessionEngine()).toBeUndefined();
  });

  it('clears overrides on /model default alias', async () => {
    const { handler, getSessionEngine } = buildHandler({ engine: 'codex' });
    await handler.handle(msg('/model default'));
    expect(getSessionEngine()).toBeUndefined();
  });

  it('uses only the first token for model name (ignores trailing text)', async () => {
    const { handler, getSessionModel } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/model claude-opus-4-8 extra-junk'));
    expect(getSessionModel()).toBe('claude-opus-4-8');
  });
});

// =====================================================================
// /effort
// =====================================================================

describe('CommandHandler /effort', () => {
  it('shows current Codex effort when called with no args', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/effort'));
    expect(notices[0].title).toContain('Effort');
    expect(notices[0].content).toContain('codex');
    expect(notices[0].content).toContain('/effort max');
    expect(notices[0].content).toContain('/effort ultra');
  });

  it('sets Codex effort for the current session', async () => {
    const { handler, notices, getReasoningEffort } = buildHandler({});
    await handler.handle(msg('/effort high'));
    expect(getReasoningEffort()).toBe('high');
    expect(notices[0].color).toBe('green');
  });

  it('keeps max as a distinct Codex effort', async () => {
    const { handler, getReasoningEffort } = buildHandler({});
    await handler.handle(msg('/effort max'));
    expect(getReasoningEffort()).toBe('max');
  });

  it('keeps ultra as a distinct Codex effort', async () => {
    const { handler, getReasoningEffort } = buildHandler({});
    await handler.handle(msg('/effort ultra'));
    expect(getReasoningEffort()).toBe('ultra');
  });

  it('refuses effort changes when the active engine is not Codex', async () => {
    const { handler, notices, getReasoningEffort } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/effort high'));
    expect(getReasoningEffort()).toBeUndefined();
    expect(notices[0].color).toBe('blue');
  });

  it('clears Codex effort override', async () => {
    const { handler, getReasoningEffort } = buildHandler({});
    await handler.handle(msg('/effort xhigh'));
    await handler.handle(msg('/effort reset'));
    expect(getReasoningEffort()).toBeUndefined();
  });
});

// =====================================================================
// /memory
// =====================================================================

describe('CommandHandler /memory', () => {
  it('shows usage when called with no subcommand', async () => {
    const { handler, notices } = buildHandler({});
    const handled = await handler.handle(msg('/memory'));
    expect(handled).toBe(true);
    expect(notices[0].title).toContain('Memory');
    expect(notices[0].content).toContain('/memory list');
    expect(notices[0].content).toContain('/memory search');
  });

  it('lists folders on /memory list', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/memory list'));
    expect(notices[0].title).toContain('Memory Folders');
  });

  it('searches on /memory search <query>', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/memory search hello world'));
    expect(notices[0].title).toContain('Search: hello world');
    expect(notices[0].content).toContain('Result for hello world');
  });

  it('shows usage when search query is empty', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/memory search'));
    expect(notices[0].content).toContain('/memory search <query>');
  });

  it('shows health on /memory status', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/memory status'));
    expect(notices[0].content).toContain('42');
    expect(notices[0].color).toBe('green');
  });

  it('shows error notice when memory server is down', async () => {
    const { handler, notices } = buildHandler({ memoryError: true });
    await handler.handle(msg('/memory list'));
    expect(notices[0].title).toContain('Memory Error');
    expect(notices[0].color).toBe('red');
  });

  it('handles unknown subcommand gracefully', async () => {
    const { handler, notices } = buildHandler({});
    await handler.handle(msg('/memory unknowncmd'));
    expect(notices[0].title).toContain('Memory');
    expect(notices[0].color).toBe('orange');
    expect(notices[0].content).toContain('Unknown sub-command');
  });
});

// =====================================================================
// /sync
// =====================================================================

describe('CommandHandler /sync', () => {
  it('reports sync unavailable when no docSync configured', async () => {
    const { handler, notices } = buildHandler({});
    const handled = await handler.handle(msg('/sync'));
    expect(handled).toBe(true);
    expect(notices[0].title).toContain('Sync Unavailable');
    expect(notices[0].color).toBe('red');
  });

  it('triggers sync when docSync is configured', async () => {
    const { handler, notices } = buildHandler({ docSyncConfigured: true });
    await handler.handle(msg('/sync'));
    // Should have 2 notices: "sync started" then "sync complete"
    expect(notices.length).toBeGreaterThanOrEqual(2);
    const last = notices[notices.length - 1];
    expect(last.title).toContain('Sync Complete');
    expect(last.color).toBe('green');
    expect(last.content).toContain('**Created:** 3');
    expect(last.content).toContain('**Updated:** 1');
  });

  it('shows sync status on /sync status', async () => {
    const { handler, notices } = buildHandler({ docSyncConfigured: true });
    await handler.handle(msg('/sync status'));
    expect(notices[0].title).toContain('Sync Status');
    expect(notices[0].content).toContain('sp_abc123');
    expect(notices[0].content).toContain('13');
  });

  it('shows usage on unknown sync subcommand', async () => {
    const { handler, notices } = buildHandler({ docSyncConfigured: true });
    await handler.handle(msg('/sync unknownsubcmd'));
    expect(notices[0].content).toContain('/sync');
  });
});

// =====================================================================
// Edge cases
// =====================================================================

describe('CommandHandler edge cases', () => {
  it('returns false for non-slash messages (plain text)', async () => {
    const { handler } = buildHandler({});
    expect(await handler.handle(msg('hello world'))).toBe(false);
  });

  it('returns false for unknown /xxx commands (passes through to agent)', async () => {
    const { handler } = buildHandler({});
    expect(await handler.handle(msg('/someunknowncommand'))).toBe(false);
  });

  it('returns false for unrecognized commands with arguments', async () => {
    const { handler } = buildHandler({});
    expect(await handler.handle(msg('/goal set my objective'))).toBe(false);
  });

  it('returns false for empty string text', async () => {
    const { handler } = buildHandler({});
    expect(await handler.handle(msg(''))).toBe(false);
  });

  it('case-insensitive: /HELP is handled', async () => {
    const { handler, notices } = buildHandler({});
    const handled = await handler.handle(msg('/HELP'));
    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('case-insensitive: /STATUS is handled', async () => {
    const { handler, notices } = buildHandler({});
    const handled = await handler.handle(msg('/STATUS'));
    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Status');
  });

  it('case-insensitive: /STOP is handled', async () => {
    const { handler, notices } = buildHandler({});
    const handled = await handler.handle(msg('/STOP'));
    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('handles unicode in text (non-slash unicode message returns false)', async () => {
    const { handler } = buildHandler({});
    expect(await handler.handle(msg('你好世界 🌏'))).toBe(false);
  });

  it('handles very long input (1000+ chars) without crashing', async () => {
    const { handler } = buildHandler({});
    const longText = 'a'.repeat(2000);
    const handled = await handler.handle(msg(longText));
    expect(handled).toBe(false);
  });

  it('handles very long /model argument gracefully', async () => {
    const { handler, notices } = buildHandler({});
    const longModelName = 'model-' + 'x'.repeat(300);
    const handled = await handler.handle(msg(`/model ${longModelName}`));
    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('returns false for a message that is just a slash with no command', async () => {
    // "/" alone starts with "/" but does not match any switch case → returns false
    const { handler } = buildHandler({});
    // "/" -> cmd = "/" -> switch default -> false
    expect(await handler.handle(msg('/'))).toBe(false);
  });

  it('handles unicode in /model name gracefully', async () => {
    const { handler, notices } = buildHandler({});
    const handled = await handler.handle(msg('/model 模型名称'));
    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('does not confuse /resetmore or similar prefix-matching', async () => {
    // "/resetmore" is not "/reset" — switch is on cmd.toLowerCase() which equals "/resetmore"
    const { handler } = buildHandler({});
    expect(await handler.handle(msg('/resetmore'))).toBe(false);
  });
});
