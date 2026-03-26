import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { AsyncQueue } from '../utils/async-queue.js';

const isWindows = process.platform === 'win32';

/** Resolve the Claude Code binary path at module load time. */
function resolveClaudePath(): string {
  if (process.env.CLAUDE_EXECUTABLE_PATH) return process.env.CLAUDE_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where claude' : 'which claude';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return isWindows ? 'claude' : '/usr/local/bin/claude';
  }
}

const CLAUDE_EXECUTABLE = resolveClaudePath();

/**
 * Custom spawn function for cross-platform compatibility.
 * - Uses process.execPath (current Node binary) to avoid PATH issues on Windows.
 * - Filters CLAUDE* env vars to prevent "nested session" errors.
 * - Merges process.env so child inherits system PATH, TEMP, etc.
 */
function customSpawn(options: SpawnOptions): SpawnedProcess {
  const nodePath = process.execPath;

  // Merge provided env with process.env for a complete environment
  const baseEnv = options.env && Object.keys(options.env).length > 0
    ? { ...process.env, ...options.env }
    : { ...process.env };

  // Filter out CLAUDE* vars to avoid nested session detection
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!key.startsWith('CLAUDE') && value !== undefined) {
      env[key] = value;
    }
  }

  const child = spawn(nodePath, options.args, {
    cwd: options.cwd,
    env,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return child as unknown as SpawnedProcess;
}

export interface ApiContext {
  botName: string;
  chatId: string;
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
  // Model usage from result message (per-model breakdown)
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number; costUSD: number }>;
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
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd,
      abortController,
      includePartialMessages: true,
      // Load MCP servers and settings from user/project config files
      settingSources: ['user', 'project'],
      // Cross-platform spawn: custom spawn filters CLAUDE* env vars and uses
      // process.execPath to avoid PATH issues on Windows; fileURLToPath converts
      // file:// URLs to native paths for the SDK CLI entrypoint.
      spawnClaudeCodeProcess: customSpawn,
      executableArgs: [fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk/cli.js'))],
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    };

    // Build system prompt appendix from sections
    const appendSections: string[] = [];

    if (outputsDir) {
      appendSections.push(`## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nUse \`cp\` via the Bash tool. The bridge will automatically send files placed there to the user.`);
    }

    if (apiContext) {
      // botName and chatId are per-session — inject into system prompt to avoid
      // race conditions when multiple chats run concurrently.
      // Port and secret are already set as METABOT_* env vars in config.ts.
      appendSections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`
      );
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
      // Race each stream.next() against the abort signal so we exit immediately on /stop
      const abortPromise = new Promise<never>((_, reject) => {
        if (abortController.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        abortController.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });

      const iterator = stream[Symbol.asyncIterator]();

      try {
        while (true) {
          const result = await Promise.race([
            iterator.next(),
            abortPromise,
          ]);
          if (result.done) break;
          yield result.value as SDKMessage;
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || abortController.signal.aborted) {
          logger.info('Claude execution aborted');
          // Clean up the underlying iterator (non-blocking)
          try { iterator.return?.(undefined); } catch { /* ignore */ }
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

    const abortPromise = new Promise<never>((_, reject) => {
      if (abortController.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      abortController.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

    const iterator = stream[Symbol.asyncIterator]();

    try {
      while (true) {
        const result = await Promise.race([
          iterator.next(),
          abortPromise,
        ]);
        if (result.done) break;
        yield result.value as SDKMessage;
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        this.logger.info('Claude execution aborted');
        try { iterator.return?.(undefined); } catch { /* ignore */ }
        return;
      }
      throw err;
    }
  }
}
