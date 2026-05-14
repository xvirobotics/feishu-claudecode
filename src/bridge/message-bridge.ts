import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage, CardState, PendingQuestion, TeamState, TeamMember, TeamTask } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import type { DocSync } from '../sync/doc-sync.js';
import type {
  Engine,
  Executor,
  ExecutionHandle,
  EngineName,
  TeamEvent,
  ApiContext,
} from '../engines/index.js';
import { createEngine, resolveEngineName, StreamProcessor, SessionManager } from '../engines/index.js';
import { ExecutorRegistry } from '../engines/claude/executor-registry.js';
import { RateLimiter } from './rate-limiter.js';
import { OutputsManager } from './outputs-manager.js';
import { MemoryClient } from '../memory/memory-client.js';
import { AuditLogger } from '../utils/audit-logger.js';
import { CommandHandler } from './command-handler.js';
import { OutputHandler } from './output-handler.js';
import { CostTracker } from '../utils/cost-tracker.js';
import { metrics } from '../utils/metrics.js';
import type { SessionRegistry } from '../session/session-registry.js';

const TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to answer

/**
 * Default for the persistent-executor pool when no per-bot `persistentExecutor.enabled`
 * is set. Default: ON (since 2026-05-13). Opt out with
 * `METABOT_PERSISTENT_EXECUTOR=false` (or `=0`) in the env.
 *
 * Pure / side-effect-free / unit-testable — used by both
 * `MessageBridge.isPersistentExecutorEnabled` and the `/api/executors`
 * route, so the default flip can't drift between the two.
 */
export function resolvePersistentExecutorEnvDefault(envVal: string | undefined): boolean {
  if (envVal === 'false' || envVal === '0') return false;
  return true;
}
const MAX_QUEUE_SIZE = 5; // max queued messages per chat
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour idle → abort
/**
 * Stage 3 — coalesce window for spontaneous Feishu cards. When teammates
 * (or /goal evaluators, or background tasks) emit messages while no user
 * turn is active, we batch them into a single card every COALESCE_MS to
 * avoid spamming the chat.
 */
const SPONTANEOUS_COALESCE_MS = 30 * 1000;
const FINAL_CARD_RETRIES = 3;
const FINAL_CARD_BASE_DELAY_MS = 2000;
const TASK_TIMEOUT_MESSAGE = 'Task timed out (24 hour limit)';
const IDLE_TIMEOUT_MESSAGE = 'Task aborted: no activity for 1 hour';
const BATCH_DEBOUNCE_MS = 2000; // 2s window to collect multiple images/files
const DEFAULT_IMAGE_TEXT = '请分析这张图片';
const DEFAULT_FILE_TEXT = '请分析这个文件';

/**
 * Extract a one-line summary from an SDK stream message for the spontaneous
 * activity card. Returns null if the message has nothing user-readable.
 *
 * Intentionally only handles `assistant` *text* blocks — same UX bet we made
 * for the main card in PR #268: the user only cares about the agent's
 * conclusion, not the per-tool play-by-play. `🔧 <ToolName>` lines used to
 * be included for tool_use blocks but that's the exact intermediate noise
 * we just hid from the live card; surfacing it on the spontaneous card
 * would just re-introduce the same complaint between turns.
 *
 * Result-type messages are also ignored — SDK's `result.result` is a
 * verbatim echo of the last assistant text block, so including them caused
 * the same content to show up twice in the card.
 */
export function extractSpontaneousSnippet(msg: unknown): string | null {
  const m = msg as { type?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> } };
  if (m?.type !== 'assistant' || !m.message?.content) return null;
  for (const blk of m.message.content) {
    if (blk.type === 'text' && blk.text) {
      const trimmed = String(blk.text).trim();
      if (trimmed) return trimmed.slice(0, 400);
    }
    // tool_use blocks intentionally fall through — see docstring above.
  }
  return null;
}

/**
 * Build the markdown body of a spontaneous activity card from collected
 * snippets. Shows ONLY the latest snippet (the agent's conclusion of the
 * burst); if multiple snippets were coalesced, a small footer notes the
 * count so users know there was more activity if they want to dig into
 * logs. Mirrors the "show only the final result, hide the play-by-play"
 * pattern from PR #268's main-card tool indicator.
 *
 * No header line in the body — earlier versions prepended an italic
 * "Agent activity between turns (…)" caption, but users found it long
 * and visually noisy. The card itself is rendered with the
 * `agent_activity` status (blue header, "Agent activity" title), which
 * is enough to tell it apart from a regular "complete" reply card.
 * Don't re-add a body header without verifying the card-header signal
 * is no longer sufficient.
 */
export function formatSpontaneousCardBody(snippets: string[]): string {
  if (snippets.length === 0) return '';
  const lines: string[] = [snippets[snippets.length - 1]];
  if (snippets.length > 1) {
    lines.push('');
    lines.push(`_(${snippets.length} events coalesced; showing latest)_`);
  }
  return lines.join('\n');
}

interface PendingBatch {
  messages: IncomingMessage[];
  timerId: ReturnType<typeof setTimeout>;
}

interface RunningTask {
  abortController: AbortController;
  startTime: number;
  executionHandle: ExecutionHandle;
  pendingQuestion: PendingQuestion | null;
  /** Index of the question currently being displayed within pendingQuestion.questions */
  currentQuestionIndex: number;
  /** Accumulated answers keyed by question header (for multi-question calls) */
  collectedAnswers: Record<string, string>;
  cardMessageId: string;
  /**
   * Dedicated card for the currently-displayed AskUserQuestion, sent
   * SEPARATELY from {@link cardMessageId}. On Feishu this is a Schema 1.0
   * card because v2 mobile drops button blocks; the main streaming card
   * stays v2 throughout (Feishu refuses to patch v2 → v1). Cleared after
   * the question is answered.
   */
  questionCardMessageId?: string;
  questionTimeoutId?: ReturnType<typeof setTimeout>;
  processor: StreamProcessor;
  rateLimiter: RateLimiter;
  chatId: string;
  /** Live snapshot of the active Agent Team, accumulated from team hooks. */
  teamState?: TeamState;
}

export interface ApiTaskOptions {
  prompt: string;
  chatId: string;
  userId?: string;
  sendCards?: boolean;
  /** Override maxTurns for this task (e.g. 1 for voice mode). */
  maxTurns?: number;
  /** Override model for this task (e.g. faster model for voice calls). */
  model?: string;
  /** Override allowed tools for this task (empty array = no tools). */
  allowedTools?: string[];
  /** Called on every card state update (streaming). `final` is true on the last update. */
  onUpdate?: (state: CardState, messageId: string, final: boolean) => void;
  /** Called when Claude asks a question. Return the answer JSON string. */
  onQuestion?: (question: PendingQuestion) => Promise<string>;
  /** Called with output files after execution completes (before cleanup). */
  onOutputFiles?: (files: import('./outputs-manager.js').OutputFile[]) => void;
  /** Group chat member names — injected into system prompt for inter-bot communication. */
  groupMembers?: string[];
  /** Group ID — used for inter-bot communication chatId pattern. */
  groupId?: string;
}

export interface ApiTaskResult {
  success: boolean;
  responseText: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

export interface ActivityEventData {
  type: 'task_started' | 'task_completed' | 'task_failed';
  botName: string;
  chatId: string;
  userId?: string;
  prompt?: string;
  responsePreview?: string;
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  timestamp: number;
}

export class MessageBridge {
  private engine: Engine;
  private executor: Executor;
  /** Lazy per-engine cache so a session override doesn't pay instantiation cost each turn. */
  private engineCache = new Map<EngineName, { engine: Engine; executor: Executor }>();
  private sessionManager: SessionManager;
  private outputsManager: OutputsManager;
  private audit: AuditLogger;
  private commandHandler: CommandHandler;
  private outputHandler: OutputHandler;
  readonly costTracker: CostTracker;
  private sessionRegistry?: SessionRegistry;
  private runningTasks = new Map<string, RunningTask>(); // keyed by chatId
  private messageQueues = new Map<string, IncomingMessage[]>(); // per-chatId message queue
  private pendingBatches = new Map<string, PendingBatch>(); // media debounce batches
  /**
   * Stage 2 — persistent executor pool. Lazy-created on first acquire when
   * the PERSISTENT_EXECUTOR env feature flag is on. One pool per bot.
   */
  private persistentRegistry: ExecutorRegistry | null = null;
  /**
   * Stage 3 — track which persistent executors already have a spontaneous-
   * activity subscription, so we don't double-subscribe across acquisitions.
   * Cleared when an executor is removed from the pool.
   */
  private spontaneousSubscribed = new Set<string>();
  /**
   * Stage 3 — accumulator for spontaneous activity per chatId, debounced
   * into a single Feishu card every COALESCE_MS. Built up by the
   * 'spontaneous' event handler, flushed by a timer.
   */
  private spontaneousBuffers = new Map<string, {
    teamState: TeamState;
    snippets: string[];
    timer: ReturnType<typeof setTimeout>;
  }>();
  /**
   * In-flight continuation cards — main-line agent bursts triggered by an
   * SDK `<task-notification>` injection (background bash returns etc.).
   * Tracked separately from {@link runningTasks} so user messages can
   * still queue / be processed normally while a continuation is rendering.
   */
  private continuationTasks = new Map<string, {
    abortController: AbortController;
    cardMessageId: string;
    turnId: string;
  }>();
  /**
   * AskUserQuestion calls that fired between turns (no activeTurn in the
   * executor at the time of the PreToolUse hook). The bridge displays them
   * as standalone question cards and routes the user's next typed reply
   * back to {@link PersistentClaudeExecutor.resolveQuestion}.
   *
   * Without this, the question text would only appear inside the coalesced
   * "Agent activity" body and the user's reply would be treated as a fresh
   * user turn — which then blocks for 6 minutes on the still-hanging hook.
   *
   * Single in-flight slot per chatId. If a second between-turn question
   * fires while one is still pending, the later one wins — the older
   * resolver hangs until its 6-minute timeout (rare in practice).
   */
  private pendingBetweenTurnQuestions = new Map<string, {
    toolUseId: string;
    questions: PendingQuestion['questions'];
    cardMessageId: string;
  }>();
  /** Callback for activity lifecycle events (task started/completed/failed). */
  onActivityEvent?: (event: ActivityEventData) => void;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    private sender: IMessageSender,
    memoryServerUrl: string,
    memorySecret?: string,
  ) {
    this.engine = createEngine(config, logger);
    this.executor = this.engine.createExecutor();
    const defaultEngineName = resolveEngineName(config);
    this.engineCache.set(defaultEngineName, { engine: this.engine, executor: this.executor });
    this.sessionManager = new SessionManager(config.claude.defaultWorkingDirectory, logger, config.name);
    this.outputsManager = new OutputsManager(config.claude.outputsBaseDir, logger);
    this.audit = new AuditLogger(logger);
    this.costTracker = new CostTracker();

    const memoryClient = new MemoryClient(memoryServerUrl, logger, memorySecret);

    this.commandHandler = new CommandHandler(
      config, logger, sender, this.sessionManager, memoryClient, this.audit,
      (chatId) => this.runningTasks.get(chatId),
      (chatId) => this.stopTask(chatId),
      (chatId) => this.clearChatQueue(chatId),
      (chatId, reason) => this.releaseChatExecutor(chatId, reason),
    );

    this.outputHandler = new OutputHandler(logger, sender, this.outputsManager);
  }

  /** Emit an activity event if a listener is registered. */
  private emitActivity(event: ActivityEventData): void {
    try { this.onActivityEvent?.(event); } catch { /* ignore */ }
  }

  /**
   * Pick the executor for a chat based on its session engine override
   * (set via `/model claude` or `/model kimi`), falling back to the bot's
   * configured engine. Executors are cached per-engine so repeated turns
   * on the same engine don't re-instantiate the SDK wrapper.
   */
  private executorForChat(chatId: string): Executor {
    const session = this.sessionManager.getSession(chatId);
    const name: EngineName = session.engine ?? resolveEngineName(this.config);
    let entry = this.engineCache.get(name);
    if (!entry) {
      const engine = createEngine(this.config, this.logger, name);
      const executor = engine.createExecutor();
      entry = { engine, executor };
      this.engineCache.set(name, entry);
      this.logger.info({ engine: name, chatId }, 'Instantiated engine on demand for session override');
    }
    return entry.executor;
  }

  /**
   * Session ids and model overrides are engine-specific. If a bot's default
   * engine changes between restarts, discard the old per-chat state before the
   * next execution so another engine does not try to resume it.
   */
  private prepareSessionForExecution(chatId: string) {
    const session = this.sessionManager.getSession(chatId);
    const engineName: EngineName = session.engine ?? resolveEngineName(this.config);

    if (session.sessionId && session.sessionIdEngine && session.sessionIdEngine !== engineName) {
      this.logger.info(
        { chatId, sessionIdEngine: session.sessionIdEngine, engine: engineName },
        'Clearing session id from a different engine',
      );
      this.sessionManager.resetSession(chatId);
    }

    if (session.model && session.modelEngine && session.modelEngine !== engineName) {
      this.logger.info(
        { chatId, modelEngine: session.modelEngine, engine: engineName },
        'Clearing model override from a different engine',
      );
      this.sessionManager.setSessionModel(chatId, undefined);
    }

    return {
      session: this.sessionManager.getSession(chatId),
      engineName,
    };
  }

