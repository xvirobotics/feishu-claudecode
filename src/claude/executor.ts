import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';

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

export class ClaudeExecutor {
  constructor(
    private config: Config,
    private logger: Logger,
  ) {}

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const { prompt, cwd, sessionId, abortController } = options;

    this.logger.info({ cwd, hasSession: !!sessionId }, 'Starting Claude execution');

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
    };

    if (this.config.claude.model) {
      queryOptions.model = this.config.claude.model;
    }

    if (sessionId) {
      queryOptions.resume = sessionId;
    }

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
