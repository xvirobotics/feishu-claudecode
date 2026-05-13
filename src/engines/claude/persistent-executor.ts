/**
 * SPIKE / EXPERIMENTAL — DO NOT USE IN PRODUCTION YET.
 *
 * PersistentClaudeExecutor — keeps a single Claude Code SDK `query()` call
 * alive across many user "turns", so that:
 *   - Agent Teams teammates survive between user messages
 *   - /goal multi-turn auto-drive can fire its Stop hook and start the next turn
 *   - /background tasks and agentProgressSummaries actually work
 *   - Subagent processes don't die when one user turn ends
 *
 * Lifecycle:
 *   start() → ready
 *      ↓ nextTurn(prompt) ↑   (caller iterates yielded messages until result)
 *      ↓ nextTurn(prompt) ↑
 *      ↓ ...
 *   shutdown() → finish()ed → process exits
 *
 * Key difference from {@link ClaudeExecutor.startExecution}: the input queue
 * is NEVER finished by individual turns — only by `shutdown()`. The single
 * `query()` invocation stays alive across all turns.
 *
 * This is a spike — it is intentionally narrow. No registry, no eviction,
 * no crash recovery, no spontaneous-card routing. Those come after we
 * verify the core SDK behavior works.
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { SDKMessage } from './executor.js';

const isWindows = process.platform === 'win32';

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

const ALWAYS_FILTERED_PREFIXES = ['CLAUDE'];
const CLAUDE_ENV_PASSTHROUGH = new Set([
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_DISABLE_AGENT_VIEW',
  'CLAUDE_CODE_SIMPLE',
]);
const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

function hasCredentialsFile(): boolean {
  try {
    return fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
  } catch {
    return false;
  }
}

function createSpawnFn(explicitApiKey?: string): (options: SpawnOptions) => SpawnedProcess {
  const filterAuthVars = !!(explicitApiKey || hasCredentialsFile());
  return (options: SpawnOptions): SpawnedProcess => {
    const baseEnv = options.env && Object.keys(options.env).length > 0
      ? { ...process.env, ...options.env }
      : { ...process.env };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      if (CLAUDE_ENV_PASSTHROUGH.has(key)) { env[key] = value; continue; }
      if (ALWAYS_FILTERED_PREFIXES.some(p => key.startsWith(p))) continue;
      if (filterAuthVars && AUTH_ENV_VARS.some(v => key.startsWith(v))) continue;
      env[key] = value;
    }
    if (explicitApiKey) env.ANTHROPIC_API_KEY = explicitApiKey;
    if (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === undefined) {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child as unknown as SpawnedProcess;
  };
}

export interface PersistentExecutorOptions {
  cwd: string;
  /** Optional sessionId to resume. If omitted, a fresh session is created. */
  resumeSessionId?: string;
  /** Optional explicit API key, otherwise OAuth credentials file is used. */
  apiKey?: string;
  model?: string;
  logger: Logger;
}

export type ExecutorState = 'starting' | 'ready' | 'shutting_down' | 'closed' | 'crashed';

/**
 * A single user "turn" — yields all SDK messages that arrive after the
 * accompanying user prompt is enqueued, up to and including the next
 * `result` message. After result, the iterator completes.
 *
 * Multiple TurnHandles for the same executor are NOT yet supported in the
 * spike (one turn at a time). Production version will support overlap.
 */
export interface TurnHandle {
  /** Async iterable yielding SDK messages for this turn only. */
  stream: AsyncIterable<SDKMessage>;
  /** Detach the subscription early without finishing the underlying executor. */
  detach(): void;
}

export class PersistentClaudeExecutor extends EventEmitter {
  private state: ExecutorState = 'starting';
  private inputQueue: AsyncQueue<SDKUserMessage>;
  private rawStream?: AsyncGenerator<SDKMessage>;
  /** Latest sessionId observed in the stream — bumps as Claude assigns / renames it. */
  private sessionId?: string;
  /** The single active turn subscription (spike: one at a time). */
  private activeTurn: {
    queue: AsyncQueue<SDKMessage>;
    detached: boolean;
  } | null = null;
  /** Collects messages that arrive when no turn is active (spontaneous / between-turns). */
  private spontaneousBuffer: SDKMessage[] = [];

  constructor(private options: PersistentExecutorOptions) {
    super();
    this.inputQueue = new AsyncQueue<SDKUserMessage>();
  }

