import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { AsyncQueue } from '../utils/async-queue.js';

export interface ExecutorOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  abortController: AbortController;
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
    private config: Config,
    private logger: Logger,
  ) {}

  private buildQueryOptions(cwd: string, sessionId: string | undefined, abortController: AbortController): Record<string, unknown> {
    const queryOptions: Record<string, unknown> = {
      allowedTools: this.config.claude.allowedTools,
      maxTurns: this.config.claude.maxTurns,
      maxBudgetUsd: this.config.claude.maxBudgetUsd,
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

    if (this.config.claude.model) {
      queryOptions.model = this.config.claude.model;
    }

    if (sessionId) {
      queryOptions.resume = sessionId;
    }

    return queryOptions;
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController } = options;

    this.logger.info({ cwd, hasSession: !!sessionId }, 'Starting Claude execution (multi-turn)');

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

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController);

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
    const { prompt, cwd, sessionId, abortController } = options;

    this.logger.info({ cwd, hasSession: !!sessionId }, 'Starting Claude execution');

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController);

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