  /** Inject the doc sync service for /sync commands. */
  setDocSync(docSync: DocSync): void {
    this.commandHandler.setDocSync(docSync);
  }

  /** Inject the session registry for cross-platform session sync. */
  setSessionRegistry(registry: SessionRegistry): void {
    this.sessionRegistry = registry;
  }

  /** Expose session manager for cross-platform session linking. */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  isBusy(chatId: string): boolean {
    return this.runningTasks.has(chatId);
  }

  /** Return info about all currently running tasks (for team status display). */
  getRunningTasksInfo(): Array<{ chatId: string; startTime: number }> {
    return Array.from(this.runningTasks.entries()).map(([chatId, task]) => ({
      chatId,
      startTime: task.startTime,
    }));
  }

  /** Stop a running task for the given chatId. Returns true if a task was stopped. */
  stopChatTask(chatId: string): boolean {
    if (!this.runningTasks.has(chatId)) return false;
    this.stopTask(chatId);
    return true;
  }

  /**
   * Discard every queued message for a chat without touching the running
   * task. Returns the number of messages discarded. Used by the /stop
   * command so the user's "stop" intent isn't immediately undone by the
   * next queued message taking over via {@link processQueue}.
   *
   * Not called from internal timeout / error paths — those keep the queue
   * intact in case the user wants follow-up to still process.
   */
  clearChatQueue(chatId: string): number {
    const queue = this.messageQueues.get(chatId);
    if (!queue || queue.length === 0) return 0;
    const cleared = queue.length;
    this.messageQueues.delete(chatId);
    this.logger.info({ chatId, cleared }, 'MessageBridge: cleared chat queue');
    return cleared;
  }

  private stopTask(chatId: string): void {
    const task = this.runningTasks.get(chatId);
    if (!task) return;
    if (task.questionTimeoutId) clearTimeout(task.questionTimeoutId);
    // Finalize any in-flight question card so the user doesn't see buttons
    // that go nowhere after the task is gone.
    if (task.questionCardMessageId) {
      const upd = this.sender.updateQuestionCard
        ? this.sender.updateQuestionCard.bind(this.sender)
        : this.sender.updateCard.bind(this.sender);
      void upd(task.questionCardMessageId, {
        status: 'error',
        userPrompt: 'Question',
        responseText: '_Task stopped before answer received_',
        toolCalls: [],
        errorMessage: 'Task was stopped',
      });
      task.questionCardMessageId = undefined;
    }
    task.executionHandle.finish();
    task.abortController.abort();
    // Don't delete from runningTasks here — the finally block in executeQuery will
    // handle cleanup. Deleting early creates a race: if the user sends a new message
    // before the old loop exits, the old finally block would delete the NEW task entry.
  }

  /**
   * Whether the persistent-executor code path is enabled for this bot.
   *
   * Default: ON. Each chatId is backed by a long-lived Claude process
   * (managed by {@link ExecutorRegistry}) instead of spawning a fresh
   * process per turn. This is required for Agent Teams teammates,
   * `/goal` multi-turn auto-drive, and `/background` tasks to survive
   * across user messages — features that the user-facing card UI now
   * advertises, so turning the persistent executor off silently breaks
   * what users expect.
   *
   * Per-bot config wins over env, so individual bots can opt out without
   * affecting siblings:
   *   1. config.persistentExecutor.enabled === false → off
   *   2. config.persistentExecutor.enabled === true  → on
   *   3. otherwise: METABOT_PERSISTENT_EXECUTOR=false (or '0') env → off
   *   4. otherwise: on (the default)
   *
   * Was opt-in originally (until 2026-05-13) while we burned through
   * the team-review P0 blockers; both shipped, telemetry is clean, no
   * reason to keep new users in the worse default any longer.
   */
  private isPersistentExecutorEnabled(): boolean {
    const cfg = this.config.persistentExecutor;
    if (cfg?.enabled === true) return true;
    if (cfg?.enabled === false) return false;
    return resolvePersistentExecutorEnvDefault(process.env.METABOT_PERSISTENT_EXECUTOR);
  }

  /** Lazy-init the registry for the persistent-executor code path. */
  private getOrCreateRegistry(): ExecutorRegistry {
    if (!this.persistentRegistry) {
      // Per-bot config wins over env. Both are optional; registry uses its
      // own defaults (30 min idle, 20 max concurrent) when neither is set.
      const cfg = this.config.persistentExecutor;
      const idleEnv = Number(process.env.METABOT_PERSISTENT_EXECUTOR_IDLE_MS);
      const maxEnv = Number(process.env.METABOT_PERSISTENT_EXECUTOR_MAX_CONCURRENT);
      const idleTimeoutMs = cfg?.idleTimeoutMs
        ?? (Number.isFinite(idleEnv) && idleEnv >= 0 ? idleEnv : undefined);
      const maxConcurrent = cfg?.maxConcurrent
        ?? (Number.isFinite(maxEnv) && maxEnv > 0 ? maxEnv : undefined);
      this.persistentRegistry = new ExecutorRegistry({
        logger: this.logger,
        idleTimeoutMs,
        maxConcurrent,
        defaultApiKey: this.config.claude.apiKey,
        defaultModel: this.config.claude.model,
      });
      // Stage 3 — every newly added executor gets a spontaneous-activity
      // subscription so teammate / goal / background pings between turns
      // surface as Feishu cards.
      this.persistentRegistry.on('executor-added', (chatId: string) => {
        this.attachSpontaneousHandler(chatId);
      });
      this.persistentRegistry.on('executor-removed', (chatId: string) => {
        this.spontaneousSubscribed.delete(chatId);
        // Flush any pending spontaneous buffer so we don't lose accumulated
        // activity when an executor goes away (e.g. idle eviction).
        const buf = this.spontaneousBuffers.get(chatId);
        if (buf) {
          clearTimeout(buf.timer);
          void this.flushSpontaneous(chatId);
        }
        // Abort any in-flight continuation card — its stream is bound to the
        // executor we're tearing down and will never deliver another message.
        // The handleContinuationTurn loop will finalize the card to an error
        // state via its abort-aware fallback.
        const cont = this.continuationTasks.get(chatId);
        if (cont) {
          cont.abortController.abort();
        }
        // Between-turn question whose resolver is now dead — flush the
        // question card to an error state and drop the bookkeeping so the
        // user's next message isn't intercepted as the answer.
        const q = this.pendingBetweenTurnQuestions.get(chatId);
        if (q) {
          this.pendingBetweenTurnQuestions.delete(chatId);
          void this.finalizeBetweenTurnQuestionCard(q.cardMessageId, {
            status: 'error',
            userPrompt: 'Question',
            responseText: '_Question canceled — agent session ended._',
            toolCalls: [],
          });
        }
      });
      this.logger.info(
        {
          idleTimeoutMs,
          maxConcurrent,
          bot: this.config.name,
          source: cfg ? 'bot-config' : 'env',
        },
        'MessageBridge: persistent-executor registry initialized',
      );
    }
    return this.persistentRegistry;
  }

  /**
   * Attach event handlers to the chat's persistent executor. Called when a
   * new executor is added to the pool. Idempotent — guarded by
   * spontaneousSubscribed.
   *
   * Wires two channels for between-turn agent output:
   *   - `spontaneous` — teammate / `/goal` / status pings; coalesced into the
   *     "Agent activity between turns" card every 30 s.
   *   - `continuation-turn` — SDK-initiated continuation turn (background
   *     task settled, agent now replying in main-line). Rendered as a fresh
   *     streaming card just like a user-prompted turn.
   */
  private attachSpontaneousHandler(chatId: string): void {
    if (this.spontaneousSubscribed.has(chatId)) return;
    const exec = this.persistentRegistry?.peek(chatId);
    if (!exec) return;
    this.spontaneousSubscribed.add(chatId);
    exec.on('spontaneous', (msg) => {
      this.handleSpontaneousMessage(chatId, msg);
    });
    exec.on('continuation-turn', (handle) => {
      // Fire-and-forget — handleContinuationTurn manages its own lifecycle
      // (card + stream loop + finalize). Errors are logged inside.
      void this.handleContinuationTurn(chatId, handle as ExecutionHandle);
    });
    exec.on('between-turn-question', (payload: {
      toolUseId: string;
      questions: PendingQuestion['questions'];
    }) => {
      void this.handleBetweenTurnQuestion(chatId, payload);
    });
    this.logger.debug({ chatId }, 'MessageBridge: attached executor subscriptions');
  }

  /**
   * Surface a between-turn AskUserQuestion as its own card on the chat.
   * Called from the `between-turn-question` executor event. The user's
   * next typed reply for this chatId is intercepted in
   * {@link handleMessage} and routed back via the executor's
   * {@link PersistentClaudeExecutor.resolveQuestion}.
   *
   * Single in-flight slot per chatId — if one is already pending, the
   * older one is abandoned (its resolver will hang to the SDK's 6-min
   * timeout, then return empty answers). The older card is marked
   * "superseded" so the user sees what happened.
   */
  private async handleBetweenTurnQuestion(
    chatId: string,
    payload: { toolUseId: string; questions: PendingQuestion['questions'] },
  ): Promise<void> {
    if (!payload.questions || payload.questions.length === 0) {
      this.logger.warn({ chatId, toolUseId: payload.toolUseId }, 'between-turn question with no parsed questions; skipping card');
      return;
    }
    const existing = this.pendingBetweenTurnQuestions.get(chatId);
    if (existing) {
      this.logger.warn(
        { chatId, prevToolUseId: existing.toolUseId, newToolUseId: payload.toolUseId },
        'MessageBridge: between-turn question superseded by newer one',
      );
      void this.finalizeBetweenTurnQuestionCard(existing.cardMessageId, {
        status: 'error',
        userPrompt: 'Question',
        responseText: '_Superseded by a newer question._',
        toolCalls: [],
      });
      this.pendingBetweenTurnQuestions.delete(chatId);
    }

    // Show only the first question on the card (matches runOneTurn — the
    // bridge surfaces one sub-question at a time, advancing the card on
    // each typed reply). Multi-question case is logged below; the existing
    // bridge code path doesn't support advancing between-turn sub-questions
    // yet, so we route only the first answer and short-circuit the rest.
    if (payload.questions.length > 1) {
      this.logger.warn(
        { chatId, toolUseId: payload.toolUseId, total: payload.questions.length },
        'between-turn AskUserQuestion has multiple sub-questions; only the first will be displayed and routed',
      );
    }
    const displayQuestion: PendingQuestion = {
      toolUseId: payload.toolUseId,
      questions: [payload.questions[0]],
    };

    const card: CardState = {
      status: 'waiting_for_input',
      userPrompt: '(between-turn question)',
      responseText: '',
      toolCalls: [],
      pendingQuestion: displayQuestion,
    };

    const send = this.sender.sendQuestionCard
      ? this.sender.sendQuestionCard.bind(this.sender)
      : this.sender.sendCard.bind(this.sender);
    let cardMessageId: string | undefined;
    try {
      cardMessageId = await send(chatId, card);
    } catch (err) {
      this.logger.error({ err, chatId, toolUseId: payload.toolUseId }, 'MessageBridge: failed to send between-turn question card');
      return;
    }
    if (!cardMessageId) {
      this.logger.warn({ chatId, toolUseId: payload.toolUseId }, 'MessageBridge: between-turn question card returned no messageId');
      return;
    }

    this.pendingBetweenTurnQuestions.set(chatId, {
      toolUseId: payload.toolUseId,
      questions: payload.questions,
      cardMessageId,
    });
    this.logger.info(
      { chatId, toolUseId: payload.toolUseId, cardMessageId },
      'MessageBridge: between-turn question card opened',
    );
  }

  /**
   * Update the dedicated question card after the user answers (or after the
   * executor is torn down). Uses updateQuestionCard if the sender supports
   * it, else falls back to updateCard.
   */
  private async finalizeBetweenTurnQuestionCard(
    cardMessageId: string,
    state: CardState,
  ): Promise<void> {
    try {
      const update = this.sender.updateQuestionCard
        ? this.sender.updateQuestionCard.bind(this.sender)
        : this.sender.updateCard.bind(this.sender);
      await update(cardMessageId, state);
    } catch (err) {
      this.logger.warn({ err, cardMessageId }, 'MessageBridge: failed to update between-turn question card');
    }
  }

