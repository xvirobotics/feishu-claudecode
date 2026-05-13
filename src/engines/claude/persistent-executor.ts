/**
 * EXPERIMENTAL — Stage 1 (production hardening).
 *
 * PersistentClaudeExecutor — keeps a single Claude Code SDK `query()` call
 * alive across many user "turns", so that:
 *   - Agent Teams teammates survive between user messages
 *   - /goal multi-turn auto-drive can fire its Stop hook and start the next turn
 *   - /background tasks and agentProgressSummaries actually work
 *   - Subagent processes don't die when one user turn ends
 *
 * Stage 1 adds (over the spike):
 *   - Idle eviction (auto-shutdown after `idleTimeoutMs` of silence)
 *   - Crash recovery (auto-restart with `resume` on SDK stream error, capped)
 *   - Per-turn AbortController so callers can detach without killing the process
 *   - Wiring for Agent Teams hooks (TaskCreated/TaskCompleted/TeammateIdle)
 *     with logging — this is also our observability point for Bug #1
 *   - Spontaneous-message buffer cap (ring buffer) to prevent unbounded growth
 *   - Lifecycle event emissions for observability (state-changed,
 *     turn-started/completed/aborted, crashed, restarted, closed)
 *
 * Out of scope (Stage 2):
 *   - Registry / pool / LRU eviction
 *   - Bridge integration & feature flag
 *   - Spontaneous-card routing to Feishu
 *   - Multi-turn overlap (still one in-flight turn at a time)
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SpawnOptions, SpawnedProcess, Query } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { SDKMessage, TeamEvent, ApiContext } from './executor.js';

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

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_SPONTANEOUS_LIMIT = 1000;
/** Reset restart counter after this much continuous-uptime since last crash. */
const RESTART_COUNTER_RESET_MS = 5 * 60 * 1000;

export interface PersistentExecutorOptions {
  cwd: string;
  /** Optional sessionId to resume. If omitted, a fresh session is created. */
  resumeSessionId?: string;
  /** Optional explicit API key, otherwise OAuth credentials file is used. */
  apiKey?: string;
  model?: string;
  logger: Logger;
  /**
   * MetaBot bot/chat context. Stable for the lifetime of the executor
   * (the executor is keyed by chatId in the registry). Baked into the
   * system prompt at start() so all turns see it.
   */
  apiContext?: ApiContext;
  /**
   * Per-chat outputs directory (stable across turns). Baked into the
   * system prompt at start() to tell the agent where to drop files.
   * The bridge scans this dir for new files at turn end.
   */
  outputsDir?: string;
  /** Auto-shutdown after this many ms of silence (no turn, no spontaneous msg). 0 disables. Default 30 min. */
  idleTimeoutMs?: number;
  /** Max consecutive restart attempts before giving up. Default 3. */
  maxRestartAttempts?: number;
  /** Spontaneous-message ring buffer cap. Older entries dropped. Default 1000. */
  spontaneousBufferLimit?: number;
  /** Called on every Agent Teams hook fire (TaskCreated/TaskCompleted/TeammateIdle). */
  onTeamEvent?: (event: TeamEvent) => void;
}

export type ExecutorState =
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'shutting_down'
  | 'closed'
  | 'crashed';

/**
 * A single user "turn" — yields all SDK messages that arrive after the
 * accompanying user prompt is enqueued, up to and including the next
 * `result` message. After result, the iterator completes.
 *
 * Stage-1 constraint: only one TurnHandle in flight per executor at a time.
 * The MessageBridge does its own queueing (see messageQueues), so the
 * executor doesn't need to.
 */
export interface TurnHandle {
  /** Stable id for logging / bridge correlation. */
  readonly turnId: string;
  /** Async iterable yielding SDK messages for this turn only. */
  readonly stream: AsyncIterable<SDKMessage>;
  /** Was this turn explicitly aborted by the caller? */
  isAborted(): boolean;
  /** Has the turn reached its natural result message? */
  isCompleted(): boolean;
  /**
   * Stop receiving messages for this turn AND interrupt the SDK so the
   * underlying LLM generation halts. Awaits until the SDK has fully drained
   * the turn (its terminal result message is observed and discarded), so
   * the caller can immediately call nextTurn() afterwards without polluting
   * the next turn with this turn's straggling messages.
   *
   * Teammates / subagents spawned during this turn keep running — the
   * persistent process stays alive. To kill the process entirely, call
   * PersistentClaudeExecutor.shutdown().
   */
  abort(): Promise<void>;

