import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import { resolveEngineName, SessionManager } from '../engines/index.js';
import type { EngineName } from '../engines/index.js';
import { MemoryClient } from '../memory/memory-client.js';
import { AuditLogger } from '../utils/audit-logger.js';
import type { DocSync } from '../sync/doc-sync.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';

const MAX_DEFER_MINUTES = 7 * 24 * 60; // 7 days — beyond this use `mb schedule cron`

export class CommandHandler {
  private docSync: DocSync | null = null;
  private scheduler: TaskScheduler | null = null;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    private sender: IMessageSender,
    private sessionManager: SessionManager,
    private memoryClient: MemoryClient,
    private audit: AuditLogger,
    private getRunningTask: (chatId: string) => { startTime: number } | undefined,
    private stopTask: (chatId: string) => void,
    /**
     * Drain the chat's queued-message buffer, returning the number of
     * messages discarded. Called from /stop so the user's "stop" intent
     * isn't immediately undone by the next queued message — without this
     * the bridge's processQueue would start the next one as soon as the
     * aborted task's finally block runs.
     */
    private clearQueue: (chatId: string) => number,
    /**
     * Release the persistent Claude process associated with this chat
     * (no-op if the persistent-executor feature flag is off or no
     * executor exists). Called on /reset so teammates and /goal state
     * tied to the old session are torn down with the conversation.
     */
    private releaseExecutor: (chatId: string, reason: string) => Promise<void>,
  ) {}

  /** Set the doc sync service (optional, only available for Feishu bots). */
  setDocSync(docSync: DocSync): void {
    this.docSync = docSync;
  }

  /** Inject the task scheduler used by `/<N>` and `/0` (cancel). Until this
   *  is called, those commands report a clear "scheduler unavailable" notice
   *  instead of crashing — keeps unit tests and bots without a registered
   *  scheduler working. */
  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler;
  }

  /** Returns true if the message was handled as a command, false otherwise. */
  async handle(msg: IncomingMessage): Promise<boolean> {
    const { text } = msg;
    if (!text.startsWith('/')) return false;

    const { userId, chatId } = msg;
    const [cmd] = text.split(/\s+/);

    // Defer-send lives entirely in the numeric `/<digits>` namespace so it
    // can never collide with a word command:
    //   `/<N> <message>` — queue the message to run N minutes from now.
    //   `/0`             — cancel the chat's pending deferred message.
    // Per-chat single-slot — a second `/<N>` while one is pending is
    // rejected with the existing entry's details (use `/0` to drop it).
    // Match the WHOLE command token to avoid colliding with other commands
    // that happen to start with a digit later (currently none).
    const deferMatch = cmd.match(/^\/(\d+)$/);
    if (deferMatch) {
      this.audit.log({ event: 'command', botName: this.config.name, chatId, userId, prompt: cmd });
      const minutes = Number(deferMatch[1]);
      if (minutes === 0) {
        await this.handleCancelDeferred(chatId);
        return true;
      }
      const prompt = text.slice(cmd.length).trim();
      await this.handleDeferredSend(chatId, userId, minutes, prompt);
      return true;
    }

    this.audit.log({ event: 'command', botName: this.config.name, chatId, userId, prompt: cmd });

    switch (cmd.toLowerCase()) {
      case '/help':
        await this.sender.sendTextNotice(chatId, '📖 Help', [
          '**Bot Commands:**',
          '`/reset` - Clear session, start fresh',
          '`/stop` - Abort current running task',
          '`/status` - Show current session info',
          '`/model` - Show current engine/model; `/model list` - Available options',
          '`/model claude`, `/model kimi`, or `/model codex` - Switch engine (resets session)',
          '`/model <name>` - Set model for current engine',
          '`/memory` - Memory document commands',
          '`/help` - Show this help message',
          '',
          '**Deferred Send** (one slot per chat — execute, then queue the next):',
          '`/<N> <message>` - Queue `<message>` to run **N minutes** from now (e.g. `/60 写个总结`)',
          '`/0` - Cancel the pending deferred message (no ID needed — only one slot)',
          '',
          '**Agent Commands** (pass through to the agent — Claude only):',
          '`/goal <description>` - Set a goal the agent keeps pursuing across turns',
          '`/background <prompt>` - Run a task in the background while you continue chatting',
          '',
          '**Usage:**',
          'Send any text message to start a conversation with the configured agent engine.',
          'Each chat has an independent session with a fixed working directory.',
          '',
          '**Memory Commands:**',
          '`/memory list` - Show folder tree',
          '`/memory search <query>` - Search documents',
          '`/memory status` - Server health check',
          '',
          '**Sync Commands:**',
          '`/sync` - Sync MetaMemory to Feishu Wiki',
          '`/sync status` - Show sync status',
        ].join('\n'));
        return true;

      case '/reset':
        this.sessionManager.resetSession(chatId);
        // Tear down the persistent Claude process for this chat (Stage 3b).
        // Otherwise the old long-lived executor would keep running with its
        // stale (now-cleared) sessionId mapping. No-op when persistent mode
        // is off. Best-effort — log but don't fail the /reset on shutdown errors.
        try {
          await this.releaseExecutor(chatId, 'reset-command');
        } catch (err) {
          this.logger.warn({ err, chatId }, 'Failed to release persistent executor on /reset');
        }
        await this.sender.sendTextNotice(chatId, '✅ Session Reset', 'Conversation cleared. Working directory preserved.', 'green');
        return true;

      case '/stop': {
        const task = this.getRunningTask(chatId);
        // Always drain the queue first — otherwise the running task's
        // finally block immediately picks the next queued message via
        // processQueue and the user's "stop" intent silently fails.
        const cleared = this.clearQueue(chatId);
        if (task) {
          this.audit.log({ event: 'task_stopped', botName: this.config.name, chatId, userId, durationMs: Date.now() - task.startTime, meta: { clearedQueue: cleared } });
          this.stopTask(chatId);
          const body = cleared > 0
            ? `Current task aborted. Discarded **${cleared}** queued message${cleared === 1 ? '' : 's'}.`
            : 'Current task has been aborted.';
          await this.sender.sendTextNotice(chatId, '🛑 Stopped', body, 'orange');
        } else if (cleared > 0) {
          // No running task but queued messages existed — clear them too.
          this.audit.log({ event: 'queue_cleared', botName: this.config.name, chatId, userId, meta: { clearedQueue: cleared } });
          await this.sender.sendTextNotice(
            chatId,
            '🛑 Queue Cleared',
            `No task was running. Discarded **${cleared}** queued message${cleared === 1 ? '' : 's'}.`,
            'orange',
          );
        } else {
          await this.sender.sendTextNotice(chatId, 'ℹ️ No Running Task', 'There is no task to stop.', 'blue');
        }
        return true;
      }

      case '/status': {
        const session = this.sessionManager.getSession(chatId);
        const isRunning = !!this.getRunningTask(chatId);
        const botEngine = resolveEngineName(this.config);
        const activeEngine = session.engine ?? botEngine;
        const defaultModel = this.defaultModelForEngine(activeEngine) || '_default_';
        const activeModel = session.model || defaultModel;
        const deferredLine = this.formatDeferredStatusLine(chatId);
        await this.sender.sendTextNotice(chatId, '📊 Status', [
          `**User:** \`${userId}\``,
          `**Engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
          `**Working Directory:** \`${session.workingDirectory}\``,
          `**Session:** ${session.sessionId ? `\`${session.sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Model:** \`${activeModel}\`${session.model ? ' (session override)' : ''}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
          `**Deferred:** ${deferredLine}`,
        ].join('\n'));
        return true;
      }

      case '/memory': {
        const args = text.slice('/memory'.length).trim();
        await this.handleMemoryCommand(chatId, args);
        return true;
      }

      case '/sync': {
        const args = text.slice('/sync'.length).trim();
        await this.handleSyncCommand(chatId, args);
        return true;
      }

      case '/model': {
        const args = text.slice('/model'.length).trim();
        await this.handleModelCommand(chatId, args);
        return true;
      }

      default:
        // Unrecognized /xxx commands — not handled here, pass through to Claude
        return false;
    }
  }

  private async handleMemoryCommand(chatId: string, args: string): Promise<void> {
    const [subCmd, ...rest] = args.split(/\s+/);

    if (!subCmd) {
      await this.sender.sendTextNotice(
        chatId,
        '📝 Memory',
        'Usage:\n- `/memory list` — Show folder tree\n- `/memory search <query>` — Search documents\n- `/memory status` — Health check',
      );
      return;
    }

    try {
      switch (subCmd.toLowerCase()) {
        case 'list': {
          const tree = await this.memoryClient.listFolderTree();
          const formatted = this.memoryClient.formatFolderTree(tree);
          await this.sender.sendTextNotice(chatId, '📂 Memory Folders', formatted);
          break;
        }
        case 'search': {
          const query = rest.join(' ').trim();
          if (!query) {
            await this.sender.sendTextNotice(chatId, '📝 Memory', 'Usage: `/memory search <query>`');
            return;
          }
          const results = await this.memoryClient.search(query);
          const formatted = this.memoryClient.formatSearchResults(results);
          await this.sender.sendTextNotice(chatId, `🔍 Search: ${query}`, formatted);
          break;
        }
        case 'status': {
          const health = await this.memoryClient.health();
          await this.sender.sendTextNotice(
            chatId,
            '📝 Memory Status',
            `Status: ${health.status}\nDocuments: ${health.document_count}\nFolders: ${health.folder_count}`,
            'green',
          );
          break;
        }
        default:
          await this.sender.sendTextNotice(chatId, '📝 Memory', `Unknown sub-command: \`${subCmd}\`\nUse \`/memory\` for help.`, 'orange');
      }
    } catch (err: any) {
      this.logger.error({ err, chatId }, 'Memory command error');
      await this.sender.sendTextNotice(chatId, '❌ Memory Error', `Failed to connect to memory server: ${err.message}`, 'red');
    }
  }

  private async handleSyncCommand(chatId: string, args: string): Promise<void> {
    if (!this.docSync) {
      await this.sender.sendTextNotice(chatId, '❌ Sync Unavailable', 'Wiki sync is not configured for this bot.', 'red');
      return;
    }

    const [subCmd] = args.split(/\s+/);

    if (!subCmd) {
      // Default: trigger full sync
      if (this.docSync.isSyncing()) {
        await this.sender.sendTextNotice(chatId, '⏳ Sync In Progress', 'A sync is already running. Please wait.', 'orange');
        return;
      }

      await this.sender.sendTextNotice(chatId, '🔄 Sync Started', 'Syncing MetaMemory documents to Feishu Wiki...', 'blue');

      try {
        const result = await this.docSync.syncAll();
        const lines = [
          `**Created:** ${result.created}`,
          `**Updated:** ${result.updated}`,
          `**Skipped:** ${result.skipped} (unchanged)`,
          `**Deleted:** ${result.deleted}`,
          `**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`,
        ];
        if (result.errors.length > 0) {
          lines.push('', `**Errors (${result.errors.length}):**`);
          for (const err of result.errors.slice(0, 5)) {
            lines.push(`- ${err}`);
          }
          if (result.errors.length > 5) {
            lines.push(`- ... and ${result.errors.length - 5} more`);
          }
        }
        const color = result.errors.length > 0 ? 'orange' : 'green';
        await this.sender.sendTextNotice(chatId, '✅ Sync Complete', lines.join('\n'), color);
      } catch (err: any) {
        this.logger.error({ err, chatId }, 'Sync command error');
        await this.sender.sendTextNotice(chatId, '❌ Sync Failed', err.message, 'red');
      }
      return;
    }

    switch (subCmd.toLowerCase()) {
      case 'status': {
        const stats = this.docSync.getStats();
        const spaceId = stats.wikiSpaceId || 'Not configured';
        await this.sender.sendTextNotice(chatId, '📊 Sync Status', [
          `**Wiki Space:** \`${spaceId}\``,
          `**Synced Documents:** ${stats.documentCount}`,
          `**Synced Folders:** ${stats.folderCount}`,
          `**Currently Syncing:** ${this.docSync.isSyncing() ? 'Yes' : 'No'}`,
        ].join('\n'));
        break;
      }
      default:
        await this.sender.sendTextNotice(chatId, '📝 Sync', 'Usage:\n- `/sync` — Sync all documents to Feishu Wiki\n- `/sync status` — Show sync status', 'blue');
    }
  }

  private async handleModelCommand(chatId: string, args: string): Promise<void> {
    const session = this.sessionManager.getSession(chatId);
    const botEngine = resolveEngineName(this.config);
    const activeEngine = session.engine ?? botEngine;
    const botDefault = this.defaultModelForEngine(activeEngine);

    // No args — show current model
    if (!args) {
      const active = session.model || botDefault || '_default_';
      const exampleModels = this.exampleModelsForEngine(activeEngine);
      const lines = [
        `**Engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
        `**Active:** \`${active}\`${session.model ? ' (session override)' : ''}`,
        `**Bot default:** \`${botDefault || '_unset_'}\``,
        '',
        'Usage:',
        '- `/model list` — Show available engines + models',
        '- `/model claude`, `/model kimi`, or `/model codex` — Switch engine (resets session)',
        `- \`/model <name>\` — Set session model (e.g. ${exampleModels})`,
        '- `/model reset` — Clear overrides, use bot defaults',
      ];
      await this.sender.sendTextNotice(chatId, '🤖 Model', lines.join('\n'));
      return;
    }

    const normalized = args.toLowerCase();

    // Engine switch — /model claude, /model kimi, or /model codex
    if (isEngineName(normalized)) {
      if (activeEngine === normalized) {
        await this.sender.sendTextNotice(
          chatId,
          'ℹ️ Already using ' + normalized,
          `This chat is already on the \`${normalized}\` engine.`,
          'blue',
        );
        return;
      }
      this.sessionManager.setSessionEngine(chatId, normalized);
      await this.sender.sendTextNotice(
        chatId,
        `✅ Engine switched to ${normalized}`,
        [
          `Next message will run on the **${normalized}** engine.`,
          '',
          '_Session ID and model override cleared — a fresh conversation starts on the next turn._',
          this.authTipForEngine(normalized),
        ].join('\n'),
        'green',
      );
      return;
    }

    // List available models
    if (normalized === 'list' || normalized === 'ls') {
      const active = session.model || botDefault;
      const claudeModels = [
        { id: 'claude-opus-4-7', label: 'Opus 4.7', note: 'Most capable · 200k context' },
        { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M)', note: '1M context window' },
        { id: 'claude-opus-4-6', label: 'Opus 4.6', note: '200k context' },
        { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)', note: '1M context window' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: 'Balanced · 200k context' },
        { id: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)', note: '1M context window' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest · 200k context' },
      ];
      const kimiModels = [
        { id: 'kimi-for-coding', label: 'Kimi for Coding', note: 'Subscription default · 256k context · thinking' },
        { id: 'kimi-k2', label: 'Kimi K2', note: 'Legacy coding model' },
      ];
      const codexModels = [
        { id: 'gpt-5.4-codex', label: 'GPT-5.4 Codex', note: 'Recommended Codex coding model' },
        { id: 'gpt-5.4', label: 'GPT-5.4', note: 'General flagship model' },
        { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', note: 'Legacy Codex coding model' },
      ];
      const models = activeEngine === 'kimi' ? kimiModels : activeEngine === 'codex' ? codexModels : claudeModels;
      const header = activeEngine === 'kimi'
        ? '**Available Kimi models:**'
        : activeEngine === 'codex'
          ? '**Common Codex models:**'
          : '**Available Claude models:**';
      const lines = [
        `**Current engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
        '',
        '**Engines:** `/model claude`, `/model kimi`, or `/model codex` to switch.',
        '',
        header,
        '',
      ];
      for (const m of models) {
        const marker = m.id === active ? ' ✅' : '';
        lines.push(`- \`${m.id}\` — ${m.label} · ${m.note}${marker}`);
      }
      lines.push('');
      if (activeEngine === 'claude') {
        lines.push('_Tip: append `[1m]` to a model name to enable the 1M context window. Only Opus 4.7/4.6 and Sonnet 4.6 support it._');
      } else if (activeEngine === 'codex') {
        lines.push('_Tip: leave unset to use the Codex CLI default from `~/.codex/config.toml`._');
      } else {
        lines.push('_Tip: leave unset to use the kimi-cli default (recommended for subscription users — the server picks the best available)._');
      }
      lines.push('Use `/model <name>` to set the model for the current engine.');
      await this.sender.sendTextNotice(chatId, '🤖 Available Models', lines.join('\n'));
      return;
    }

    // Reset — clear overrides (both engine AND model)
    if (normalized === 'reset' || normalized === 'clear' || normalized === 'default') {
      this.sessionManager.setSessionModel(chatId, undefined);
      this.sessionManager.setSessionEngine(chatId, undefined);
      const fallback = botDefault || '_default_';
      await this.sender.sendTextNotice(
        chatId,
        '✅ Overrides Cleared',
        `Session engine and model overrides cleared. Using bot defaults: engine \`${botEngine}\`, model \`${fallback}\`.`,
        'green',
      );
      return;
    }

    // Set the model (use only the first token, ignore trailing junk)
    const newModel = args.split(/\s+/)[0];
    this.sessionManager.setSessionModel(chatId, newModel, activeEngine);
    await this.sender.sendTextNotice(
      chatId,
      '✅ Model Set',
      `Session model set to \`${newModel}\` on engine \`${activeEngine}\`. It will take effect on the next message.`,
      'green',
    );
  }

  private defaultModelForEngine(engine: EngineName): string | undefined {
    switch (engine) {
      case 'claude':
        return this.config.claude.model;
      case 'kimi':
        return this.config.kimi?.model;
      case 'codex':
        return this.config.codex?.model || this.config.codex?.displayModel;
    }
  }

  private exampleModelsForEngine(engine: EngineName): string {
    switch (engine) {
      case 'claude':
        return '`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`';
      case 'kimi':
        return '`kimi-for-coding`, `kimi-k2`';
      case 'codex':
        return '`gpt-5.4-codex`, `gpt-5.4`, `gpt-5.2-codex`';
    }
  }

  /** Handle `/<N> <message>` — queue the message N minutes from now. */
  private async handleDeferredSend(
    chatId: string,
    _userId: string,
    minutes: number,
    prompt: string,
  ): Promise<void> {
    if (!this.scheduler) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ Defer Unavailable',
        'The scheduler is not wired up for this bot — `/defer` cannot be used here.',
        'red',
      );
      return;
    }

    if (!Number.isFinite(minutes) || minutes <= 0) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ Invalid Delay',
        'The delay (in minutes) must be a positive integer. Example: `/60 写个总结`.',
        'red',
      );
      return;
    }

    if (minutes > MAX_DEFER_MINUTES) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ Delay Too Long',
        `Maximum defer is **${MAX_DEFER_MINUTES} minutes** (7 days). For longer schedules use the recurring scheduler API.`,
        'red',
      );
      return;
    }

    if (!prompt) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ Missing Message',
        `Usage: \`/${minutes} <message>\` — the message to send ${minutes} minutes from now.`,
        'red',
      );
      return;
    }

    // Per-chat single-slot — refuse a second `/<N>` while one is pending.
    const existing = this.scheduler.getChatTask(this.config.name, chatId);
    if (existing) {
      const remaining = Math.max(0, Math.round((existing.executeAt - Date.now()) / 60_000));
      await this.sender.sendTextNotice(
        chatId,
        '⛔ Deferred Slot Taken',
        [
          `This chat already has a pending deferred message (one slot per chat).`,
          `**Fires in:** ~${remaining} min`,
          `**Message:** ${truncatePrompt(existing.prompt)}`,
          '',
          'Use `/0` to drop it, then queue a new one.',
        ].join('\n'),
        'orange',
      );
      return;
    }

    const task = this.scheduler.scheduleTask({
      botName: this.config.name,
      chatId,
      prompt,
      delaySeconds: minutes * 60,
      sendCards: true,
      label: 'slash-defer',
    });

    const fireAt = new Date(task.executeAt).toLocaleString('zh-CN', { hour12: false });
    await this.sender.sendTextNotice(
      chatId,
      '⏱ Deferred Queued',
      [
        `Will run in **${minutes} min** (≈ ${fireAt}).`,
        `**Message:** ${truncatePrompt(prompt)}`,
        '',
        'Use `/0` to drop it, or `/status` to inspect.',
      ].join('\n'),
      'green',
    );
  }

  /** Handle `/0` — drop the chat's pending deferred message. */
  private async handleCancelDeferred(chatId: string): Promise<void> {
    if (!this.scheduler) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ Defer Unavailable',
        'The scheduler is not wired up for this bot — nothing to cancel.',
        'red',
      );
      return;
    }

    const existing = this.scheduler.getChatTask(this.config.name, chatId);
    if (!existing) {
      // No-op fallback: `/0` with nothing queued is harmless — just a
      // gentle reminder, never an error.
      await this.sender.sendTextNotice(
        chatId,
        'ℹ️ Nothing to Cancel',
        'No deferred message is pending in this chat — nothing to do. Use `/<N> <message>` to queue one (e.g. `/60 写个总结`).',
        'blue',
      );
      return;
    }

    const ok = this.scheduler.cancelTask(existing.id);
    if (!ok) {
      // Race: the task fired between getChatTask() and cancelTask().
      await this.sender.sendTextNotice(
        chatId,
        'ℹ️ Already Fired',
        'The deferred message already started — nothing to cancel.',
        'blue',
      );
      return;
    }

    await this.sender.sendTextNotice(
      chatId,
      '🗑 Deferred Cancelled',
      `Dropped: ${truncatePrompt(existing.prompt)}`,
      'green',
    );
  }

  /** Build the `/status` "Deferred" line — minutes remaining + preview, or `_None_`. */
  private formatDeferredStatusLine(chatId: string): string {
    if (!this.scheduler) return '_n/a_';
    const task = this.scheduler.getChatTask(this.config.name, chatId);
    if (!task) return '_None_';
    const remaining = Math.max(0, Math.round((task.executeAt - Date.now()) / 60_000));
    return `~${remaining} min — ${truncatePrompt(task.prompt)}`;
  }

  private authTipForEngine(engine: EngineName): string {
    switch (engine) {
      case 'claude':
        return '_Make sure Claude Code is authenticated (`claude login`)._';
      case 'kimi':
        return '_Make sure `kimi login` has been completed on this host._';
      case 'codex':
        return '_Make sure Codex CLI is authenticated (`codex login`) or configured with an API key._';
    }
  }
}

function isEngineName(value: string): value is EngineName {
  return value === 'claude' || value === 'kimi' || value === 'codex';
}

/** Trim a queued prompt to a single-line preview suitable for status / notice cards. */
function truncatePrompt(prompt: string, max = 60): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
