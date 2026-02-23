import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { AsyncQueue } from '../utils/async-queue.js';

export interface ApiContext {
  port: number;
  botName: string;
  chatId: string;
  secret?: string;
}

export interface ExecutorOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  abortController: AbortController;
  outputsDir?: string;
  apiContext?: ApiContext;
}

export type SDKMessage = {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
    }>;
  };
  // Result fields
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  errors?: string[];
  // Stream event fields
  event?: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
    };
    content_block?: {
      type: string;
      text?: string;
      name?: string;
      id?: string;
    };
  };
  parent_tool_use_id?: string | null;
};

export interface ExecutionHandle {
  stream: AsyncGenerator<SDKMessage>;
  sendAnswer(toolUseId: string, sessionId: string, answerText: string): void;
  finish(): void;
}

export class ClaudeExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  private buildQueryOptions(cwd: string, sessionId: string | undefined, abortController: AbortController, outputsDir?: string, apiContext?: ApiContext): Record<string, unknown> {
    const queryOptions: Record<string, unknown> = {
      allowedTools: this.config.claude.allowedTools,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd,
      abortController,
      includePartialMessages: true,
      // Load MCP servers and settings from user/project config files
      settingSources: ['user', 'project'],
      // Use native claude binary directly to avoid "spawn node EACCES" when
      // node is not in PATH (e.g. nvm not initialised in non-interactive shells)
      pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE_PATH || '/usr/local/bin/claude',
    };

    // Build system prompt appendix from sections
    const appendSections: string[] = [];

    if (outputsDir) {
      appendSections.push(`## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nUse \`cp\` via the Bash tool. The bridge will automatically send files placed there to the user.`);
    }

    if (apiContext) {
      const authHeader = apiContext.secret
        ? `  -H 'Authorization: Bearer ${apiContext.secret}' \\\n`
        : '';
      const authNote = apiContext.secret
        ? `\nAll requests require: Authorization: Bearer <secret>`
        : '';

      appendSections.push([
        `## MetaBot API`,
        `You are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".`,
        `Available at http://localhost:${apiContext.port}${authNote}`,
        ``,
        `POST /api/tasks — delegate a task to another bot (synchronous, returns result)`,
        `  Body: {"botName":"<name>","chatId":"<chatId>","prompt":"<prompt>","sendCards":false}`,
        `POST /api/schedule — schedule a future task`,
        `  Body: {"botName":"<name>","chatId":"<chatId>","prompt":"<prompt>","delaySeconds":<n>,"label":"<optional>"}`,
        `GET /api/schedule — list pending scheduled tasks`,
        `PATCH /api/schedule/<id> — update a pending task (prompt, delaySeconds, label, sendCards)`,
        `DELETE /api/schedule/<id> — cancel a scheduled task`,
        `GET /api/bots — discover available bots`,
        `GET /api/health — service health check`,
        ``,
        `### Bot Management (Self-Replication)`,
        `POST /api/bots — create a new bot (auto-activates via PM2 restart)`,
        `  Feishu: {"platform":"feishu","name":"<name>","feishuAppId":"...","feishuAppSecret":"...","defaultWorkingDirectory":"/path","installSkills":true}`,
        `  Telegram: {"platform":"telegram","name":"<name>","telegramBotToken":"...","defaultWorkingDirectory":"/path","installSkills":true}`,
        `GET /api/bots/<name> — get bot details`,
        `DELETE /api/bots/<name> — remove a bot`,
        ``,
        `When asked to create a bot:`,
        `1. Ask user for platform + credentials + project name + working directory`,
        `2. POST /api/bots with installSkills:true`,
        `3. Report success — new bot activates within ~3 seconds via PM2 file-watch`,
        ``,
        `### Self-Scheduling Example`,
        `\`\`\`bash`,
        `curl -s -X POST http://localhost:${apiContext.port}/api/schedule \\`,
        `${authHeader}  -H 'Content-Type: application/json' \\`,
        `  -d '{"botName":"${apiContext.botName}","chatId":"${apiContext.chatId}","prompt":"check on experiment results","delaySeconds":3600}'`,
        `\`\`\``,
      ].join('\n'));
    }

    if (appendSections.length > 0) {
      queryOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: '\n\n' + appendSections.join('\n\n'),
      };
    }

    if (this.config.claude.maxTurns !== undefined) {
      queryOptions.maxTurns = this.config.claude.maxTurns;
    }

    if (this.config.claude.maxBudgetUsd !== undefined) {
      queryOptions.maxBudgetUsd = this.config.claude.maxBudgetUsd;
    }

    if (this.config.claude.model) {
      queryOptions.model = this.config.claude.model;
    }

    if (sessionId) {
      queryOptions.resume = sessionId;
    }

    return queryOptions;
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;

    this.logger.info({ cwd, hasSession: !!sessionId, outputsDir }, 'Starting Claude execution (multi-turn)');

    const inputQueue = new AsyncQueue<SDKUserMessage>();

    // Push the initial user message
    const initialMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user' as const,
        content: prompt,
      },
      parent_tool_use_id: null,
      session_id: sessionId || '',
    };
    inputQueue.enqueue(initialMessage);

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController, outputsDir, apiContext);

    const stream = query({
      prompt: inputQueue,
      options: queryOptions as any,
    });

    const logger = this.logger;

    async function* wrapStream(): AsyncGenerator<SDKMessage> {
      try {
        for await (const message of stream) {
          yield message as SDKMessage;
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || abortController.signal.aborted) {
          logger.info('Claude execution aborted');
          return;
        }
        throw err;
      }
    }

    return {
      stream: wrapStream(),
      sendAnswer: (toolUseId: string, sid: string, answerText: string) => {
        logger.info({ toolUseId }, 'Sending answer to Claude');
        const answerMessage: SDKUserMessage = {
          type: 'user',
          message: {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: answerText,
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: sid,
        };
        inputQueue.enqueue(answerMessage);
      },
      finish: () => {
        inputQueue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const { prompt, cwd, sessionId, abortController, outputsDir } = options;

    this.logger.info({ cwd, hasSession: !!sessionId }, 'Starting Claude execution');

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController, outputsDir);

    const stream = query({
      prompt,
      options: queryOptions as any,
    });

    try {
      for await (const message of stream) {
        yield message as SDKMessage;
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        this.logger.info('Claude execution aborted');
        return;
      }
      throw err;
    }
  }
}