  // ── ExecutionHandle compatibility (so the bridge can use TurnHandle as a
  //    drop-in for the legacy ClaudeExecutor.ExecutionHandle). ────────────
  /** Inject a tool_result into the conversation (legacy fallback path). */
  sendAnswer(toolUseId: string, sessionId: string, answerText: string): void;
  /** Resolve a pending AskUserQuestion PreToolUse hook with answers. */
  resolveQuestion(toolUseId: string, answers: Record<string, string>): void;
  /**
   * Compatibility shim — called by the bridge to "end" a handle. Under the
   * persistent model this is a turn-level abort (NOT executor shutdown),
   * fired-and-forgotten so it stays synchronous like the legacy API.
   */
  finish(): void;
}

interface ActiveTurn {
  id: string;
  queue: AsyncQueue<SDKMessage>;
  /** Caller has stopped listening (queue finished); we still drain SDK output. */
  detached: boolean;
  /** SDK observed terminal result for this turn (cleanly OR after interrupt). */
  completed: boolean;
  /** abort() promise resolves when the SDK actually drains this turn's result. */
  drainPromise?: Promise<void>;
  drainResolve?: () => void;
}

export class PersistentClaudeExecutor extends EventEmitter {
  private state: ExecutorState = 'starting';
  private inputQueue: AsyncQueue<SDKUserMessage>;
  private rawStream?: AsyncGenerator<SDKMessage>;
  /** The Query handle from query() — exposes interrupt() for hard-aborts. */
  private queryHandle?: Query;
  private sessionId?: string;
  private activeTurn: ActiveTurn | null = null;
  /** AskUserQuestion PreToolUse hook resolvers, keyed by tool_use_id. */
  private pendingQuestionResolvers = new Map<string, (answers: Record<string, string>) => void>();
  /** Spontaneous-message ring buffer (between-turn events). */
  private spontaneousBuffer: SDKMessage[] = [];
  private idleTimerId?: ReturnType<typeof setTimeout>;
  private lastActivityAt = Date.now();
  private restartAttempts = 0;
  private lastRestartAt = 0;
  private turnCounter = 0;
  /** Resolved when consumeLoop exits (cleanly or due to crash). */
  private consumePromise?: Promise<void>;