  /**
   * Treat the user's typed reply as the answer to a pending between-turn
   * question. Routes through {@link PersistentClaudeExecutor.resolveQuestion}
   * so the AskUserQuestion PreToolUse hook unblocks and the SDK proceeds.
   * Returns true if the message was consumed as an answer (caller should
   * NOT continue to executeQuery).
   */
  private async tryHandleBetweenTurnQuestionReply(msg: IncomingMessage): Promise<boolean> {
    const { chatId, text, imageKey } = msg;
    const pending = this.pendingBetweenTurnQuestions.get(chatId);
    if (!pending) return false;

    // Image-only reply isn't a valid answer; nudge the user.
    if (imageKey && !text.trim()) {
      await this.sender.sendText(chatId, '请用文字回复问题卡片中的选项编号或自定义答案。');
      return true;
    }

    const trimmed = text.trim();
    const firstQ = pending.questions[0];
    let answerText: string;
    const num = parseInt(trimmed, 10);
    if (Number.isFinite(num) && num >= 1 && num <= firstQ.options.length) {
      answerText = firstQ.options[num - 1].label;
    } else {
      answerText = trimmed;
    }

    const answers: Record<string, string> = { [firstQ.header]: answerText };
    // For multi-sub-question between-turn calls (rare; logged on arrival),
    // synthesize empty answers for the rest so the hook still resolves.
    for (let i = 1; i < pending.questions.length; i++) {
      answers[pending.questions[i].header] = '';
    }

    const executor = this.persistentRegistry?.peek(chatId);
    if (!executor) {
      this.logger.warn(
        { chatId, toolUseId: pending.toolUseId },
        'MessageBridge: between-turn answer arrived but executor is gone; dropping',
      );
      this.pendingBetweenTurnQuestions.delete(chatId);
      await this.finalizeBetweenTurnQuestionCard(pending.cardMessageId, {
        status: 'error',
        userPrompt: 'Question',
        responseText: '_Question canceled — agent session ended._',
        toolCalls: [],
      });
      return true;
    }

    this.pendingBetweenTurnQuestions.delete(chatId);
    try {
      executor.resolveQuestion(pending.toolUseId, answers);
    } catch (err) {
      this.logger.error({ err, chatId, toolUseId: pending.toolUseId }, 'MessageBridge: resolveQuestion threw');
    }
    this.logger.info(
      { chatId, toolUseId: pending.toolUseId, answer: answerText },
      'MessageBridge: resolved between-turn question',
    );

    await this.finalizeBetweenTurnQuestionCard(pending.cardMessageId, {
      status: 'complete',
      userPrompt: 'Question',
      responseText: `> **Reply:** ${answerText}`,
      toolCalls: [],
    });
    return true;
  }

  /**
   * Buffer a spontaneous message and (re)arm the coalesce timer. We extract
   * just the human-readable bits — assistant text and tool_use intent —
   * skipping noisy stream events.
   *
   * `result`-type messages are intentionally NOT snippeted: the SDK's
   * `result.result` field is almost always a verbatim echo of the previous
   * assistant text block, so emitting it would mean every spontaneous burst
   * shows the same content twice in the card (once with no prefix from the
   * assistant message, once with a 🤖 prefix from the result). Skipping
   * result here removes that duplication.
   */
  private handleSpontaneousMessage(chatId: string, msg: unknown): void {
    const snippet = extractSpontaneousSnippet(msg);
    // Tool/system events without text aren't worth a card.
    if (!snippet) return;

    let buf = this.spontaneousBuffers.get(chatId);
    if (!buf) {
      buf = {
        teamState: { teammates: [], tasks: [] },
        snippets: [],
        timer: setTimeout(() => {
          void this.flushSpontaneous(chatId);
        }, SPONTANEOUS_COALESCE_MS),
      };
      this.spontaneousBuffers.set(chatId, buf);
    }
    buf.snippets.push(snippet);
    // Cap to prevent runaway growth in a single window
    if (buf.snippets.length > 25) buf.snippets.splice(0, buf.snippets.length - 25);
  }

  /**
   * Flush any accumulated spontaneous activity for chatId as a single
   * "agent activity" Feishu card. No-op if buffer is empty or there's
   * an active user turn (we'd rather merge into the live card than spam).
   *
   * Uses the `agent_activity` status, which renders a blue header with
   * an "Agent activity" title — that's the entire visual signal that
   * this is a between-turn burst, not a normal "complete" reply.
   * Earlier versions used `status: 'complete'` (green) plus an italic
   * body caption, but users found the caption ugly and the green color
   * indistinguishable from a regular turn.
   */
  private async flushSpontaneous(chatId: string): Promise<void> {
    const buf = this.spontaneousBuffers.get(chatId);
    if (!buf) return;
    this.spontaneousBuffers.delete(chatId);
    clearTimeout(buf.timer);

    // If a user turn just started, drop the spontaneous batch — its content
    // is about to land in the live card anyway.
    if (this.runningTasks.has(chatId)) {
      this.logger.debug({ chatId, snippetCount: buf.snippets.length }, 'MessageBridge: drop spontaneous (active turn)');
      return;
    }

    // Nothing user-meaningful to surface — buffer might exist because a
    // teammate ping landed but extractSpontaneousSnippet filtered all of
    // its blocks (e.g. tool-only burst). Silently skip the card.
    if (buf.snippets.length === 0) {
      this.logger.debug({ chatId }, 'MessageBridge: drop spontaneous (no text snippets)');
      return;
    }

    const responseText = formatSpontaneousCardBody(buf.snippets);

    const card: CardState = {
      status: 'agent_activity',
      userPrompt: '(agent activity)',
      responseText,
      toolCalls: [],
      teamState: buf.teamState,
    };
    try {
      await this.sender.sendCard(chatId, card);
      this.logger.info({ chatId, snippetCount: buf.snippets.length }, 'MessageBridge: sent spontaneous card');
    } catch (err) {
      this.logger.warn({ err, chatId }, 'MessageBridge: failed to send spontaneous card');
    }
  }

  /**
   * Render an SDK-initiated continuation turn as a fresh streaming card —
   * the same blue → green lifecycle a user-prompted turn produces, NOT the
   * coalesced "agent activity" card.
   *
   * Trigger: a `run_in_background` Bash command (or other deferred tool)
   * settled, causing the SDK to inject a `<task-notification>` user message;
   * the persistent executor's consumeLoop classified that burst as
   * `continuation` and emitted this handle. Semantically the burst is the
   * main agent continuing its work, so it should look like a normal reply.
   *
   * Lifecycle:
   *   - send initial thinking card
   *   - stream the handle, updating the card on each delta via RateLimiter
   *   - finalize via sendFinalCard once a `result` arrives (or the executor
   *     is torn down — abort flips the card to error)
   *
   * Concurrency:
   *   - tracked in {@link continuationTasks} (NOT {@link runningTasks}), so
   *     a user message arriving mid-continuation still queues / runs via
   *     the normal executeQuery path — the two render side-by-side as
   *     separate cards.
   *   - at most one continuation card per chatId at a time; if one is
   *     already in flight, the second arrival is logged and dropped (the
   *     SDK opens one continuation turn per task-notification burst, so
   *     overlap is unusual but possible if two background tasks settle
   *     simultaneously — we accept dropping the second card's chrome since
   *     the active card's stream still receives that burst's messages).
   */
  private async handleContinuationTurn(chatId: string, handle: ExecutionHandle): Promise<void> {
    if (this.continuationTasks.has(chatId)) {
      // Rare but possible — log and drain silently so the SDK turn still
      // terminates. The visible signal is already on the in-flight card.
      this.logger.warn({ chatId }, 'MessageBridge: continuation turn already in flight — draining new handle');
      try {
        for await (const _msg of handle.stream) {
          // drop
        }
      } catch (err) {
        this.logger.debug({ err, chatId }, 'MessageBridge: drained extra continuation handle');
      }
      return;
    }

    const displayPrompt = '(agent continuation: background task return)';
    const processor = new StreamProcessor(displayPrompt);
    const rateLimiter = new RateLimiter(1500);
    const abortController = new AbortController();
    const session = this.sessionManager.getSession(chatId);
    const activeGoal = session.activeGoal;

    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
      goalCondition: activeGoal,
    };

    const messageId = await this.sender.sendCard(chatId, initialState);
    if (!messageId) {
      this.logger.warn({ chatId }, 'MessageBridge: failed to send continuation initial card');
      // Drain stream so the SDK turn still completes cleanly
      try { for await (const _msg of handle.stream) { /* drop */ } } catch { /* ignore */ }
      try { handle.finish(); } catch { /* ignore */ }
      return;
    }

    this.continuationTasks.set(chatId, {
      abortController,
      cardMessageId: messageId,
      turnId: (handle as unknown as { turnId?: string }).turnId ?? 'continuation',
    });
    this.logger.info({ chatId, messageId }, 'MessageBridge: continuation card opened');

    let lastState: CardState = initialState;
    const outputsDir = this.outputsManager.prepareDir(chatId);
    // Set of pending AskUserQuestion toolUseIds we've already surfaced on
    // this stream — prevents re-sending the question card on every delta
    // while the same question is still waiting for an answer.
    const surfacedQuestionIds = new Set<string>();