  /**
   * Start the underlying Claude process. The query() call lives here for the
   * lifetime of this executor. Returns once state transitions to 'ready'
   * (which we approximate as: first message of any kind has been seen, or
   * a short bootstrap timeout elapses).
   */
  async start(): Promise<void> {
    this.options.logger.info({ cwd: this.options.cwd, resume: this.options.resumeSessionId }, 'PersistentExecutor.start');

    const isRoot = process.getuid?.() === 0;
    const queryOptions: Record<string, unknown> = {
      permissionMode: isRoot ? 'auto' : ('bypassPermissions' as const),
      ...(isRoot ? {} : { allowDangerouslySkipPermissions: true }),
      cwd: this.options.cwd,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      spawnClaudeCodeProcess: createSpawnFn(this.options.apiKey),
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      settings: { teammateMode: 'in-process' },
      agentProgressSummaries: true,
    };
    if (this.options.model) queryOptions.model = this.options.model;
    if (this.options.resumeSessionId) queryOptions.resume = this.options.resumeSessionId;

    const stream = query({
      prompt: this.inputQueue,
      options: queryOptions as any,
    });
    this.rawStream = stream as unknown as AsyncGenerator<SDKMessage>;

    // Drive the consumer loop in the background. It never returns until
    // the inputQueue is finished or the stream ends/throws.
    void this.consumeLoop();

    // No bootstrap turn — caller drives via nextTurn(). Mark ready immediately.
    this.state = 'ready';
    this.emit('ready');
  }

  /**
   * Background consumer of the SDK stream. Routes each message to either:
   *   - the active turn subscription (if one exists and not detached), OR
   *   - the spontaneousBuffer + 'spontaneous' event for between-turn events.
   */
  private async consumeLoop(): Promise<void> {
    if (!this.rawStream) return;
    try {
      for await (const msg of this.rawStream) {
        const m = msg as SDKMessage;
        if (m.session_id) this.sessionId = m.session_id;

        const turn = this.activeTurn;
        if (turn && !turn.detached) {
          turn.queue.enqueue(m);
          // End of turn: result message → close the subscription queue.
          if (m.type === 'result') {
            turn.queue.finish();
            this.activeTurn = null;
          }
        } else {
          this.spontaneousBuffer.push(m);
          this.emit('spontaneous', m);
        }
      }
      this.options.logger.info('PersistentExecutor: stream ended');
      this.state = 'closed';
    } catch (err: any) {
      this.options.logger.error({ err }, 'PersistentExecutor: stream errored');
      this.state = 'crashed';
      this.emit('crashed', err);
    } finally {
      // Resolve any leftover turn so callers don't hang
      if (this.activeTurn) {
        this.activeTurn.queue.finish();
        this.activeTurn = null;
      }
    }
  }

  /**
   * Start a new user turn. Enqueues the prompt and returns a TurnHandle
   * whose `stream` yields only messages belonging to this turn (up to and
   * including the next `result` message).
   *
   * Spike constraint: only one turn may be active at a time. Calling while
   * another turn is in flight throws.
   */
  nextTurn(prompt: string): TurnHandle {
    if (this.state !== 'ready') {
      throw new Error(`PersistentExecutor not ready (state=${this.state})`);
    }
    if (this.activeTurn) {
      throw new Error('PersistentExecutor: a turn is already in flight (spike does not yet support overlap)');
    }

    const queue = new AsyncQueue<SDKMessage>();
    this.activeTurn = { queue, detached: false };

    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    };
    this.inputQueue.enqueue(userMsg);

    const stream: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
    return {
      stream,
      detach: () => {
        if (this.activeTurn?.queue === queue) {
          this.activeTurn.detached = true;
          queue.finish();
        }
      },
    };
  }

  /** Drain spontaneous messages that arrived between turns. */
  drainSpontaneous(): SDKMessage[] {
    const out = this.spontaneousBuffer;
    this.spontaneousBuffer = [];
    return out;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getState(): ExecutorState {
    return this.state;
  }

  /**
   * Gracefully shut down: finish the input queue, which makes the underlying
   * Claude process exit cleanly. After this, no further turns can be started.
   */
  async shutdown(): Promise<void> {
    if (this.state === 'closed' || this.state === 'shutting_down') return;
    this.options.logger.info('PersistentExecutor.shutdown');
    this.state = 'shutting_down';
    this.inputQueue.finish();
    // Wait briefly for the consumer loop to wind down
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      const onClose = () => { clearTimeout(t); resolve(); };
      this.once('closed' as any, onClose);
      // Also resolve on crashed
      this.once('crashed' as any, onClose);
    });
    this.state = 'closed';
  }
}