  constructor(private options: PersistentExecutorOptions) {
    super();
    this.inputQueue = new AsyncQueue<SDKUserMessage>();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the underlying Claude process. The query() call lives here for the
   * lifetime of this executor. Returns immediately after kicking off the
   * background consumer loop — caller should drive turns via nextTurn().
   */
  async start(): Promise<void> {
    if (this.state !== 'starting' && this.state !== 'restarting') {
      throw new Error(`PersistentExecutor.start: invalid state ${this.state}`);
    }
    this.options.logger.info(
      { cwd: this.options.cwd, resume: this.options.resumeSessionId, attempt: this.restartAttempts },
      'PersistentExecutor.start',
    );
    // Fresh inputQueue for restart cases
    if (this.state === 'restarting') {
      this.inputQueue = new AsyncQueue<SDKUserMessage>();
    }

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
    // resume: prefer the most-recent observed sessionId; fall back to the
    // one supplied at construction. This way, a restart picks up the live
    // session even if the SDK forked sessionId mid-life.
    const resume = this.sessionId ?? this.options.resumeSessionId;
    if (resume) queryOptions.resume = resume;

    // System prompt: bake in MetaBot context + outputs dir + team namespace
    // guidance. Stable for the lifetime of this executor (this differs from
    // the legacy executor which rebuilds per turn).
    const appendSections: string[] = [];
    if (this.options.outputsDir) {
      appendSections.push(
        `## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${this.options.outputsDir}\nUse \`cp\` via the Bash tool. The bridge will automatically send files placed there to the user.`,
      );
    }
    if (this.options.apiContext) {
      const ctx = this.options.apiContext;
      appendSections.push(
        `## MetaBot API\nYou are running as bot "${ctx.botName}" in chat "${ctx.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`,
      );
      if (ctx.groupMembers && ctx.groupMembers.length > 0) {
        const others = ctx.groupMembers.filter((m) => m !== ctx.botName);
        if (ctx.groupId) {
          appendSections.push(
            `## Group Chat\nYou are in a group chat (group: ${ctx.groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`mb talk <botName> grouptalk-${ctx.groupId}-<botName> "message"\`\nExample: \`mb talk ${others[0]} grouptalk-${ctx.groupId}-${others[0]} "hello"\`\nIMPORTANT: Always use the grouptalk-${ctx.groupId}-<botName> chatId pattern when talking to other bots in this group.`,
          );
        } else {
          appendSections.push(
            `## Group Chat\nYou are in a group chat with these bots: ${others.join(', ')}.\nUse \`mb talk <botName> <chatId> "message"\` to communicate with other bots in the group.`,
          );
        }
      }
      const teamNs = `${ctx.botName}-${ctx.chatId.slice(0, 8)}`;
      appendSections.push(
        [
          '## Agent Teams (experimental)',
          `When the user asks you to create an agent team, ALWAYS prefix the team name with \`${teamNs}-\` to avoid collisions with other MetaBot chats sharing this machine. For example: \`${teamNs}-research\`, \`${teamNs}-refactor\`.`,
          'Display mode is forced to `in-process` (no tmux/iTerm2 in MetaBot). Teammates show up in the user\'s Feishu card via TeammateIdle / TaskCreated / TaskCompleted events — you don\'t need to walk the user through Shift+Down navigation.',
          'Clean up the team yourself when work is done so resources don\'t leak (`Clean up the team`).',
          '',
          '## Persistent Session',
          'You are running inside a LONG-LIVED Claude Code session: this same process serves all the user\'s turns in this chat. Teammates, /goal multi-turn loops, and background tasks survive across user messages — feel free to leave work running between user prompts. The session is only torn down on /reset or after 30 minutes of total silence.',
        ].join('\n'),
      );
    }
    if (appendSections.length > 0) {
      queryOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: '\n\n' + appendSections.join('\n\n'),
      };
    }
    // Beta flags (parity with legacy executor)
    queryOptions.betas = ['context-1m-2025-08-07'];

    // Hooks: AskUserQuestion (mirrored from legacy executor — required so
    // that questions can be answered by users via Feishu cards) + Agent
    // Teams observation hooks for the team panel.
    queryOptions.hooks = this.buildHooks();

    const stream = query({
      prompt: this.inputQueue,
      options: queryOptions as any,
    });
    this.queryHandle = stream;
    this.rawStream = stream as unknown as AsyncGenerator<SDKMessage>;

    this.consumePromise = this.consumeLoop();
    this.transition('ready');
    this.armIdleTimer();
  }