    try {
      for await (const message of handle.stream) {
        if (abortController.signal.aborted) break;
        const state = processor.processMessage(message);
        if (activeGoal) state.goalCondition = activeGoal;
        lastState = state;

        // AskUserQuestion during a continuation turn: route through the
        // same standalone-question-card path used between turns. The
        // continuation stream stays open (the SDK hook is awaiting
        // resolveQuestion) — we just surface the question on its own card
        // and replace the in-card response with a pointer note. When the
        // user replies, handleMessage routes the answer via
        // tryHandleBetweenTurnQuestionReply → executor.resolveQuestion,
        // which unblocks the hook and the continuation stream continues.
        if (state.status === 'waiting_for_input' && state.pendingQuestion) {
          const q = state.pendingQuestion;
          if (!surfacedQuestionIds.has(q.toolUseId)) {
            surfacedQuestionIds.add(q.toolUseId);
            await rateLimiter.flush();
            // Main card pointer note, mirroring runOneTurn's runtime hint.
            const hint = '_Waiting for your answer to the question card below…_';
            const hintedState: CardState = {
              ...state,
              pendingQuestion: undefined,
              responseText: state.responseText
                ? state.responseText + '\n\n' + hint
                : hint,
            };
            try {
              await this.sender.updateCard(messageId, hintedState);
            } catch (err) {
              this.logger.warn({ err, chatId }, 'MessageBridge: continuation hint update failed');
            }
            // Surface the question on its own card via the shared between-
            // turn pipeline. Re-uses pendingBetweenTurnQuestions bookkeeping
            // so handleMessage's reply-interception path Just Works.
            await this.handleBetweenTurnQuestion(chatId, {
              toolUseId: q.toolUseId,
              questions: q.questions,
            });
          }
          continue;
        }

        if (state.status === 'complete' || state.status === 'error') break;
        rateLimiter.schedule(() => {
          if (!abortController.signal.aborted) {
            this.sender.updateCard(messageId, state);
          }
        });
      }
      await rateLimiter.cancelAndWait();

      if (lastState.status !== 'complete' && lastState.status !== 'error') {
        if (abortController.signal.aborted) {
          lastState = { ...lastState, status: 'error', errorMessage: 'Continuation interrupted (executor released)' };
        } else if (lastState.responseText) {
          lastState = { ...lastState, status: 'complete' };
        } else {
          lastState = { ...lastState, status: 'error', errorMessage: 'Continuation ended unexpectedly' };
        }
      }

      await this.sendFinalCard(messageId, lastState, chatId);
      // Intentionally NO sendCompletionNotice here. Continuation turns are
      // between-turn agent activity the user didn't initiate — the card
      // itself (blue → green lifecycle, complete with timestamps in the
      // footer) is enough signal. A separate "✅ Done" push for every
      // background-task return would be noise; the user only opted into
      // pushes for the work they explicitly asked for.
      // Output files still get sent — agent may have produced artifacts
      // in the bash background task whose summary triggered this.
      await this.outputHandler.sendOutputFiles(chatId, outputsDir, processor, lastState);
    } catch (err: any) {
      this.logger.error({ err, chatId }, 'MessageBridge: continuation stream errored');
      const errorState: CardState = {
        ...lastState,
        status: 'error',
        errorMessage: err?.message || 'Continuation failed',
      };
      try { await rateLimiter.cancelAndWait(); } catch { /* ignore */ }
      try { await this.sendFinalCard(messageId, errorState, chatId); } catch { /* ignore */ }
    } finally {
      try { handle.finish(); } catch { /* ignore */ }
      if (this.continuationTasks.get(chatId)?.cardMessageId === messageId) {
        this.continuationTasks.delete(chatId);
      }
      try { this.outputsManager.cleanup(outputsDir); } catch { /* ignore */ }
    }
  }

  /**
   * Get the registry if persistent mode is enabled AND the registry has
   * already been created. Used for read-only inspection (e.g. observability).
   */
  getPersistentRegistry(): ExecutorRegistry | null {
    return this.persistentRegistry;
  }

  /**
   * Shut down all persistent executors. Called on bot shutdown so the
   * underlying Claude processes (and any teammates) terminate cleanly.
   */
  async shutdownPersistentExecutors(reason: string = 'bot-shutdown'): Promise<void> {
    if (this.persistentRegistry) {
      await this.persistentRegistry.shutdownAll(reason);
    }
  }

  /**
   * Stage 3b — release a single chat's persistent executor (graceful
   * shutdown + remove from pool). Used by /reset to discard any teammates
   * / background tasks tied to the old session before starting fresh.
   * No-op if persistent mode is off or chat has no executor.
   */
  async releaseChatExecutor(chatId: string, reason: string = 'reset'): Promise<void> {
    if (!this.persistentRegistry) return;
    await this.persistentRegistry.release(chatId, reason);
  }

  /**
   * Start one Claude turn for a chat, honouring the persistent-executor flag.
   *
   * This is the **single chokepoint** for spawning a turn — initial-turn paths
   * AND every retry path (stale-session / context-overflow / catch) must call
   * this method. Previously, the 5 retry sites bypassed
   * {@link getOrCreateRegistry} and went straight to {@link executorForChat}
   * even in persistent mode. The result: the persistent process kept running
   * with its stale resume-sessionId mapping while the user's new turn happened
   * in a separate one-off subprocess. Teammates / /goal / /background that
   * were the whole point of Stage 4 quietly disappeared mid-conversation.
   *
   * Per-turn options that the persistent executor cannot rebind (`maxTurns`,
   * `allowedTools`) automatically fall back to the legacy spawn path here so
   * callers don't have to think about it.
   *
   * When `freshSession: true`, in persistent mode we explicitly release the
   * current executor first — its `start()` was bound to the now-stale
   * sessionId, so `acquire()` would otherwise hand back the same broken
   * instance.
   */
  private async runOneTurn(
    chatId: string,
    engineName: EngineName,
    opts: {
      prompt: string;
      cwd: string;
      abortController: AbortController;
      outputsDir: string;
      apiContext?: ApiContext;
      model?: string;
      onTeamEvent?: (event: TeamEvent) => void;
      maxTurns?: number;
      allowedTools?: string[];
      freshSession?: boolean;
    },
  ): Promise<ExecutionHandle> {
    const session = this.sessionManager.getSession(chatId);
    // Persistent only applies to Claude. Options that need per-turn binding
    // (maxTurns / allowedTools) aren't plumbed through the persistent path yet,
    // so fall back to legacy spawn when they're present — matches the gating
    // that {@link executeApiTask} previously did inline.
    const usePersistent =
      this.isPersistentExecutorEnabled() &&
      engineName === 'claude' &&
      opts.maxTurns === undefined &&
      opts.allowedTools === undefined;

    if (usePersistent) {
      if (opts.freshSession) {
        try {
          await this.releaseChatExecutor(chatId, 'retry-fresh-session');
        } catch (err) {
          this.logger.warn({ err, chatId }, 'runOneTurn: failed to release persistent executor before retry');
        }
      }
      const exec = await this.getOrCreateRegistry().acquire(chatId, {
        cwd: opts.cwd,
        resumeSessionId: opts.freshSession ? undefined : session.sessionId,
        onTeamEvent: opts.onTeamEvent,
        model: opts.model,
        apiContext: opts.apiContext,
        outputsDir: opts.outputsDir,
      });
      // TurnHandle is structurally compatible with ExecutionHandle (stream,
      // sendAnswer, resolveQuestion, finish) — see persistent-executor.ts.
      return exec.nextTurn(opts.prompt) as unknown as ExecutionHandle;
    }

    return this.executorForChat(chatId).startExecution({
      prompt: opts.prompt,
      cwd: opts.cwd,
      sessionId: opts.freshSession ? undefined : session.sessionId,
      abortController: opts.abortController,
      outputsDir: opts.outputsDir,
      apiContext: opts.apiContext,
      model: opts.model,
      onTeamEvent: opts.onTeamEvent,
      maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools,
    });
  }

  /**
   * Apply a single Agent Teams hook event to the running task's team state,
   * creating it on first event. Returns true if the snapshot changed (so the
   * caller can schedule a card re-render).
   */
  private applyTeamEvent(task: RunningTask, event: TeamEvent): boolean {
    if (!task.teamState) {
      task.teamState = { teammates: [], tasks: [] };
    }
    const state = task.teamState;
    const teamName = (event as { teamName?: string }).teamName;
    if (teamName && !state.name) state.name = teamName;

    const upsertMember = (name: string, status: TeamMember['status'], lastSubject?: string) => {
      const existing = state.teammates.find(m => m.name === name);
      if (existing) {
        existing.status = status;
        if (lastSubject) existing.lastSubject = lastSubject;
      } else {
        state.teammates.push({ name, status, lastSubject });
      }
    };

    const upsertTask = (taskId: string, patch: Partial<TeamTask>) => {
      const existing = state.tasks.find(t => t.taskId === taskId);
      if (existing) {
        Object.assign(existing, patch);
      } else {
        state.tasks.push({
          taskId,
          subject: patch.subject ?? '(untitled)',
          status: patch.status ?? 'in_progress',
          teammate: patch.teammate,
        });
      }
    };

    if (event.kind === 'task_created') {
      upsertTask(event.taskId, {
        subject: event.subject,
        status: 'in_progress',
        teammate: event.teammate,
      });
      if (event.teammate) upsertMember(event.teammate, 'working', event.subject);
    } else if (event.kind === 'task_completed') {
      upsertTask(event.taskId, {
        subject: event.subject,
        status: 'completed',
        teammate: event.teammate,
      });
      // Don't flip teammate to idle here — the TeammateIdle hook is the
      // authoritative signal; teammates may pick up the next task immediately.
    } else if (event.kind === 'teammate_idle') {
      upsertMember(event.teammate, 'idle');
    }
    return true;
  }

  /**
   * Mirror Claude /goal state into our SessionManager so the Feishu card
   * can display a persistent "🎯 Goal" badge across turns. The actual goal
   * mechanism (multi-turn loop with fast-model evaluator) runs inside Claude
   * Code via a session-scoped Stop hook — we only mirror the condition text.
   *
   * Recognized inputs:
   *   /goal                            → status query (no mutation)
   *   /goal <condition>                → set goal
   *   /goal clear|stop|off|reset|none|cancel
   *                                    → clear goal (per Claude docs aliases)
   */
  private mirrorGoalCommand(chatId: string, text: string): void {
    const trimmed = text.trim();
    if (!/^\/goal(\s|$)/i.test(trimmed)) return;
    const rest = trimmed.replace(/^\/goal\s*/i, '').trim();
    if (!rest) return; // status query — leave existing goal alone
    const lowered = rest.toLowerCase();
    if (['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(lowered)) {
      this.sessionManager.setGoal(chatId, undefined);
      return;
    }
    this.sessionManager.setGoal(chatId, rest);
  }

  private processQueue(chatId: string): void {
    const queue = this.messageQueues.get(chatId);
    if (!queue || queue.length === 0) {
      this.messageQueues.delete(chatId);
      return;
    }
    const next = queue.shift()!;
    if (queue.length === 0) {
      this.messageQueues.delete(chatId);
    }
    this.executeQuery(next).catch((err) => {
      this.logger.error({ err, chatId }, 'Error processing queued message');
    });
  }

  /**
   * Handle a user click on an interactive card button (currently only used for
   * AskUserQuestion answer buttons). The click is converted into the same
   * synthetic reply that a numeric text-reply would produce, then handed to
   * handleAnswer so both paths go through the exact same flow.
   */
  async handleCardAction(event: {
    chatId: string;
    userId: string;
    messageId: string;
    value: Record<string, unknown>;
  }): Promise<void> {
    const { chatId, userId, messageId, value } = event;
    const task = this.runningTasks.get(chatId);
    if (!task || !task.pendingQuestion) {
      this.logger.debug({ chatId, userId }, 'Card action but no pending question — ignoring');
      return;
    }
    if (value.action !== 'answer_question') {
      this.logger.debug({ chatId, action: value.action }, 'Unknown card action — ignoring');
      return;
    }
    if (value.toolUseId !== task.pendingQuestion.toolUseId) {
      this.logger.warn(
        { chatId, expected: task.pendingQuestion.toolUseId, got: value.toolUseId },
        'Card action targets a stale question — ignoring',
      );
      return;
    }
    const optionIndex =
      typeof value.optionIndex === 'number' ? value.optionIndex : -1;
    const currentQ = task.pendingQuestion.questions[task.currentQuestionIndex];
    if (!currentQ || optionIndex < 0 || optionIndex >= currentQ.options.length) {
      this.logger.warn({ chatId, optionIndex }, 'Card action has invalid optionIndex — ignoring');
      return;
    }
    const syntheticMsg: IncomingMessage = {
      messageId,
      chatId,
      chatType: 'card_action',
      userId,
      text: String(optionIndex + 1),
    };
    await this.handleAnswer(syntheticMsg, task);
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { chatId, text } = msg;

    // Handle commands (always allowed, even during pending questions)
    if (text.startsWith('/')) {
      const handled = await this.commandHandler.handle(msg);
      if (handled) return;

      // Mirror /goal state locally so the card can show a persistent badge
      // across turns. The actual goal mechanism still runs inside Claude Code.
      this.mirrorGoalCommand(chatId, text);

      // Unrecognized /xxx command — pass through to Claude
      if (this.runningTasks.has(chatId)) {
        await this.sender.sendTextNotice(
          chatId,
          '⏳ Task In Progress',
          'You have a running task. Use `/stop` to abort it, or wait for it to finish.',
          'orange',
        );
        return;
      }
      await this.executeQuery(msg);
      return;
    }

    // Between-turn AskUserQuestion reply — must run BEFORE the
    // running-task / queue branches below, because no `runningTasks` entry
    // exists for between-turn questions (they fire from the persistent
    // executor outside of any user-initiated turn). If we let the message
    // fall through, it would spawn a fresh turn that immediately blocks on
    // the still-hanging hook for 6 minutes. See:
    // [[bug_feishu_v2_mobile_action_buttons]] history and
    // PersistentClaudeExecutor.askUserQuestionHook.
    if (await this.tryHandleBetweenTurnQuestionReply(msg)) {
      return;
    }

    // Check if there's a pending question waiting for an answer
    const task = this.runningTasks.get(chatId);
    if (task && task.pendingQuestion) {
      await this.handleAnswer(msg, task);
      return;
    }

    // If a task is running, queue the message instead of rejecting
    if (this.runningTasks.has(chatId)) {
      // If there's a pending batch and this is a text message, merge batch into the queued text
      const batch = this.pendingBatches.get(chatId);
      if (batch && !this.isDefaultMediaText(msg)) {
        clearTimeout(batch.timerId);
        this.pendingBatches.delete(chatId);
        const merged = this.mergeBatchWithText(batch.messages, msg);
        msg = merged;
      } else if (batch && this.isDefaultMediaText(msg)) {
        // Another media message while task is running — just add to batch
        batch.messages.push(msg);
        clearTimeout(batch.timerId);
        batch.timerId = setTimeout(() => this.flushBatch(chatId), BATCH_DEBOUNCE_MS);
        return;
      }

      const queue = this.messageQueues.get(chatId) || [];
      if (queue.length >= MAX_QUEUE_SIZE) {
        await this.sender.sendTextNotice(
          chatId,
          '⏳ Queue Full',
          `Queue is full (${MAX_QUEUE_SIZE} pending). Use \`/stop\` to abort the current task, or wait.`,
          'orange',
        );
        return;
      }
      queue.push(msg);
      this.messageQueues.set(chatId, queue);
      this.audit.log({ event: 'task_queued', botName: this.config.name, chatId, userId: msg.userId, prompt: msg.text, meta: { position: queue.length } });
      await this.sender.sendTextNotice(
        chatId,
        '📋 Queued',
        `Your message has been queued (position #${queue.length}). It will run after the current task finishes.`,
        'blue',
      );
      return;
    }

    // Smart debounce: batch media-only messages, execute text immediately
    const isMediaOnly = this.isDefaultMediaText(msg);
    const batch = this.pendingBatches.get(chatId);

    if (isMediaOnly) {
      // Media message: add to batch and wait for more
      if (batch) {
        batch.messages.push(msg);
        clearTimeout(batch.timerId);
        batch.timerId = setTimeout(() => this.flushBatch(chatId), BATCH_DEBOUNCE_MS);
      } else {
        const timerId = setTimeout(() => this.flushBatch(chatId), BATCH_DEBOUNCE_MS);
        this.pendingBatches.set(chatId, { messages: [msg], timerId });
      }
      this.logger.info({ chatId, imageKey: msg.imageKey, fileKey: msg.fileKey }, 'Media message batched, waiting for more');
      return;
    }

    // Text message: if pending batch exists, merge and execute immediately
    if (batch) {
      clearTimeout(batch.timerId);
      this.pendingBatches.delete(chatId);
      const merged = this.mergeBatchWithText(batch.messages, msg);
      this.logger.info({ chatId, batchSize: batch.messages.length }, 'Flushing media batch with text message');
      await this.executeQuery(merged);
      return;
    }

    // Plain text, no batch: execute immediately (original behavior)
    await this.executeQuery(msg);
  }

  private async handleAnswer(msg: IncomingMessage, task: RunningTask): Promise<void> {
    const { chatId, text, imageKey } = msg;
    const pending = task.pendingQuestion!;

    if (imageKey) {
      await this.sender.sendText(chatId, '请用文字回复选择，或直接输入自定义答案。');
      return;
    }

    const trimmed = text.trim();
    const currentQuestion = pending.questions[task.currentQuestionIndex];
    if (!currentQuestion) return;

    // Parse answer for the current question
    let answerText: string;
    const num = parseInt(trimmed, 10);
    if (num >= 1 && num <= currentQuestion.options.length) {
      answerText = currentQuestion.options[num - 1].label;
    } else {
      answerText = trimmed;
    }

    // Store answer for this question
    task.collectedAnswers[currentQuestion.header] = answerText;

    this.logger.info(
      { chatId, answer: answerText, questionIndex: task.currentQuestionIndex, total: pending.questions.length, toolUseId: pending.toolUseId },
      'User answered question',
    );

    // Helper: render the dedicated question card. The question card lives
    // independent of the main streaming card (Feishu v1 vs v2 schemas can't
    // patch each other), so all answer-stage rendering goes through this
    // path, not updateCard. Stays minimal: just header + question + buttons.
    //
    // Bind `this.sender` on both the question-card path AND the fallback,
    // otherwise calling the plucked method later loses its `this` and the
    // inner `this.sender.sendCard(...)` blows up with "Cannot read
    // properties of undefined (reading 'sender')".
    const updateQ = async (qState: CardState): Promise<void> => {
      if (!task.questionCardMessageId) return;
      const upd = this.sender.updateQuestionCard
        ? this.sender.updateQuestionCard.bind(this.sender)
        : this.sender.updateCard.bind(this.sender);
      await upd(task.questionCardMessageId, qState);
    };
    const sendQ = async (qState: CardState): Promise<string | undefined> => {
      const fn = this.sender.sendQuestionCard
        ? this.sender.sendQuestionCard.bind(this.sender)
        : this.sender.sendCard.bind(this.sender);
      return fn(chatId, qState);
    };

    // Check if more questions remain in this AskUserQuestion call
    if (task.currentQuestionIndex + 1 < pending.questions.length) {
      task.currentQuestionIndex++;
      // Reset question timeout for the next question
      if (task.questionTimeoutId) {
        clearTimeout(task.questionTimeoutId);
      }
      task.questionTimeoutId = setTimeout(() => {
        this.autoAnswerRemainingQuestions(task);
      }, QUESTION_TIMEOUT_MS);

      // Update the dedicated question card to the next sub-question
      const nextQ = pending.questions[task.currentQuestionIndex];
      const displayQuestion: PendingQuestion = {
        toolUseId: pending.toolUseId,
        questions: [nextQ],
      };
      const progress = `(${task.currentQuestionIndex + 1}/${pending.questions.length})`;
      await updateQ({
        status: 'waiting_for_input',
        userPrompt: `Question ${progress}`,
        responseText: `> **Reply:** ${answerText}`,
        toolCalls: [],
        pendingQuestion: displayQuestion,
      });
      return;
    }

    // All questions in this call answered — resolve the PreToolUse hook.
    // resolveQuestion returns answers as updatedInput so the SDK short-circuits
    // its own interaction prompt; sendAnswer is only a fallback for the legacy
    // tool_result path (kept inside ExecutionHandle.resolveQuestion).
    const collectedAnswers = task.collectedAnswers;

    if (task.questionTimeoutId) {
      clearTimeout(task.questionTimeoutId);
      task.questionTimeoutId = undefined;
    }
    task.pendingQuestion = null;
    task.currentQuestionIndex = 0;
    task.collectedAnswers = {};
    task.processor.clearPendingQuestion();

    // Finalize the dedicated question card — strip buttons, show what was picked.
    const answerSummary = Object.values(collectedAnswers).length > 0
      ? Object.values(collectedAnswers).join(', ')
      : answerText;
    await updateQ({
      status: 'complete',
      userPrompt: 'Question',
      responseText: `> **Reply:** ${answerSummary}`,
      toolCalls: [],
    });
    task.questionCardMessageId = undefined;

    task.executionHandle.resolveQuestion(pending.toolUseId, collectedAnswers);

    this.logger.info({ chatId, answers: collectedAnswers, toolUseId: pending.toolUseId }, 'Resolved AskUserQuestion hook with collected answers');

    // Check if there are more queued AskUserQuestion calls (back-to-back
    // AskUserQuestion tool_uses in one assistant turn). Each call gets its
    // own fresh question card.
    const nextPending = task.processor.getPendingQuestion();
    if (nextPending) {
      task.pendingQuestion = nextPending;
      task.currentQuestionIndex = 0;
      task.collectedAnswers = {};

      const displayQuestion: PendingQuestion = {
        toolUseId: nextPending.toolUseId,
        questions: [nextPending.questions[0]],
      };
      const progress = nextPending.questions.length > 1 ? ` (1/${nextPending.questions.length})` : '';
      task.questionTimeoutId = setTimeout(() => {
        this.autoAnswerRemainingQuestions(task);
      }, QUESTION_TIMEOUT_MS);

      const newQId = await sendQ({
        status: 'waiting_for_input',
        userPrompt: progress ? `Question${progress}` : 'Question',
        responseText: '',
        toolCalls: [],
        pendingQuestion: displayQuestion,
      });
      if (newQId) task.questionCardMessageId = newQId;
      return;
    }

    // No more questions — bump the main streaming card so it visibly resumes.
    const currentState = task.processor.getCurrentState();
    await this.sender.updateCard(task.cardMessageId, {
      ...currentState,
      status: 'running',
      responseText: currentState.responseText
        ? currentState.responseText + `\n\n> **Reply:** ${answerSummary}\n\n_Continuing..._`
        : `> **Reply:** ${answerSummary}\n\n_Continuing..._`,
    });
  }

  /** Auto-answer remaining questions when timeout fires. */
  private autoAnswerRemainingQuestions(task: RunningTask): void {
    const pending = task.pendingQuestion;
    if (!pending) return;

    this.logger.warn({ chatId: task.chatId, toolUseId: pending.toolUseId }, 'Question timeout, auto-answering remaining questions');

    // Fill remaining unanswered questions with timeout message
    for (let i = task.currentQuestionIndex; i < pending.questions.length; i++) {
      const q = pending.questions[i];
      if (!task.collectedAnswers[q.header]) {
        task.collectedAnswers[q.header] = '用户未及时回复，请自行判断继续';
      }
    }

    const collectedAnswers = task.collectedAnswers;
    task.pendingQuestion = null;
    task.currentQuestionIndex = 0;
    task.collectedAnswers = {};
    task.processor.clearPendingQuestion();

    // Finalize the dedicated question card to "(timed out)" — fire-and-forget,
    // resolveQuestion below doesn't depend on this completing.
    if (task.questionCardMessageId) {
      const upd = this.sender.updateQuestionCard
        ? this.sender.updateQuestionCard.bind(this.sender)
        : this.sender.updateCard.bind(this.sender);
      void upd(task.questionCardMessageId, {
        status: 'error',
        userPrompt: 'Question',
        responseText: '_用户未及时回复，已自动跳过_',
        toolCalls: [],
        errorMessage: 'Timed out waiting for answer',
      });
      task.questionCardMessageId = undefined;
    }

    task.executionHandle.resolveQuestion(pending.toolUseId, collectedAnswers);
  }

  /** Check if message is a media message with default (auto-generated) text. */
  private isDefaultMediaText(msg: IncomingMessage): boolean {
    return (!!msg.imageKey && msg.text === DEFAULT_IMAGE_TEXT)
        || (!!msg.fileKey && msg.text === DEFAULT_FILE_TEXT);
  }

  /** Timer expired: merge batched media messages and execute. */
  private flushBatch(chatId: string): void {
    const batch = this.pendingBatches.get(chatId);
    if (!batch) return;
    this.pendingBatches.delete(chatId);

    const merged = this.mergeBatchMessages(batch.messages);
    this.logger.info({ chatId, batchSize: batch.messages.length }, 'Flushing media batch (timeout)');

    // If a task started running during the debounce window, queue instead
    if (this.runningTasks.has(chatId)) {
      const queue = this.messageQueues.get(chatId) || [];
      if (queue.length < MAX_QUEUE_SIZE) {
        queue.push(merged);
        this.messageQueues.set(chatId, queue);
        this.sender.sendTextNotice(chatId, '📋 Queued', `Your ${batch.messages.length} media message(s) have been queued.`, 'blue')
          .catch(() => {});
      }
      return;
    }

    this.executeQuery(merged).catch(err => {
      this.logger.error({ err, chatId }, 'Error executing batched messages');
    });
  }

  /** Merge multiple media-only messages into one (no user text). */
  private mergeBatchMessages(messages: IncomingMessage[]): IncomingMessage {
    const first = messages[0];
    if (messages.length === 1) return first;

    const imageCount = messages.filter(m => m.imageKey).length;
    const fileCount = messages.filter(m => m.fileKey).length;
    const parts: string[] = [];
    if (imageCount > 0) parts.push(`${imageCount}张图片`);
    if (fileCount > 0) parts.push(`${fileCount}个文件`);

    return {
      ...first,
      text: `请分析这些${parts.join('和')}`,
      extraMedia: messages.slice(1).map(m => ({
        messageId: m.messageId,
        imageKey: m.imageKey,
        fileKey: m.fileKey,
        fileName: m.fileName,
      })),
    };
  }

  /** Merge batched media messages with a user text message. */
  private mergeBatchWithText(batchMsgs: IncomingMessage[], textMsg: IncomingMessage): IncomingMessage {
    return {
      ...textMsg,
      extraMedia: batchMsgs.map(m => ({
        messageId: m.messageId,
        imageKey: m.imageKey,
        fileKey: m.fileKey,
        fileName: m.fileName,
      })),
    };
  }

  private async executeQuery(msg: IncomingMessage): Promise<void> {
    const { userId, chatId, text, imageKey, fileKey, fileName, messageId: msgId } = msg;
    const { session, engineName } = this.prepareSessionForExecution(chatId);
    const cwd = session.workingDirectory;
    const abortController = new AbortController();
    const activeEngine = session.engine ?? resolveEngineName(this.config);
    const enginePromptText = normalizePromptForEngine(text, activeEngine);

    // Prepare downloads directory (bot-isolated)
    const downloadsDir = this.config.claude.downloadsDir;
    fs.mkdirSync(downloadsDir, { recursive: true });

    // Handle image download if present
    let prompt = enginePromptText;
    let imagePath: string | undefined;
    let filePath: string | undefined;
    if (imageKey) {
      imagePath = path.join(downloadsDir, `${imageKey}.png`);
      const ok = await this.sender.downloadImage(msgId, imageKey, imagePath);
      if (ok) {
        prompt = `${enginePromptText}\n\n[Image saved at: ${imagePath}]\nPlease use the Read tool to read and analyze this image file.`;
      } else {
        prompt = `${enginePromptText}\n\n(Note: Failed to download the image)`;
      }
    }

    // Handle file download if present
    if (fileKey && fileName) {
      filePath = path.join(downloadsDir, `${fileKey}_${fileName}`);
      const ok = await this.sender.downloadFile(msgId, fileKey, filePath);
      if (ok) {
        prompt = `${enginePromptText}\n\n[File saved at: ${filePath}]\nPlease use the Read tool (for text/code files, images, PDFs) or Bash tool (for other formats) to read and analyze this file.`;
      } else {
        prompt = `${enginePromptText}\n\n(Note: Failed to download the file)`;
      }
    }

    // Handle extra media from batched messages
    const extraPaths: string[] = [];
    if (msg.extraMedia && msg.extraMedia.length > 0) {
      for (const media of msg.extraMedia) {
        if (media.imageKey) {
          const p = path.join(downloadsDir, `${media.imageKey}.png`);
          const ok = await this.sender.downloadImage(media.messageId, media.imageKey, p);
          if (ok) {
            extraPaths.push(p);
            prompt += `\n[Image saved at: ${p}]`;
          }
        }
        if (media.fileKey && media.fileName) {
          const p = path.join(downloadsDir, `${media.fileKey}_${media.fileName}`);
          const ok = await this.sender.downloadFile(media.messageId, media.fileKey, p);
          if (ok) {
            extraPaths.push(p);
            prompt += `\n[File saved at: ${p}]`;
          }
        }
      }
      if (extraPaths.length > 0) {
        prompt += '\nPlease use the Read tool to analyze all the above files.';
      }
    }

    // Prepare per-chat outputs directory
    const outputsDir = this.outputsManager.prepareDir(chatId);

    // Send initial "thinking" card
    const mediaCount = 1 + (msg.extraMedia?.length || 0);
    const hasMedia = imageKey || fileKey;
    const displayPrompt = hasMedia && mediaCount > 1
      ? `🖼️ [${mediaCount} files] ${text}`
      : fileKey ? '📎 ' + text : imageKey ? '🖼️ ' + text : text;
    const processor = new StreamProcessor(displayPrompt);
    // Capture mirrored goal once at task start. New /goal messages can't
    // arrive mid-task (handleMessage rejects them with "Task In Progress"),
    // so this stays stable for the whole run.
    const activeGoal = session.activeGoal;
    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
      goalCondition: activeGoal,
    };

    const messageId = await this.sender.sendCard(chatId, initialState);

    if (!messageId) {
      this.logger.error('Failed to send initial card, aborting');
      return;
    }

    const apiContext = { botName: this.config.name, chatId };

    const rateLimiter = new RateLimiter(1500);

    // Forward-declare runningTask so the team-event callback can read it
    // before the assignment below — hooks fire from the spawned Claude
    // process at arbitrary points, not at construction time. Only assigned
    // once; `let` is required because `const` cannot be uninitialised.
    // eslint-disable-next-line prefer-const
    let runningTask: RunningTask;

    const onTeamEvent = (event: TeamEvent) => {
      if (!runningTask) return;
      const changed = this.applyTeamEvent(runningTask, event);
      if (changed && !abortController.signal.aborted) {
        rateLimiter.schedule(() => {
          if (!abortController.signal.aborted) {
            this.sender.updateCard(messageId, {
              ...processor.getCurrentState(),
              goalCondition: activeGoal,
              teamState: runningTask.teamState,
            });
          }
        });
      }
    };

    // All turn-starting paths (initial + retry) route through runOneTurn so
    // persistent mode is enforced consistently and stale-session retries
    // properly release the bound executor before reacquiring.
    const executionHandle = await this.runOneTurn(chatId, engineName, {
      prompt,
      cwd,
      abortController,
      outputsDir,
      apiContext,
      model: session.model,
      onTeamEvent,
    });

    // Register running task
    const startTime = Date.now();
    runningTask = {
      abortController,
      startTime,
      executionHandle,
      pendingQuestion: null,
      currentQuestionIndex: 0,
      collectedAnswers: {},
      cardMessageId: messageId,
      processor,
      rateLimiter,
      chatId,
    };
    this.runningTasks.set(chatId, runningTask);
    metrics.setGauge('metabot_active_tasks', this.runningTasks.size);

    this.audit.log({ event: 'task_start', botName: this.config.name, chatId, userId, prompt: text });
    this.emitActivity({ type: 'task_started', botName: this.config.name, chatId, userId, prompt: text?.slice(0, 200), timestamp: startTime });

    // Setup timeout
    let timedOut = false;
    let idledOut = false;
    const timeoutId = setTimeout(() => {
      this.logger.warn({ chatId, userId }, 'Task timeout, aborting');
      timedOut = true;
      executionHandle.finish();
      abortController.abort();
    }, TASK_TIMEOUT_MS);

    // Idle detection: reset timer on every stream message
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        this.logger.warn({ chatId, userId }, 'Task idle timeout (1h no stream), aborting');
        idledOut = true;
        executionHandle.finish();
        abortController.abort();
      }, IDLE_TIMEOUT_MS);
    };
    resetIdleTimer();

    let lastState: CardState = initialState;

    try {
      for await (const message of executionHandle.stream) {
        if (abortController.signal.aborted) break;
        resetIdleTimer();

        const state = processor.processMessage(message);
        if (activeGoal) state.goalCondition = activeGoal;
        if (runningTask.teamState) state.teamState = runningTask.teamState;
        lastState = state;

        // Update session ID if discovered
        const newSessionId = processor.getSessionId();
        if (newSessionId && (newSessionId !== session.sessionId || session.sessionIdEngine !== engineName)) {
          this.sessionManager.setSessionId(chatId, newSessionId, engineName);
        }

        // Check if we hit a waiting_for_input state
        if (state.status === 'waiting_for_input' && state.pendingQuestion) {
          // Only initialize tracking when we see a NEW question call (different toolUseId).
          // Multi-question calls (same toolUseId, advance currentQuestionIndex) reuse the
          // already-sent question card via updateQuestionCard below.
          const isNewQuestionCall =
            !runningTask.pendingQuestion ||
            runningTask.pendingQuestion.toolUseId !== state.pendingQuestion.toolUseId;
          if (isNewQuestionCall) {
            runningTask.pendingQuestion = state.pendingQuestion;
            runningTask.currentQuestionIndex = 0;
            runningTask.collectedAnswers = {};
            runningTask.questionCardMessageId = undefined; // a fresh question card will be sent
          }

          await rateLimiter.flush();

          // Non-null after the isNewQuestionCall branch assigned it (or it was already set)
          const pending = runningTask.pendingQuestion!;
          const currentQ = pending.questions[runningTask.currentQuestionIndex];
          const displayQuestion: PendingQuestion = {
            toolUseId: pending.toolUseId,
            questions: currentQ ? [currentQ] : pending.questions,
          };
          const progress = pending.questions.length > 1
            ? ` (${runningTask.currentQuestionIndex + 1}/${pending.questions.length})`
            : '';

          // 1) Update the MAIN streaming card without the pendingQuestion field,
          //    so it stays clean v2 (Feishu refuses to patch v2 ↔ v1, and v2
          //    mobile silently drops the button block anyway). Show only a
          //    pointer note in the response so the user knows where to look.
          const mainCardHint = progress
            ? `_Waiting for your answer to the question card${progress} below…_`
            : '_Waiting for your answer to the question card below…_';
          await this.sender.updateCard(messageId, {
            ...state,
            pendingQuestion: undefined,
            responseText: state.responseText
              ? state.responseText + '\n\n' + mainCardHint
              : mainCardHint,
          });

          // 2) Send / update a DEDICATED question card (v1 on Feishu) — this is
          //    where the option buttons live. See memory:
          //    bug-feishu-v2-mobile-action-buttons.
          const questionCardState: CardState = {
            status: 'waiting_for_input',
            userPrompt: progress ? `Question${progress}` : 'Question',
            responseText: '',
            toolCalls: [],
            pendingQuestion: displayQuestion,
          };
          if (runningTask.questionCardMessageId && this.sender.updateQuestionCard) {
            await this.sender.updateQuestionCard(runningTask.questionCardMessageId, questionCardState);
          } else {
            // Bind explicitly — `this.sender.sendQuestionCard ?? ...bind(...)`
            // would pluck the method off without `this`, and calling it
            // later throws "Cannot read properties of undefined (reading
            // 'sender')" inside the Feishu adapter.
            const sendQ = this.sender.sendQuestionCard
              ? this.sender.sendQuestionCard.bind(this.sender)
              : this.sender.sendCard.bind(this.sender);
            const qMsgId = await sendQ(chatId, questionCardState);
            if (qMsgId) {
              runningTask.questionCardMessageId = qMsgId;
            } else {
              // Sender refused. Fall back to the legacy in-card render so the
              // user still sees the question (even if mobile renders without
              // buttons — text fallback "type the number" still works).
              this.logger.warn({ chatId }, 'sendQuestionCard returned no messageId; falling back to inline render');
              await this.sender.updateCard(messageId, {
                ...state,
                pendingQuestion: displayQuestion,
                responseText: progress
                  ? (state.responseText || '') + (state.responseText ? '\n\n' : '') + `_Question${progress}_`
                  : state.responseText,
              });
            }
          }

          // Set/reset timeout for auto-answer
          if (runningTask.questionTimeoutId) {
            clearTimeout(runningTask.questionTimeoutId);
          }
          runningTask.questionTimeoutId = setTimeout(() => {
            this.autoAnswerRemainingQuestions(runningTask);
          }, QUESTION_TIMEOUT_MS);

          continue;
        }

        // Detect SDK-handled tools for side effects (plan content display).
        // Do NOT call sendAnswer — the SDK auto-responds in bypassPermissions mode.
        // Sending a duplicate tool_result causes API 400 errors.
        const sdkTools = processor.drainSdkHandledTools();
        for (const tool of sdkTools) {
          this.logger.info({ chatId, toolName: tool.name, toolUseId: tool.toolUseId }, 'Detected SDK-handled tool');
          if (tool.name === 'ExitPlanMode') {
            await this.sendPlanContent(chatId, processor, state);
          }
        }

        // If we just got a message after answering a question, clear timeout state
        if (runningTask.pendingQuestion === null && runningTask.questionTimeoutId) {
          clearTimeout(runningTask.questionTimeoutId);
          runningTask.questionTimeoutId = undefined;
        }

        // Break on final states
        if (state.status === 'complete' || state.status === 'error') {
          break;
        }

        // Throttled card update for non-final states (skip if aborted)
        if (!abortController.signal.aborted) {
          rateLimiter.schedule(() => {
            if (!abortController.signal.aborted) {
              this.sender.updateCard(messageId, state);
            }
          });
        }
      }

      await rateLimiter.cancelAndWait();

      // Force terminal state if stream ended without one
      if (lastState.status !== 'complete' && lastState.status !== 'error') {
        if (timedOut) {
          lastState = { ...lastState, status: 'error', errorMessage: TASK_TIMEOUT_MESSAGE };
        } else if (idledOut) {
          lastState = { ...lastState, status: 'error', errorMessage: IDLE_TIMEOUT_MESSAGE };
        } else if (abortController.signal.aborted) {
          lastState = { ...lastState, status: 'error', errorMessage: 'Task was stopped' };
        } else {
          this.logger.warn({ chatId }, 'Stream ended without result message, forcing complete state');
          lastState = {
            ...lastState,
            status: lastState.responseText ? 'complete' : 'error',
            errorMessage: lastState.responseText ? undefined : 'Claude session ended unexpectedly',
          };
        }
      }

      // Auto-retry with fresh session when Claude can't find the conversation
      if (lastState.status === 'error' && isStaleSessionError(lastState.errorMessage) && session.sessionId) {
        this.logger.info({ chatId }, 'Stale session detected, retrying with fresh session');
        this.sessionManager.resetSession(chatId);
        lastState = { ...lastState, status: 'running', errorMessage: undefined };
        await this.sender.updateCard(messageId, { ...lastState, responseText: '_Session expired, retrying..._' });

        // Retry via the shared chokepoint so the persistent executor is
        // released-then-reacquired (its start() is bound to the now-stale
        // sessionId; without release, acquire would return the same broken
        // instance).
        const retryHandle = await this.runOneTurn(chatId, engineName, {
          prompt, cwd, abortController, outputsDir, apiContext, model: session.model,
          onTeamEvent, freshSession: true,
        });
        executionHandle.finish();
        runningTask.executionHandle = retryHandle;

        for await (const message of retryHandle.stream) {
          if (abortController.signal.aborted) break;
          resetIdleTimer();
          const state = processor.processMessage(message);
          lastState = state;
          const newSid = processor.getSessionId();
          if (newSid) this.sessionManager.setSessionId(chatId, newSid, engineName);
          if (state.status === 'complete' || state.status === 'error') break;
          rateLimiter.schedule(() => { this.sender.updateCard(messageId, state); });
        }
        await rateLimiter.cancelAndWait();
      }

      // Auto-retry with fresh session on context overflow (e.g. third-party models without compaction)
      if (lastState.status === 'error' && isContextOverflowError(lastState.errorMessage) && session.sessionId) {
        this.logger.info({ chatId }, 'Context overflow detected, retrying with fresh session');
        this.sessionManager.resetSession(chatId);
        lastState = { ...lastState, status: 'running', errorMessage: undefined };
        await this.sender.updateCard(messageId, { ...lastState, responseText: '_Context limit reached, starting fresh session..._' });

        const retryHandle = await this.runOneTurn(chatId, engineName, {
          prompt, cwd, abortController, outputsDir, apiContext, model: session.model,
          onTeamEvent, freshSession: true,
        });
        executionHandle.finish();
        runningTask.executionHandle = retryHandle;

        for await (const message of retryHandle.stream) {
          if (abortController.signal.aborted) break;
          resetIdleTimer();
          const state = processor.processMessage(message);
          lastState = state;
          const newSid = processor.getSessionId();
          if (newSid) this.sessionManager.setSessionId(chatId, newSid, engineName);
          if (state.status === 'complete' || state.status === 'error') break;
          rateLimiter.schedule(() => { this.sender.updateCard(messageId, state); });
        }
        await rateLimiter.cancelAndWait();
      }

      await this.sendFinalCard(messageId, lastState, chatId);

      // Audit + cost tracking
      const durationMs = Date.now() - startTime;
      const auditEvent = timedOut ? 'task_timeout' as const
        : idledOut ? 'task_idle_timeout' as const
        : lastState.status === 'error' ? 'task_error' as const
        : 'task_complete' as const;
      this.audit.log({
        event: auditEvent,
        botName: this.config.name, chatId, userId, prompt: text,
        durationMs, costUsd: lastState.costUsd, error: lastState.errorMessage,
      });
      this.emitActivity({
        type: lastState.status === 'complete' ? 'task_completed' : 'task_failed',
        botName: this.config.name, chatId, userId, prompt: text?.slice(0, 200),
        responsePreview: lastState.responseText?.slice(0, 200),
        costUsd: lastState.costUsd, durationMs, errorMessage: lastState.errorMessage,
        timestamp: Date.now(),
      });
      this.costTracker.record({ botName: this.config.name, userId, success: lastState.status === 'complete', costUsd: lastState.costUsd, durationMs });
      metrics.incCounter('metabot_tasks_total');
      metrics.incCounter('metabot_tasks_by_status', lastState.status === 'complete' ? 'success' : 'error');
      metrics.observeHistogram('metabot_task_duration_seconds', durationMs / 1000);
      if (lastState.costUsd) metrics.observeHistogram('metabot_task_cost_usd', lastState.costUsd);

      // Record in cross-platform session registry
      this.recordSession(chatId, displayPrompt, lastState.responseText, processor.getSessionId(), lastState.costUsd, durationMs);

      // Send completion notification for long-running tasks (>10s) so user gets a Feishu push
      await this.sendCompletionNotice(chatId, lastState, durationMs);

      // Send any output files produced by Claude
      await this.outputHandler.sendOutputFiles(chatId, outputsDir, processor, lastState);
    } catch (err: any) {
      this.logger.error({ err, chatId, userId }, 'Claude execution error');

      // Auto-retry with fresh session when Claude can't find the conversation or context overflows
      const errMsg: string = err.message || '';
      if ((isStaleSessionError(errMsg) || isContextOverflowError(errMsg)) && session.sessionId) {
        const isOverflow = isContextOverflowError(errMsg);
        this.logger.info({ chatId, isOverflow }, isOverflow ? 'Context overflow in catch, retrying with fresh session' : 'Stale session detected in catch, retrying with fresh session');
        this.sessionManager.resetSession(chatId);
        const retryMsg = isOverflow ? '_Context limit reached, starting fresh session..._' : '_Session expired, retrying..._';
        await this.sender.updateCard(messageId, { ...lastState, status: 'running', responseText: retryMsg });

        try {
          const retryHandle = await this.runOneTurn(chatId, engineName, {
            prompt, cwd, abortController, outputsDir, apiContext, model: session.model,
            onTeamEvent, freshSession: true,
          });
          executionHandle.finish();
          runningTask.executionHandle = retryHandle;

          for await (const message of retryHandle.stream) {
            if (abortController.signal.aborted) break;
            resetIdleTimer();
            const state = processor.processMessage(message);
            lastState = state;
            const newSid = processor.getSessionId();
            if (newSid) this.sessionManager.setSessionId(chatId, newSid, engineName);
            if (state.status === 'complete' || state.status === 'error') break;
            rateLimiter.schedule(() => { this.sender.updateCard(messageId, state); });
          }
          await rateLimiter.cancelAndWait();
          await this.sendFinalCard(messageId, lastState, chatId);

          const durationMs = Date.now() - startTime;
          this.audit.log({
            event: lastState.status === 'error' ? 'task_error' : 'task_complete',
            botName: this.config.name, chatId, userId, prompt: text,
            durationMs, costUsd: lastState.costUsd, error: lastState.errorMessage,
          });
          this.emitActivity({
            type: lastState.status === 'complete' ? 'task_completed' : 'task_failed',
            botName: this.config.name, chatId, userId, prompt: text?.slice(0, 200),
            responsePreview: lastState.responseText?.slice(0, 200),
            costUsd: lastState.costUsd, durationMs, errorMessage: lastState.errorMessage,
            timestamp: Date.now(),
          });
          this.costTracker.record({ botName: this.config.name, userId, success: lastState.status === 'complete', costUsd: lastState.costUsd, durationMs });
          metrics.incCounter('metabot_tasks_total');
          metrics.incCounter('metabot_tasks_by_status', lastState.status === 'complete' ? 'success' : 'error');

          this.recordSession(chatId, displayPrompt, lastState.responseText, processor.getSessionId(), lastState.costUsd, durationMs);
          await this.sendCompletionNotice(chatId, lastState, durationMs);
          await this.outputHandler.sendOutputFiles(chatId, outputsDir, processor, lastState);
          return; // skip the normal error handling below
        } catch (retryErr: any) {
          this.logger.error({ err: retryErr, chatId }, 'Retry after stale session also failed');
          lastState = { ...lastState, status: 'error', errorMessage: retryErr.message || 'Retry failed' };
        }
      }

      const durationMs = Date.now() - startTime;
      this.audit.log({
        event: 'task_error', botName: this.config.name, chatId, userId, prompt: text,
        durationMs, error: err.message || 'Unknown error',
      });
      this.emitActivity({
        type: 'task_failed', botName: this.config.name, chatId, userId, prompt: text?.slice(0, 200),
        errorMessage: err.message || 'Unknown error', durationMs, timestamp: Date.now(),
      });
      this.costTracker.record({ botName: this.config.name, userId, success: false, durationMs });
      metrics.incCounter('metabot_tasks_total');
      metrics.incCounter('metabot_tasks_by_status', 'error');

      const errorState: CardState = {
        status: 'error',
        userPrompt: displayPrompt,
        responseText: lastState.responseText,
        toolCalls: lastState.toolCalls,
        errorMessage: err.message || 'Unknown error',
      };
      await rateLimiter.cancelAndWait();
      await this.sendFinalCard(messageId, errorState, chatId);
    } finally {
      clearTimeout(timeoutId);
      if (idleTimerId) clearTimeout(idleTimerId);
      if (runningTask.questionTimeoutId) {
        clearTimeout(runningTask.questionTimeoutId);
      }
      try { executionHandle.finish(); } catch (e) { this.logger.warn({ err: e, chatId }, 'Error finishing execution handle'); }
      // Only delete if this is still our task (guards against stopTask race condition)
      if (this.runningTasks.get(chatId) === runningTask) {
        this.runningTasks.delete(chatId);
        metrics.setGauge('metabot_active_tasks', this.runningTasks.size);
        this.processQueue(chatId);
      }
      if (imagePath) {
        try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
      }
      if (filePath) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
      for (const p of extraPaths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
      try { this.outputsManager.cleanup(outputsDir); } catch { /* ignore */ }
    }
  }

  async executeApiTask(options: ApiTaskOptions): Promise<ApiTaskResult> {
    const { prompt, chatId, userId = 'api', sendCards = false } = options;

    if (this.runningTasks.has(chatId)) {
      return { success: false, responseText: '', error: 'Chat is busy with another task' };
    }

    const { session, engineName } = this.prepareSessionForExecution(chatId);
    const cwd = session.workingDirectory;
    const abortController = new AbortController();

    const outputsDir = this.outputsManager.prepareDir(chatId);

    const displayPrompt = prompt;
    const processor = new StreamProcessor(displayPrompt);
    const rateLimiter = new RateLimiter(1500);
    const activeGoal = session.activeGoal;

    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
      goalCondition: activeGoal,
    };

    let messageId: string | undefined;
    if (sendCards) {
      messageId = await this.sender.sendCard(chatId, initialState);
    }

    // Generate a messageId for onUpdate even if sendCards is false
    const effectiveMessageId = messageId || `api-${chatId}-${Date.now()}`;
    options.onUpdate?.(initialState, effectiveMessageId, false);

    const apiContext = { botName: this.config.name, chatId, groupMembers: options.groupMembers, groupId: options.groupId };

    // Forward-declare for the onTeamEvent closure below (only assigned once;
    // const cannot be uninitialised — see same pattern in executeQuery).
    // eslint-disable-next-line prefer-const
    let runningTask: RunningTask;

    const onTeamEvent = (event: TeamEvent) => {
      if (!runningTask) return;
      const changed = this.applyTeamEvent(runningTask, event);
      if (changed && sendCards && messageId && !abortController.signal.aborted) {
        rateLimiter.schedule(() => {
          if (!abortController.signal.aborted) {
            this.sender.updateCard(messageId!, {
              ...processor.getCurrentState(),
              goalCondition: activeGoal,
              teamState: runningTask.teamState,
            });
          }
        });
      }
    };

    // Persistent vs legacy executor — see executeQuery for the same pattern.
    // API task path also honors the feature flag, but only for Claude engine
    // and only when no per-turn maxTurns/allowedTools overrides are supplied
    // (those mid-stream knobs are baked into the legacy executor's per-turn
    // options; persistent executor would need additional plumbing to apply
    // them per-turn — runOneTurn falls back to legacy spawn automatically
    // when those are set.
    const executionHandle = await this.runOneTurn(chatId, engineName, {
      prompt,
      cwd,
      abortController,
      outputsDir,
      apiContext,
      maxTurns: options.maxTurns,
      model: options.model ?? session.model,
      allowedTools: options.allowedTools,
      onTeamEvent,
    });

    const startTime = Date.now();
    runningTask = {
      abortController,
      startTime,
      executionHandle,
      pendingQuestion: null,
      currentQuestionIndex: 0,
      collectedAnswers: {},
      cardMessageId: messageId || '',
      processor,
      rateLimiter,
      chatId,
    };
    this.runningTasks.set(chatId, runningTask);
    metrics.setGauge('metabot_active_tasks', this.runningTasks.size);

    this.audit.log({ event: 'api_task_start', botName: this.config.name, chatId, userId, prompt });
    this.emitActivity({ type: 'task_started', botName: this.config.name, chatId, userId, prompt: prompt?.slice(0, 200), timestamp: startTime });

    let timedOut = false;
    let idledOut = false;
    const timeoutId = setTimeout(() => {
      this.logger.warn({ chatId, userId }, 'API task timeout, aborting');
      timedOut = true;
      executionHandle.finish();
      abortController.abort();
    }, TASK_TIMEOUT_MS);

    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        this.logger.warn({ chatId, userId }, 'API task idle timeout (1h no stream), aborting');
        idledOut = true;
        executionHandle.finish();
        abortController.abort();
      }, IDLE_TIMEOUT_MS);
    };
    resetIdleTimer();

    let lastState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
      goalCondition: activeGoal,
    };

    try {
      for await (const message of executionHandle.stream) {
        if (abortController.signal.aborted) break;
        resetIdleTimer();

        const state = processor.processMessage(message);
        if (activeGoal) state.goalCondition = activeGoal;
        if (runningTask.teamState) state.teamState = runningTask.teamState;
        lastState = state;

        const newSessionId = processor.getSessionId();
        if (newSessionId && (newSessionId !== session.sessionId || session.sessionIdEngine !== engineName)) {
          this.sessionManager.setSessionId(chatId, newSessionId, engineName);
        }

        if (state.status === 'waiting_for_input' && state.pendingQuestion) {
          const pending = state.pendingQuestion;
          if (options.onQuestion) {
            // Notify the caller about the question state
            options.onUpdate?.(state, effectiveMessageId, false);
            // Wait for the caller to provide an answer
            const answerJson = await options.onQuestion(pending);
            processor.clearPendingQuestion();
            // Parse answers from the caller's JSON and resolve the PreToolUse hook.
            try {
              const parsed = JSON.parse(answerJson);
              executionHandle.resolveQuestion(pending.toolUseId, parsed.answers || {});
            } catch {
              executionHandle.resolveQuestion(pending.toolUseId, { _answer: answerJson });
            }
          } else {
            // Auto-answer when no onQuestion handler is provided
            processor.clearPendingQuestion();
            executionHandle.resolveQuestion(pending.toolUseId, { _auto: 'Please decide on your own and proceed.' });
          }
          continue;
        }

        // Detect SDK-handled tools for side effects only (no sendAnswer).
        const sdkTools = processor.drainSdkHandledTools();
        for (const tool of sdkTools) {
          this.logger.info({ chatId, toolName: tool.name, toolUseId: tool.toolUseId }, 'API task: detected SDK-handled tool');
          if (tool.name === 'ExitPlanMode' && sendCards) {
            await this.sendPlanContent(chatId, processor, state);
          }
        }

        if (state.status === 'complete' || state.status === 'error') {
          break;
        }

        if (sendCards && messageId) {
          rateLimiter.schedule(() => {
            this.sender.updateCard(messageId!, state);
          });
        }
        options.onUpdate?.(state, effectiveMessageId, false);
      }

      await rateLimiter.cancelAndWait();

      if (lastState.status !== 'complete' && lastState.status !== 'error') {
        if (timedOut) {
          lastState = { ...lastState, status: 'error', errorMessage: TASK_TIMEOUT_MESSAGE };
        } else if (idledOut) {
          lastState = { ...lastState, status: 'error', errorMessage: IDLE_TIMEOUT_MESSAGE };
        } else if (abortController.signal.aborted) {
          lastState = { ...lastState, status: 'error', errorMessage: 'Task was stopped' };
        } else {
          lastState = {
            ...lastState,
            status: lastState.responseText ? 'complete' : 'error',
            errorMessage: lastState.responseText ? undefined : 'Claude session ended unexpectedly',
          };
        }
      }

      // Auto-retry with fresh session when Claude can't find the conversation or context overflows
      if (lastState.status === 'error' && (isStaleSessionError(lastState.errorMessage) || isContextOverflowError(lastState.errorMessage)) && session.sessionId) {
        const isOverflow = isContextOverflowError(lastState.errorMessage);
        this.logger.info({ chatId, isOverflow }, isOverflow ? 'API task: context overflow, retrying with fresh session' : 'API task: stale session detected, retrying with fresh session');
        this.sessionManager.resetSession(chatId);
        const retryMsg = isOverflow ? '_Context limit reached, starting fresh session..._' : '_Session expired, retrying..._';
        if (sendCards && messageId) {
          await this.sender.updateCard(messageId, { ...lastState, status: 'running', responseText: retryMsg });
        }

        const retryHandle = await this.runOneTurn(chatId, engineName, {
          prompt, cwd, abortController, outputsDir, apiContext,
          model: options.model ?? session.model,
          onTeamEvent, freshSession: true,
        });
        executionHandle.finish();
        runningTask.executionHandle = retryHandle;

        for await (const message of retryHandle.stream) {
          if (abortController.signal.aborted) break;
          resetIdleTimer();
          const state = processor.processMessage(message);
          lastState = state;
          const newSid = processor.getSessionId();
          if (newSid) this.sessionManager.setSessionId(chatId, newSid, engineName);
          if (state.status === 'complete' || state.status === 'error') break;
          if (sendCards && messageId) {
            rateLimiter.schedule(() => { this.sender.updateCard(messageId!, state); });
          }
          options.onUpdate?.(state, effectiveMessageId, false);
        }
        await rateLimiter.cancelAndWait();
      }

      if (sendCards && messageId) {
        await this.sendFinalCard(messageId, lastState, chatId);
      }
      options.onUpdate?.(lastState, effectiveMessageId, true);

      await this.outputHandler.sendOutputFiles(chatId, outputsDir, processor, lastState);

      // Notify web clients about output files before cleanup
      if (options.onOutputFiles) {
        const outputFiles = this.outputsManager.scanOutputs(outputsDir);
        if (outputFiles.length > 0) options.onOutputFiles(outputFiles);
      }

      const durationMs = Date.now() - startTime;
      this.audit.log({
        event: 'api_task_complete', botName: this.config.name, chatId, userId, prompt,
        durationMs, costUsd: lastState.costUsd, error: lastState.errorMessage,
      });
      this.emitActivity({
        type: lastState.status === 'complete' ? 'task_completed' : 'task_failed',
        botName: this.config.name, chatId, userId, prompt: prompt?.slice(0, 200),
        responsePreview: lastState.responseText?.slice(0, 200),
        costUsd: lastState.costUsd, durationMs, errorMessage: lastState.errorMessage,
        timestamp: Date.now(),
      });
      this.costTracker.record({ botName: this.config.name, userId, success: lastState.status === 'complete', costUsd: lastState.costUsd, durationMs });
      metrics.incCounter('metabot_api_tasks_total');
      metrics.observeHistogram('metabot_task_duration_seconds', durationMs / 1000);
      if (lastState.costUsd) metrics.observeHistogram('metabot_task_cost_usd', lastState.costUsd);

      // Record in cross-platform session registry
      this.recordSession(chatId, prompt, lastState.responseText, processor.getSessionId(), lastState.costUsd, durationMs);

      return {
        success: lastState.status === 'complete',
        responseText: lastState.responseText,
        sessionId: processor.getSessionId(),
        costUsd: lastState.costUsd,
        durationMs: lastState.durationMs,
        error: lastState.errorMessage,
      };
    } catch (err: any) {
      this.logger.error({ err, chatId, userId }, 'API task execution error');

      // Auto-retry with fresh session when Claude can't find the conversation or context overflows
      const errMsg: string = err.message || '';
      if ((isStaleSessionError(errMsg) || isContextOverflowError(errMsg)) && session.sessionId) {
        const isOverflow = isContextOverflowError(errMsg);
        this.logger.info({ chatId, isOverflow }, isOverflow ? 'API task: context overflow in catch, retrying with fresh session' : 'API task: stale session in catch, retrying with fresh session');
        this.sessionManager.resetSession(chatId);
        const retryMsg = isOverflow ? '_Context limit reached, starting fresh session..._' : '_Session expired, retrying..._';
        if (sendCards && messageId) {
          await this.sender.updateCard(messageId, { ...lastState, status: 'running', responseText: retryMsg });
        }

        try {
          const retryHandle = await this.runOneTurn(chatId, engineName, {
            prompt, cwd, abortController, outputsDir, apiContext,
            model: options.model ?? session.model,
            onTeamEvent, freshSession: true,
          });
          executionHandle.finish();
          runningTask.executionHandle = retryHandle;

          for await (const message of retryHandle.stream) {
            if (abortController.signal.aborted) break;
            resetIdleTimer();
            const state = processor.processMessage(message);
            lastState = state;
            const newSid = processor.getSessionId();
            if (newSid) this.sessionManager.setSessionId(chatId, newSid, engineName);
            if (state.status === 'complete' || state.status === 'error') break;
            if (sendCards && messageId) {
              rateLimiter.schedule(() => { this.sender.updateCard(messageId!, state); });
            }
            options.onUpdate?.(state, effectiveMessageId, false);
          }
          await rateLimiter.cancelAndWait();

          if (sendCards && messageId) {
            await this.sendFinalCard(messageId, lastState, chatId);
          }
          options.onUpdate?.(lastState, effectiveMessageId, true);

          await this.outputHandler.sendOutputFiles(chatId, outputsDir, processor, lastState);

          if (options.onOutputFiles) {
            const outputFiles = this.outputsManager.scanOutputs(outputsDir);
            if (outputFiles.length > 0) options.onOutputFiles(outputFiles);
          }

          return {
            success: lastState.status === 'complete',
            responseText: lastState.responseText,
            sessionId: processor.getSessionId(),
            costUsd: lastState.costUsd,
            durationMs: lastState.durationMs,
            error: lastState.errorMessage,
          };
        } catch (retryErr: any) {
          this.logger.error({ err: retryErr, chatId }, 'API task retry after stale session also failed');
          // Fall through to normal error handling
        }
      }

      if (sendCards && messageId) {
        const errorState: CardState = {
          status: 'error',
          userPrompt: displayPrompt,
          responseText: lastState.responseText,
          toolCalls: lastState.toolCalls,
          errorMessage: err.message || 'Unknown error',
        };
        await rateLimiter.cancelAndWait();
        await this.sendFinalCard(messageId, errorState, chatId);
      }

      const catchErrorState: CardState = {
        status: 'error',
        userPrompt: displayPrompt,
        responseText: lastState.responseText,
        toolCalls: lastState.toolCalls,
        errorMessage: err.message || 'Unknown error',
      };
      options.onUpdate?.(catchErrorState, effectiveMessageId, true);

      this.emitActivity({
        type: 'task_failed', botName: this.config.name, chatId, userId, prompt: prompt?.slice(0, 200),
        errorMessage: err.message || 'Unknown error', durationMs: Date.now() - startTime, timestamp: Date.now(),
      });

      return {
        success: false,
        responseText: lastState.responseText,
        error: err.message || 'Unknown error',
      };
    } finally {
      clearTimeout(timeoutId);
      if (idleTimerId) clearTimeout(idleTimerId);
      try { executionHandle.finish(); } catch (e) { this.logger.warn({ err: e, chatId }, 'Error finishing execution handle'); }
      this.runningTasks.delete(chatId);
      metrics.setGauge('metabot_active_tasks', this.runningTasks.size);
      this.processQueue(chatId);
      try { this.outputsManager.cleanup(outputsDir); } catch { /* ignore */ }
    }
  }

  /**
   * Send the final card update with exponential backoff retry.
   * Retries with exponential backoff (2s → 4s → 8s). If all retries fail,
   * sends a plain text fallback so the user at least sees the result.
   */
  private async sendFinalCard(messageId: string, state: CardState, chatId?: string): Promise<void> {
    // Accumulate usage into session and inject cumulative cost for display
    if (chatId && (state.status === 'complete' || state.status === 'error')) {
      this.sessionManager.addUsage(chatId, state.totalTokens ?? 0, state.costUsd ?? 0, state.durationMs ?? 0);
      const session = this.sessionManager.getSession(chatId);
      state.sessionCostUsd = session.cumulativeCostUsd;
    }
    for (let attempt = 0; attempt < FINAL_CARD_RETRIES; attempt++) {
      const ok = await this.sender.updateCard(messageId, state);
      if (ok) return;
      const delay = FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt);
      this.logger.warn({ attempt, delay, messageId }, 'Final card update failed, retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
    if (chatId) {
      this.logger.error({ messageId, chatId }, 'All final card retries failed, sending text fallback');
      const statusEmoji = state.status === 'complete' ? '✅' : '❌';
      const summary = state.responseText
        ? state.responseText.slice(0, 2000)
        : state.errorMessage || 'Task finished';
      try {
        await this.sender.sendText(chatId, `${statusEmoji} ${summary}`);
      } catch { /* last resort failed */ }
    }
  }

  /**
   * Read and send plan file content to the user when ExitPlanMode is triggered.
   */
  private async sendPlanContent(chatId: string, processor: StreamProcessor, _currentState: CardState): Promise<void> {
    const planPath = processor.getPlanFilePath();
    if (!planPath) return;

    try {
      const planContent = await fsPromises.readFile(planPath, 'utf-8');
      if (!planContent.trim()) return;

      this.logger.info({ chatId, planPath }, 'Sending plan content to user');
      await this.sender.sendTextNotice(chatId, '📋 Plan', planContent, 'green');
    } catch (err) {
      this.logger.warn({ err, planPath, chatId }, 'Failed to read plan file for display');
    }
  }

  /**
   * Send a short text message when a task completes (for long-running tasks).
   * Card updates don't trigger Feishu mobile push notifications, but new messages do.
   * Only sends for tasks that took longer than 10 seconds.
   */
  /** Record session and messages in the cross-platform registry. */
  private recordSession(chatId: string, prompt: string, responseText: string | undefined, claudeSessionId: string | undefined, costUsd: number | undefined, durationMs: number | undefined): void {
    if (!this.sessionRegistry) return;
    try {
      this.sessionRegistry.createOrUpdate({
        chatId,
        botName: this.config.name,
        claudeSessionId,
        workingDirectory: this.sessionManager.getSession(chatId).workingDirectory,
        prompt,
        responseText,
        costUsd,
        durationMs,
      });
    } catch (err) {
      this.logger.warn({ err, chatId }, 'Failed to record session in registry');
    }
  }

  /**
   * Send a separate text message after the card update so the user gets a
   * mobile push notification when a long task finishes. Card edits don't
   * trigger Feishu push, but text messages do.
   *
   * Body is intentionally a single emoji + word (`✅ Done` / `❌ Failed`)
   * — duration, cost, model, and context-usage all live in the card's grey
   * footer already, so repeating them here just made the push banner
   * harder to read at a glance. Don't re-add stats without first
   * confirming the card footer is unreachable on the surface this push
   * lands on.
   *
   * Skipped for:
   *   - durations under 10s (the user is almost certainly still looking
   *     at the screen and doesn't need a push for those)
   *   - senders that route the final response as its own message
   *     already (WeChat — `skipCompletionNotice`)
   *   - continuation turns (between-turn agent activity); see the
   *     handleContinuationTurn call site for the rationale.
   */
  private async sendCompletionNotice(chatId: string, state: CardState, durationMs: number): Promise<void> {
    if (this.sender.skipCompletionNotice) return;
    if (durationMs < 10_000) return;

    const statusEmoji = state.status === 'complete' ? '✅' : '❌';
    const statusWord  = state.status === 'complete' ? 'Done' : 'Failed';
    const message     = `${statusEmoji} ${statusWord}`;

    try {
      await this.sender.sendText(chatId, message);
    } catch (err) {
      this.logger.warn({ err, chatId }, 'Failed to send completion notice');
    }
  }

  destroy(): void {
    for (const [, batch] of this.pendingBatches) {
      clearTimeout(batch.timerId);
    }
    this.pendingBatches.clear();
    for (const [chatId, task] of this.runningTasks) {
      if (task.questionTimeoutId) {
        clearTimeout(task.questionTimeoutId);
      }
      task.executionHandle.finish();
      task.abortController.abort();
      this.logger.info({ chatId }, 'Aborted running task during shutdown');
    }
    this.runningTasks.clear();
    // Abort any in-flight continuation cards too — their executors are
    // about to be torn down by shutdownAll below.
    for (const [chatId, cont] of this.continuationTasks) {
      cont.abortController.abort();
      this.logger.info({ chatId }, 'Aborted continuation task during shutdown');
    }
    this.continuationTasks.clear();
    this.sessionManager.destroy();
    // Tear down persistent executors (Stage 2). Fire-and-forget so destroy()
    // stays sync — registry.shutdownAll waits for clean SDK process exit
    // internally and is idempotent.
    if (this.persistentRegistry) {
      void this.persistentRegistry.shutdownAll('bridge-destroy');
    }
  }
}

export function isStaleSessionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /no conversation found|conversation not found|session id|invalid session|thread\/resume.*failed|no rollout found|multiple.*tool_result.*blocks|each tool_use must have a single result/i.test(errorMessage);
}

export function normalizePromptForEngine(text: string, engine: EngineName): string {
  if (engine !== 'codex') return text;
  const match = text.match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)([\s\S]*)$/);
  if (!match) return text;
  const suffix = match[2] ?? '';
  if (suffix && !/^\s/.test(suffix)) return text;
  return `$${match[1]}${suffix}`;
}

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /context.window.exceeds.limit|context.length.exceeded|context.too.long|max.context.length|token.limit.exceeded|maximum.context/i.test(errorMessage);
}
