import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import { resolveEngineName, SessionManager } from '../engines/index.js';
import type { EngineName } from '../engines/index.js';
import { MemoryClient } from '../memory/memory-client.js';
import { AuditLogger } from '../utils/audit-logger.js';
import type { DocSync } from '../sync/doc-sync.js';
import { composeScopeKey } from '../session/compose-key.js';

/**
 * Callback result from a successful session share.
 * `shareCode` is a human-readable code the source user can share
 * with the target user (alternative to auto-claim).
 */
export interface ShareSessionResult {
  shareCode: string;
  targetUserId: string;
  targetUserName: string;
}

export class CommandHandler {
  private docSync: DocSync | null = null;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    private sender: IMessageSender,
    private sessionManager: SessionManager,
    private memoryClient: MemoryClient,
    private audit: AuditLogger,
    private getRunningTask: (scopeKey: string) => { startTime: number } | undefined,
    private stopTask: (scopeKey: string) => void,
    /**
     * Drain the chat's queued-message buffer, returning the number of
     * messages discarded. Called from /stop so the user's "stop" intent
     * isn't immediately undone by the next queued message — without this
     * the bridge's processQueue would start the next one as soon as the
     * aborted task's finally block runs.
     */
    private clearQueue: (scopeKey: string) => number,
    /**
     * Release the persistent Claude process associated with this chat
     * (no-op if the persistent-executor feature flag is off or no
     * executor exists). Called on /reset so teammates and /goal state
     * tied to the old session are torn down with the conversation.
     */
    private releaseExecutor: (scopeKey: string, reason: string) => Promise<void>,
    /**
     * Create a pending session transfer from the current scope to a
     * target Feishu user. Returns share metadata so the handler can
     * confirm to the source user.
     */
    private shareSession: (sourceScopeKey: string, targetUserId: string, targetUserName: string) => ShareSessionResult,
    /**
     * Claim a pending session transfer by share code. Returns the
     * target scopeKey if successfully claimed, undefined otherwise.
     */
    private claimSession: (shareCode: string, targetScopeKey: string) => string | undefined,
  ) {}

  /** Set the doc sync service (optional, only available for Feishu bots). */
  setDocSync(docSync: DocSync): void {
    this.docSync = docSync;
  }

  /** Returns true if the message was handled as a command, false otherwise. */
  async handle(msg: IncomingMessage): Promise<boolean> {
    const { text } = msg;
    if (!text.startsWith('/')) return false;

    const { userId, chatId } = msg;
    const scopeKey = composeScopeKey(chatId, userId, this.config.perUserContext);
    const [cmd] = text.split(/\s+/);

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
          '`/share-session @user` - Share current session with another user',
          '`/claim <code>` - Claim a shared session by code',
          '`/memory` - Memory document commands',
          '`/help` - Show this help message',
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
        this.sessionManager.resetSession(scopeKey);
        // Tear down the persistent Claude process for this scope (Stage 3b).
        // Otherwise the old long-lived executor would keep running with its
        // stale (now-cleared) sessionId mapping. No-op when persistent mode
        // is off. Best-effort — log but don't fail the /reset on shutdown errors.
        try {
          await this.releaseExecutor(scopeKey, 'reset-command');
        } catch (err) {
          this.logger.warn({ err, scopeKey }, 'Failed to release persistent executor on /reset');
        }
        {
          let body = 'Conversation cleared. Working directory preserved.';
          if (this.config.perUserContext) {
            body += '\n_(your scope only — other members\' sessions are unaffected)_';
          }
          await this.sender.sendTextNotice(chatId, '✅ Session Reset', body, 'green');
        }
        return true;

      case '/stop': {
        const task = this.getRunningTask(scopeKey);
        // Always drain the queue first — otherwise the running task's
        // finally block immediately picks the next queued message via
        // processQueue and the user's "stop" intent silently fails.
        const cleared = this.clearQueue(scopeKey);
        if (task) {
          this.audit.log({ event: 'task_stopped', botName: this.config.name, chatId, userId, durationMs: Date.now() - task.startTime, meta: { clearedQueue: cleared } });
          this.stopTask(scopeKey);
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
        const session = this.sessionManager.getSession(scopeKey);
        const isRunning = !!this.getRunningTask(scopeKey);
        const botEngine = resolveEngineName(this.config);
        const activeEngine = session.engine ?? botEngine;
        const defaultModel = this.defaultModelForEngine(activeEngine) || '_default_';
        const activeModel = session.model || defaultModel;
        await this.sender.sendTextNotice(chatId, '📊 Status', [
          `**User:** \`${userId}\``,
          `**Engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
          `**Working Directory:** \`${session.workingDirectory}\``,
          `**Session:** ${session.sessionId ? `\`${session.sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Model:** \`${activeModel}\`${session.model ? ' (session override)' : ''}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
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
        await this.handleModelCommand(scopeKey, chatId, args);
        return true;
      }

      case '/share-session': {
        await this.handleShareSession(msg, scopeKey, chatId);
        return true;
      }

      case '/claim': {
        await this.handleClaim(msg, scopeKey, chatId);
        return true;
      }

      default:
        // Unrecognized /xxx commands — not handled here, pass through to Claude
        return false;
    }
  }

  /**
   * /share-session @用户B
   *
   * Creates a pending transfer from the current user's session to the
   * mentioned target user. The target user can either:
   *   a) Send ANY message to the bot — the session auto-links, or
   *   b) Use `/claim <code>` explicitly.
   *
   * Transfers expire after 30 minutes.
   */
  private async handleShareSession(
    msg: IncomingMessage,
    scopeKey: string,
    chatId: string,
  ): Promise<void> {
    const { mentions, userId, text } = msg;
    const rawArgs = text.slice('/share-session'.length).trim();

    // Collect target users from mentions (bot's own @ is already filtered by event-handler)
    const targets: Array<{ userId: string; name: string }> = [];

    if (mentions && mentions.length > 0) {
      for (const m of mentions) {
        const openId = m.id?.open_id;
        if (openId && openId !== userId) {
          targets.push({ userId: openId, name: m.name || openId });
        }
      }
    }

    // Fallback: parse open_id from raw text args (private chats, no @mentions)
    if (targets.length === 0 && rawArgs) {
      const match = rawArgs.match(/(ou_[a-z0-9]+)/i);
      if (match) {
        const openId = match[1];
        if (openId !== userId) {
          targets.push({ userId: openId, name: openId });
        }
      }
    }

    if (targets.length === 0) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ 缺少目标用户',
        [
          '请使用 `@用户名` 指定接收 session 的用户。',
          '',
          '**用法：**',
          '- 群聊：`/share-session @用户B @用户C ...`（支持多人）',
          '- 私聊：`/share-session ou_xxxxxxxxxxxx`',
        ].join('\n'),
        'red',
      );
      return;
    }

    // Check that the current user has an active session
    const session = this.sessionManager.getSession(scopeKey);
    if (!session.sessionId) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ 无活跃 Session',
        '当前对话还没有创建 session。请先发送一条消息开始对话，然后再分享。',
        'red',
      );
      return;
    }

    // Create transfers for all targets
    const results: ShareSessionResult[] = [];
    for (const t of targets) {
      results.push(this.shareSession(scopeKey, t.userId, t.name));
    }

    // Build success message
    const userList = results
      .map((r, i) => `**${r.targetUserName}** — 分享码 \`${r.shareCode}\``)
      .join('\n');

    await this.sender.sendTextNotice(
      chatId,
      `✅ Session 已分享 (${results.length} 人)`,
      [
        `已将当前 session 分享给以下用户：`,
        '',
        userList,
        '',
        '**接收方操作：**',
        '1. **自动领取** — 被分享的用户向本 Bot 发送任意消息即可自动接续',
        `2. **手动领取** — 使用 \`/claim <分享码>\` 明确接续`,
        '',
        `⏰ 此分享 **30 分钟** 内有效。`,
      ].join('\n'),
      'green',
    );
  }

  /**
   * /claim <shareCode>
   *
   * Explicitly claim a pending session transfer. The target user runs this
   * in their own chat with the bot. On success, their session is linked to
   * the source user's Claude sessionId.
   */
  private async handleClaim(
    msg: IncomingMessage,
    scopeKey: string,
    chatId: string,
  ): Promise<void> {
    const args = msg.text.slice('/claim'.length).trim();

    if (!args) {
      await this.sender.sendTextNotice(
        chatId,
        '📋 领取 Session',
        [
          '**用法：** `/claim <分享码>`',
          '',
          '输入发起方提供的 6 位分享码来接续对方分享的 session。',
          '',
          '**提示：** 如果你是被分享的目标用户，直接发送任意消息即可自动接续，无需手动输入分享码。',
        ].join('\n'),
        'blue',
      );
      return;
    }

    const shareCode = args.split(/\s+/)[0].toUpperCase();
    const claimedScopeKey = this.claimSession(shareCode, scopeKey);

    if (!claimedScopeKey) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ 领取失败',
        [
          `分享码 \`${shareCode}\` 无效或已过期。`,
          '',
          '可能的原因：',
          '- 分享码输入错误（注意：6 位字母+数字）',
          '- 分享已过期（超过 30 分钟）',
          '- 该分享已被其他人领取',
          '- 你不在该分享的目标用户列表中',
        ].join('\n'),
        'red',
      );
      return;
    }

    await this.sender.sendTextNotice(
      chatId,
      '✅ Session 已接续',
      [
        '已成功接续分享的 session！',
        '',
        '现在你可以继续之前的对话了。发送任意消息即可开始。',
      ].join('\n'),
      'green',
    );
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

  private async handleModelCommand(scopeKey: string, chatId: string, args: string): Promise<void> {
    const session = this.sessionManager.getSession(scopeKey);
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
      this.sessionManager.setSessionEngine(scopeKey, normalized);
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
      this.sessionManager.setSessionModel(scopeKey, undefined);
      this.sessionManager.setSessionEngine(scopeKey, undefined);
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
    this.sessionManager.setSessionModel(scopeKey, newModel, activeEngine);
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