  /**
   * Gracefully shut down: finish the input queue, which makes the underlying
   * Claude process exit. After this, no further turns can be started.
   */
  async shutdown(reason: string = 'caller'): Promise<void> {
    if (this.state === 'closed' || this.state === 'shutting_down') return;
    this.options.logger.info({ reason }, 'PersistentExecutor.shutdown');
    this.transition('shutting_down');
    this.clearIdleTimer();
    this.inputQueue.finish();
    // Wait for consumer loop to wind down (bounded so we don't hang forever)
    try {
      await Promise.race([
        this.consumePromise ?? Promise.resolve(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 10_000)),
      ]);
    } catch (err) {
      this.options.logger.warn({ err }, 'PersistentExecutor: consume loop did not exit in 10s');
    }
    this.transition('closed');
  }

  // ── Turn API ──────────────────────────────────────────────────────────────

  /**
   * Start a new user turn. Enqueues the prompt and returns a TurnHandle
   * whose stream yields only messages belonging to this turn.
   */
  nextTurn(prompt: string): TurnHandle {
    if (this.state !== 'ready') {
      throw new Error(`PersistentExecutor.nextTurn: not ready (state=${this.state})`);
    }
    if (this.activeTurn) {
      throw new Error(
        `PersistentExecutor.nextTurn: turn ${this.activeTurn.id} is in flight; ` +
        `caller must wait or call abort() before starting another`,
      );
    }
    this.touchActivity();
    const turnId = `t${++this.turnCounter}-${Date.now().toString(36)}`;
    const queue = new AsyncQueue<SDKMessage>();
    const turn: ActiveTurn = { id: turnId, queue, detached: false, completed: false };
    this.activeTurn = turn;

    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    };
    this.inputQueue.enqueue(userMsg);
    this.options.logger.debug({ turnId, promptLen: prompt.length }, 'PersistentExecutor: turn started');
    this.emit('turn-started', turnId);

    const stream: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
    const abort = async (): Promise<void> => {
      if (turn.completed) return;
      if (this.activeTurn !== turn) return; // already cleared by completion / restart
      if (turn.detached) {
        // already aborting; just await the existing drainPromise
        if (turn.drainPromise) await turn.drainPromise;
        return;
      }
      turn.detached = true;
      turn.queue.finish();
      // Set up drain promise BEFORE interrupt(), so consumeLoop can resolve it
      turn.drainPromise = new Promise<void>((resolve) => { turn.drainResolve = resolve; });
      // Best-effort: ask the SDK to interrupt the LLM. If interrupt() is
      // unavailable / fails, we still drain naturally to the next result.
      try {
        if (this.queryHandle && typeof (this.queryHandle as any).interrupt === 'function') {
          await (this.queryHandle as any).interrupt();
        }
      } catch (err) {
        this.options.logger.warn({ err, turnId }, 'PersistentExecutor: interrupt() threw');
      }
      await turn.drainPromise;
      this.options.logger.debug({ turnId }, 'PersistentExecutor: turn aborted (drained)');
      this.emit('turn-aborted', turnId);
    };

    return {
      turnId,
      stream,
      isAborted: () => turn.detached,
      isCompleted: () => turn.completed,
      abort,
      // ExecutionHandle compatibility — lets the bridge use TurnHandle as a
      // drop-in for the legacy ClaudeExecutor.ExecutionHandle.
      sendAnswer: (toolUseId: string, _sessionId: string, answerText: string) => {
        this.sendAnswer(toolUseId, answerText);
      },
      resolveQuestion: (toolUseId: string, answers: Record<string, string>) => {
        this.resolveQuestion(toolUseId, answers);
      },
      finish: () => {
        // Turn-level finish in the persistent model = abort the current turn.
        // Fire-and-forget so it stays sync like the legacy API; the executor
        // (and any teammates spawned in this turn) keeps running.
        void abort();
      },
    };
  }

  /** Drain spontaneous messages that arrived between turns. */
  drainSpontaneous(): SDKMessage[] {
    const out = this.spontaneousBuffer;
    this.spontaneousBuffer = [];
    return out;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getSessionId(): string | undefined { return this.sessionId; }
  getState(): ExecutorState { return this.state; }
  hasActiveTurn(): boolean { return this.activeTurn !== null; }
  getLastActivityAt(): number { return this.lastActivityAt; }

  // ── Internals ─────────────────────────────────────────────────────────────

  private transition(next: ExecutorState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.options.logger.debug({ from: prev, to: next }, 'PersistentExecutor: state');
    this.emit('state-changed', prev, next);
    if (next === 'closed') this.emit('closed');
    if (next === 'ready' && prev === 'restarting') this.emit('restarted', this.sessionId);
  }

  private touchActivity(): void {
    this.lastActivityAt = Date.now();
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    const ms = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clearIdleTimer();
    if (ms <= 0) return;
    if (this.activeTurn) return; // don't idle-evict mid-turn
    this.idleTimerId = setTimeout(() => {
      if (this.state === 'ready' && !this.activeTurn) {
        this.options.logger.info({ idleMs: Date.now() - this.lastActivityAt }, 'PersistentExecutor: idle, shutting down');
        void this.shutdown('idle-timeout');
      }
    }, ms);
    // Don't keep the event loop alive solely for this timer
    if (typeof (this.idleTimerId as any).unref === 'function') {
      (this.idleTimerId as any).unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimerId) {
      clearTimeout(this.idleTimerId);
      this.idleTimerId = undefined;
    }
  }

  private buildHooks(): Record<string, unknown> {
    const log = this.options.logger;
    const onTeamEvent = this.options.onTeamEvent;
    const teamObserver = (kind: TeamEvent['kind']) => {
      return async (input: any): Promise<Record<string, unknown>> => {
        log.info(
          { kind, taskId: input?.task_id, teammate: input?.teammate_name, team: input?.team_name },
          'PersistentExecutor: team hook fired',
        );
        this.touchActivity();
        if (onTeamEvent) {
          try {
            if (kind === 'task_created') {
              onTeamEvent({
                kind: 'task_created',
                taskId: input?.task_id,
                subject: input?.task_subject,
                description: input?.task_description,
                teammate: input?.teammate_name,
                teamName: input?.team_name,
              });
            } else if (kind === 'task_completed') {
              onTeamEvent({
                kind: 'task_completed',
                taskId: input?.task_id,
                subject: input?.task_subject,
                teammate: input?.teammate_name,
                teamName: input?.team_name,
              });
            } else if (kind === 'teammate_idle') {
              onTeamEvent({
                kind: 'teammate_idle',
                teammate: input?.teammate_name,
                teamName: input?.team_name,
              });
            }
            this.emit('team-event', { kind, raw: input });
          } catch (err) {
            log.warn({ err, kind }, 'PersistentExecutor: onTeamEvent threw');
          }
        }
        return {};
      };
    };

    // AskUserQuestion PreToolUse hook — mirrors legacy executor. The SDK
    // marks AskUserQuestion as requiresUserInteraction; in bypassPermissions
    // mode we intercept, pause until the bridge supplies the user's answers,
    // then return them as updatedInput so the SDK auto-allows.
    const askUserQuestionHook = async (
      input: { hook_event_name: string; tool_name: string; tool_input: unknown; tool_use_id: string },
      _toolUseId: string | undefined,
      { signal }: { signal: AbortSignal },
    ): Promise<Record<string, unknown>> => {
      const toolInput = input.tool_input as Record<string, unknown>;
      const id = input.tool_use_id;
      const answers = await new Promise<Record<string, string>>((resolve) => {
        this.pendingQuestionResolvers.set(id, resolve);
        const timeout = setTimeout(() => {
          if (this.pendingQuestionResolvers.delete(id)) {
            log.warn({ toolUseId: id }, 'AskUserQuestion hook timed out (6 min) — empty answers');
            resolve({});
          }
        }, 6 * 60 * 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          this.pendingQuestionResolvers.delete(id);
          resolve({});
        }, { once: true });
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...toolInput, answers },
        },
      };
    };

    return {
      PreToolUse: [{
        matcher: 'AskUserQuestion',
        hooks: [askUserQuestionHook as any],
      }],
      TaskCreated: [{ hooks: [teamObserver('task_created') as any] }],
      TaskCompleted: [{ hooks: [teamObserver('task_completed') as any] }],
      TeammateIdle: [{ hooks: [teamObserver('teammate_idle') as any] }],
    };
  }

  /**
   * Resolve a pending AskUserQuestion PreToolUse hook with the user's
   * collected answers. Used by the bridge after the user clicks card
   * buttons or answers via text reply.
   */
  resolveQuestion(toolUseId: string, answers: Record<string, string>): void {
    const resolver = this.pendingQuestionResolvers.get(toolUseId);
    if (resolver) {
      this.pendingQuestionResolvers.delete(toolUseId);
      this.options.logger.info({ toolUseId, count: Object.keys(answers).length }, 'PersistentExecutor: resolving AskUserQuestion');
      resolver(answers);
    } else {
      // Fallback path: enqueue tool_result via inputQueue.
      this.options.logger.warn({ toolUseId }, 'PersistentExecutor: no pending resolver — using sendAnswer fallback');
      this.sendAnswer(toolUseId, JSON.stringify({ answers }));
    }
  }

  /**
   * Inject a synthesized tool_result into the conversation. Used as a
   * fallback for tool answers that the SDK isn't auto-handling, and for
   * teammate-style messages routed through the bridge.
   */
  sendAnswer(toolUseId: string, answerText: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: answerText }],
      },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    };
    this.inputQueue.enqueue(msg);
  }

  private pushSpontaneous(msg: SDKMessage): void {
    const limit = this.options.spontaneousBufferLimit ?? DEFAULT_SPONTANEOUS_LIMIT;
    if (limit > 0 && this.spontaneousBuffer.length >= limit) {
      // Drop oldest (ring buffer)
      this.spontaneousBuffer.shift();
    }
    this.spontaneousBuffer.push(msg);
    this.emit('spontaneous', msg);
  }

  /**
   * Background consumer: drives the SDK stream, dispatching each message
   * either to the active turn or to the spontaneous buffer. Handles clean
   * shutdown (stream completes), crashes (stream throws), and idle.
   */
  private async consumeLoop(): Promise<void> {
    if (!this.rawStream) return;
    try {
      for await (const raw of this.rawStream) {
        const msg = raw as SDKMessage;
        if (msg.session_id) this.sessionId = msg.session_id;
        this.touchActivity();

        const turn = this.activeTurn;
        if (turn) {
          if (!turn.detached) {
            // Normal in-flight turn: forward the message to the listener.
            turn.queue.enqueue(msg);
            if (msg.type === 'result') {
              turn.completed = true;
              turn.queue.finish();
              this.activeTurn = null;
              this.options.logger.debug({ turnId: turn.id }, 'PersistentExecutor: turn completed');
              this.emit('turn-completed', turn.id);
              this.armIdleTimer();
            }
          } else {
            // Aborted turn: drain SDK output silently until terminal result.
            // This prevents the next turn from inheriting straggler messages.
            if (msg.type === 'result') {
              this.activeTurn = null;
              turn.completed = true;
              turn.drainResolve?.();
              this.armIdleTimer();
            }
            // (drop other messages — caller has detached)
          }
        } else {
          this.pushSpontaneous(msg);
        }
      }
      this.options.logger.info('PersistentExecutor: stream ended cleanly');
      this.transition('closed');
    } catch (err: any) {
      // Distinguish "we asked to shut down" (queue.finish then iterator throws
      // AbortError-like) vs an unexpected crash.
      const isShuttingDown = this.state === 'shutting_down' || this.state === 'closed';
      if (isShuttingDown) {
        this.options.logger.debug({ err: err?.message }, 'PersistentExecutor: stream ended during shutdown');
        return;
      }
      this.options.logger.error({ err: err?.message || err }, 'PersistentExecutor: stream errored, attempting restart');
      this.emit('crashed', err);
      // Notify any active turn that it was lost
      if (this.activeTurn) {
        const turn = this.activeTurn;
        turn.detached = true;
        turn.queue.finish();
        this.activeTurn = null;
        this.emit('turn-aborted', turn.id);
      }
      await this.maybeRestart();
    }
  }

  private async maybeRestart(): Promise<void> {
    // Reset counter if last crash was long ago
    if (Date.now() - this.lastRestartAt > RESTART_COUNTER_RESET_MS) {
      this.restartAttempts = 0;
    }
    const max = this.options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    if (this.restartAttempts >= max) {
      this.options.logger.error(
        { attempts: this.restartAttempts, max },
        'PersistentExecutor: max restart attempts exceeded; staying closed',
      );
      this.transition('closed');
      return;
    }
    this.restartAttempts++;
    this.lastRestartAt = Date.now();
    this.transition('restarting');
    try {
      await this.start();
    } catch (err) {
      this.options.logger.error({ err }, 'PersistentExecutor: restart failed');
      this.transition('crashed');
    }
  }
}
