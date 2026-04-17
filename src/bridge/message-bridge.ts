import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage, CardState, PendingQuestion } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import type { DocSync } from '../sync/doc-sync.js';
import { ClaudeExecutor, type ExecutionHandle } from '../claude/executor.js';
import { StreamProcessor, type StreamProcessorConfig } from '../claude/stream-processor.js';
import { SessionManager } from '../claude/session-manager.js';
import { RateLimiter } from './rate-limiter.js';
import { OutputsManager } from './outputs-manager.js';
import { MemoryClient } from '../memory/memory-client.js';
import { AuditLogger } from '../utils/audit-logger.js';
import { CommandHandler } from './command-handler.js';
import { OutputHandler } from './output-handler.js';
import { CostTracker } from '../utils/cost-tracker.js';
import { metrics } from '../utils/metrics.js';
import { splitResponseText } from '../feishu/card-builder.js';
import type { SessionRegistry } from '../session/session-registry.js';

const TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to answer
const MAX_QUEUE_SIZE = 5; // max queued messages per chat
const TURN_MERGE_THRESHOLD = 300; // buffer short turns until combined text reaches this length
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour idle → abort
const FINAL_CARD_RETRIES = 3;
const MAX_CONSECUTIVE_AUTO_ANSWERS = 3; // abort after this many unanswered permission prompts in a row
const FINAL_CARD_BASE_DELAY_MS = 2000;
const TASK_TIMEOUT_MESSAGE = 'Task timed out (24 hour limit)';
const IDLE_TIMEOUT_MESSAGE = 'Task aborted: no activity for 1 hour';
const BATCH_DEBOUNCE_MS = 2000; // 2s window to collect multiple images/files
const DEFAULT_IMAGE_TEXT = '请分析这张图片';
const DEFAULT_FILE_TEXT = '请分析这个文件';

interface PendingBatch {
  messages: IncomingMessage[];
  timerId: ReturnType<typeof setTimeout>;
}

// Two-tier 403 retry strategy: 3x 1min, then 2x 5min
const RETRY_TIERS: Array<{ count: number; delayMs: number }> = [
  { count: 3, delayMs: 60_000 },   // tier 1: 3 retries, 1 min each
  { count: 2, delayMs: 300_000 },  // tier 2: 2 retries, 5 min each
];

export function is403Error(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const msg = String(e.message || '');
  const status = e.status ?? e.statusCode ?? e.code;
  return status === 403 || status === '403' || /\b403\b/.test(msg) || /forbidden/i.test(msg) || /rate.limit/i.test(msg);
}

export function getRetryDelay(attempt: number): number | null {
  let remaining = attempt;
  for (const tier of RETRY_TIERS) {
    if (remaining < tier.count) return tier.delayMs;
    remaining -= tier.count;
  }
  return null; // max retries exceeded
}

const MAX_403_RETRIES = RETRY_TIERS.reduce((sum, t) => sum + t.count, 0);

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
  questionTimeoutId?: ReturnType<typeof setTimeout>;
  processor: StreamProcessor;
  rateLimiter: RateLimiter;
  chatId: string;
  consecutiveAutoAnswers: number;
  abortReason?: string;
}

export interface ApiTaskOptions {
  prompt: string;
  chatId: string;
  userId?: string;
  sendCards?: boolean;
  freshSession?: boolean;
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
  private executor: ClaudeExecutor;
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
  /** Callback for activity lifecycle events (task started/completed/failed). */
  onActivityEvent?: (event: ActivityEventData) => void;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    private sender: IMessageSender,
    memoryServerUrl: string,
    memorySecret?: string,
  ) {
    this.executor = new ClaudeExecutor(config, logger);
    this.sessionManager = new SessionManager(config.claude.defaultWorkingDirectory, logger, config.name);
    this.outputsManager = new OutputsManager(config.claude.outputsBaseDir, logger);
    this.audit = new AuditLogger(logger);
    this.costTracker = new CostTracker();

    const memoryClient = new MemoryClient(memoryServerUrl, logger, memorySecret);

    this.commandHandler = new CommandHandler(
      config, logger, sender, this.sessionManager, memoryClient, this.audit,
      (chatId) => this.runningTasks.get(chatId),
      (chatId) => this.stopTask(chatId),
    );

    this.outputHandler = new OutputHandler(logger, sender, this.outputsManager);
  }

  /** Emit an activity event if a listener is registered. */
  private emitActivity(event: ActivityEventData): void {
    try { this.onActivityEvent?.(event); } catch { /* ignore */ }
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

  private stopTask(chatId: string): void {
    const task = this.runningTasks.get(chatId);
    if (!task) return;
    if (task.questionTimeoutId) clearTimeout(task.questionTimeoutId);
    task.executionHandle.finish();
    task.abortController.abort();
    // Don't delete from runningTasks here — the finally block in executeQuery will
    // handle cleanup. Deleting early creates a race: if the user sends a new message
    // before the old loop exits, the old finally block would delete the NEW task entry.
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
    // If this was a queued API task, route back through executeApiTask
    const apiResolve = (next as any)._apiTaskResolve as ((r: ApiTaskResult) => void) | undefined;
    const apiOptions = (next as any)._apiTaskOptions as ApiTaskOptions | undefined;
    if (apiResolve && apiOptions) {
      this.executeApiTask(apiOptions).then(apiResolve).catch((err) => {
        this.logger.error({ err, chatId }, 'Error processing queued API task');
        apiResolve({ success: false, responseText: '', error: err.message || 'Queue processing error' });
      });
    } else {
      this.executeQuery(next).catch((err) => {
        this.logger.error({ err, chatId }, 'Error processing queued message');
      });
    }
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { chatId, text } = msg;

    // Handle commands (always allowed, even during pending questions)
    if (text.startsWith('/')) {
      const handled = await this.commandHandler.handle(msg);
      if (handled) return;

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

  /**
   * Handle a card button click (`card.action.trigger`). Maps the click back
   * to the running task via `cardMessageId + toolUseId`, then synthesizes a
   * text answer and reuses the existing `handleAnswer` path. This keeps all
   * idempotency / multi-question / `answeredToolUseIds` logic centralized.
   *
   * Stale clicks (task gone, question already resolved, or toolUseId
   * mismatch) are no-ops — the user just sees the card move on, which is
   * the desired behavior.
   */
  async handleCardAction(evt: {
    userId: string;
    messageId: string;
    value: Record<string, unknown>;
  }): Promise<void> {
    if (evt.value.kind !== 'askuser_answer') {
      // Unknown action kind — ignore silently. Future action kinds (e.g.
      // approve/deny buttons) will add their own branches here.
      return;
    }
    const toolUseId = typeof evt.value.toolUseId === 'string' ? evt.value.toolUseId : undefined;
    const optionIndex = typeof evt.value.optionIndex === 'number' ? evt.value.optionIndex : undefined;
    if (!toolUseId || optionIndex === undefined || optionIndex < 0) {
      this.logger.warn({ value: evt.value }, 'askuser_answer action missing toolUseId or optionIndex');
      return;
    }

    // Find the task whose card this click came from. We scan by messageId
    // because runningTasks is keyed by chatId. Match toolUseId to defend
    // against clicks on stale cards whose task has already moved on to a
    // different question.
    let foundChatId: string | undefined;
    let foundTask: RunningTask | undefined;
    for (const [chatId, task] of this.runningTasks) {
      if (task.cardMessageId === evt.messageId && task.pendingQuestion?.toolUseId === toolUseId) {
        foundChatId = chatId;
        foundTask = task;
        break;
      }
    }
    if (!foundTask || !foundChatId) {
      this.logger.info(
        { messageId: evt.messageId, toolUseId, optionIndex },
        'card action for unknown or stale task — ignoring',
      );
      return;
    }

    // Reuse the text-reply path. handleAnswer parses "N" → options[N-1].label
    // exactly as a user typing the number would, so button and text paths
    // produce identical state transitions.
    const syntheticMsg: IncomingMessage = {
      messageId: `card-action:${toolUseId}:${optionIndex}`,
      chatId: foundChatId,
      chatType: 'p2p',
      userId: evt.userId,
      text: String(optionIndex + 1),
    };
    await this.handleAnswer(syntheticMsg, foundTask);
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

      // Update card to show next question
      const currentState = task.processor.getCurrentState();
      const nextQ = pending.questions[task.currentQuestionIndex];
      const displayQuestion: PendingQuestion = {
        toolUseId: pending.toolUseId,
        questions: [nextQ],
      };
      const progress = `(${task.currentQuestionIndex + 1}/${pending.questions.length})`;
      await this.sender.updateCard(task.cardMessageId, {
        ...currentState,
        status: 'waiting_for_input',
        responseText: currentState.responseText
          ? currentState.responseText + `\n\n> **Reply ${progress}:** ${answerText}`
          : `> **Reply:** ${answerText}`,
        pendingQuestion: displayQuestion,
      });
      return;
    }

    // All questions in this call answered — resolve the PreToolUse hook
    const collectedAnswers = { ...task.collectedAnswers };

    if (task.questionTimeoutId) {
      clearTimeout(task.questionTimeoutId);
      task.questionTimeoutId = undefined;
    }
    task.pendingQuestion = null;
    task.currentQuestionIndex = 0;
    task.collectedAnswers = {};
    task.processor.clearPendingQuestion();
    task.consecutiveAutoAnswers = 0; // user responded — reset loop counter

    task.executionHandle.resolveQuestion(pending.toolUseId, collectedAnswers);

    this.logger.info({ chatId, answers: collectedAnswers, toolUseId: pending.toolUseId }, 'Sent all answers to Claude');

    // Check if there are more queued AskUserQuestion calls
    const nextPending = task.processor.getPendingQuestion();
    if (nextPending) {
      task.pendingQuestion = nextPending;
      task.currentQuestionIndex = 0;
      task.collectedAnswers = {};

      // Show next question call
      const currentState = task.processor.getCurrentState();
      const displayQuestion: PendingQuestion = {
        toolUseId: nextPending.toolUseId,
        questions: [nextPending.questions[0]],
      };
      const progress = nextPending.questions.length > 1 ? ` (1/${nextPending.questions.length})` : '';
      task.questionTimeoutId = setTimeout(() => {
        this.autoAnswerRemainingQuestions(task);
      }, QUESTION_TIMEOUT_MS);

      await this.sender.updateCard(task.cardMessageId, {
        ...currentState,
        status: 'waiting_for_input',
        responseText: currentState.responseText
          ? currentState.responseText + `\n\n> **Reply:** ${answerText}\n\n_Next question${progress}..._`
          : `> **Reply:** ${answerText}\n\n_Next question${progress}..._`,
        pendingQuestion: displayQuestion,
      });
      return;
    }

    // No more questions — resume normal execution.
    // Use the `collectedAnswers` snapshot captured above, NOT task.collectedAnswers
    // (which was reset to {} just before resolveQuestion for the next question cycle).
    const answerSummary = Object.values(collectedAnswers).length > 0
      ? Object.values(collectedAnswers).join(', ')
      : answerText;
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

    const collectedAnswers = { ...task.collectedAnswers };
    task.pendingQuestion = null;
    task.currentQuestionIndex = 0;
    task.collectedAnswers = {};
    task.processor.clearPendingQuestion();

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
    const session = this.sessionManager.getSession(chatId);
    const cwd = session.workingDirectory;
    const abortController = new AbortController();

    // Prepare downloads directory (bot-isolated)
    const downloadsDir = this.config.claude.downloadsDir;
    fs.mkdirSync(downloadsDir, { recursive: true });

    // Handle image download if present
    let prompt = text;
    let imagePath: string | undefined;
    let filePath: string | undefined;
    if (imageKey) {
      imagePath = path.join(downloadsDir, `${imageKey}.png`);
      const ok = await this.sender.downloadImage(msgId, imageKey, imagePath);
      if (ok) {
        prompt = `${text}\n\n[Image saved at: ${imagePath}]\nPlease use the Read tool to read and analyze this image file.`;
      } else {
        prompt = `${text}\n\n(Note: Failed to download the image)`;
      }
    }

    // Handle file download if present
    if (fileKey && fileName) {
      filePath = path.join(downloadsDir, `${fileKey}_${fileName}`);
      const ok = await this.sender.downloadFile(msgId, fileKey, filePath);
      if (ok) {
        prompt = `${text}\n\n[File saved at: ${filePath}]\nPlease use the Read tool (for text/code files, images, PDFs) or Bash tool (for other formats) to read and analyze this file.`;
      } else {
        prompt = `${text}\n\n(Note: Failed to download the file)`;
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
    const taskStartTime = Date.now();
    const processorConfig: StreamProcessorConfig = {
      model: this.config.claude.model,
      thinking: this.config.claude.thinking ? String((this.config.claude.thinking as Record<string, unknown>).type || '') : undefined,
      effort: this.config.claude.effort,
      startTime: taskStartTime,
    };
    const processor = new StreamProcessor(displayPrompt, processorConfig, cwd);
    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
      startTime: taskStartTime,
    };

    const initialCardId = await this.sender.sendCard(chatId, initialState);

    if (!initialCardId) {
      this.logger.error('Failed to send initial card, aborting');
      return;
    }

    let messageId: string = initialCardId;
    let turnBuffer = '';
    let turnCount = 0;
    let needsRecreate = false;

    const apiContext = { botName: this.config.name, chatId };

    // Start multi-turn execution
    let executionHandle = this.executor.startExecution({
      prompt,
      cwd,
      sessionId: session.sessionId,
      abortController,
      outputsDir,
      apiContext,
    });

    const rateLimiter = new RateLimiter(1500);

    // Register running task
    const startTime = Date.now();
    const runningTask: RunningTask = {
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
      consecutiveAutoAnswers: 0,
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
    let retryAttempt = 0;

    // Periodic timer to update card during thinking/running (shows elapsed time).
    // The limiter itself drops schedule() calls while paused (see recreateCard
    // wrapping below), so this timer does not need to know about the recreate
    // lifecycle — pausing at the critical section is enough to kill the
    // freeze-race without extra coordination here.
    const thinkingTimerId = setInterval(() => {
      if (lastState.startTime && (lastState.status === 'thinking' || lastState.status === 'running')) {
        // Re-render the card with updated elapsed time
        rateLimiter.schedule(() => this.sender.updateCard(messageId, lastState).catch(() => false));
      }
    }, 3000);

    try {
      // Retry loop for 403 errors (two-tier: 3x1min + 2x5min)
      let streamDone = false;
      while (!streamDone) {
        try {
          for await (const message of executionHandle.stream) {
            if (abortController.signal.aborted) { streamDone = true; break; }
            resetIdleTimer();

            const state = processor.processMessage(message);
            lastState = state;

            // Per-turn message: buffer short turns, send when threshold is met
            if (state.completedTurnText && chatId) {
              turnBuffer += (turnBuffer ? '\n\n---\n\n' : '') + state.completedTurnText;
              if (!needsRecreate && turnBuffer.length >= TURN_MERGE_THRESHOLD) {
                await rateLimiter.flush();
                ++turnCount;
                needsRecreate = true;
              }
            }

            // Update session ID if discovered
            const newSessionId = processor.getSessionId();
            if (newSessionId && newSessionId !== session.sessionId) {
              this.sessionManager.setSessionId(chatId, newSessionId);
            }

            // Check if we hit a waiting_for_input state
            if (state.status === 'waiting_for_input' && state.pendingQuestion) {
              // Only initialize tracking when we see a NEW question call
              if (!runningTask.pendingQuestion || runningTask.pendingQuestion.toolUseId !== state.pendingQuestion.toolUseId) {
                runningTask.pendingQuestion = state.pendingQuestion;
                runningTask.currentQuestionIndex = 0;
                runningTask.collectedAnswers = {};
              }

              await rateLimiter.flush();

              // Show only the current question (not all at once)
              const pending = runningTask.pendingQuestion;
              const currentQ = pending.questions[runningTask.currentQuestionIndex];
              const displayQuestion: PendingQuestion = {
                toolUseId: pending.toolUseId,
                questions: currentQ ? [currentQ] : pending.questions,
              };
              const progress = pending.questions.length > 1
                ? ` (${runningTask.currentQuestionIndex + 1}/${pending.questions.length})`
                : '';
              await this.sender.updateCard(messageId, {
                ...state,
                pendingQuestion: displayQuestion,
                // Append progress indicator to response if multi-question
                responseText: progress
                  ? (state.responseText || '') + (state.responseText ? '\n\n' : '') + `_Question${progress}_`
                  : state.responseText,
              });

              // Set/reset timeout for auto-answer with permission loop detection
              if (runningTask.questionTimeoutId) {
                clearTimeout(runningTask.questionTimeoutId);
              }
              runningTask.questionTimeoutId = setTimeout(() => {
                this.logger.warn({ chatId }, 'Question timeout, auto-answering');
                const pendingQ = runningTask.pendingQuestion;
                if (pendingQ) {
                  runningTask.consecutiveAutoAnswers++;
                  if (runningTask.consecutiveAutoAnswers >= MAX_CONSECUTIVE_AUTO_ANSWERS) {
                    this.logger.warn({ chatId, count: runningTask.consecutiveAutoAnswers }, 'Permission loop detected, aborting task');
                    runningTask.pendingQuestion = null;
                    processor.clearPendingQuestion();
                    runningTask.abortReason = 'Permission request loop detected: Claude repeatedly asked for permission without user response. Please try again with a more specific instruction.';
                    executionHandle.finish();
                    abortController.abort();
                    return;
                  }
                  this.autoAnswerRemainingQuestions(runningTask);
                }
              }, QUESTION_TIMEOUT_MS);

              continue;
            }

            // SDK-handled tools (ExitPlanMode, EnterPlanMode): the SDK already
            // emits the tool_result in bypassPermissions mode, so we only run
            // side effects here — pushing our own tool_result would cause a
            // duplicate tool_result error.
            const sdkHandledTools = processor.drainSdkHandledTools();
            for (const tool of sdkHandledTools) {
              this.logger.info({ chatId, toolName: tool.name, toolUseId: tool.toolUseId }, 'SDK-handled tool detected, running side effects');
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
            if (state.status === 'complete') {
              streamDone = true;
              break;
            }
            if (state.status === 'error') {
              // Check if the error is a 403 — throw to trigger retry in catch block
              if (state.errorMessage && is403Error({ message: state.errorMessage })) {
                throw new Error(state.errorMessage);
              }
              streamDone = true;
              break;
            }

            // Deferred recreate: move card to bottom when new content starts after turn flush.
            // Pause the limiter so the thinkingTimer (and any other concurrent
            // schedule() caller) cannot enqueue an updateCard(oldMessageId,
            // runningState) that would land on the server AFTER the freeze
            // and revert the old card — a race flush() alone cannot close
            // because new thunks are scheduled DURING recreateCard, outside
            // flush()'s horizon.
            if (needsRecreate && state.responseText) {
              await rateLimiter.flush();
              rateLimiter.pause();
              try {
                messageId = await this.recreateCard(chatId, messageId, state, `Turn ${turnCount}`, turnBuffer);
              } finally {
                rateLimiter.resume();
              }
              needsRecreate = false;
              turnBuffer = '';
            }

            // Throttled card update for non-final states. Return the promise
            // so rateLimiter.flush() can await the in-flight update before
            // recreateCard freezes the card — otherwise the stale update can
            // land after the freeze and revert it to thinking/running state.
            rateLimiter.schedule(() => this.sender.updateCard(messageId, state).catch(() => false));
          }
          // Stream ended normally
          streamDone = true;
        } catch (streamErr: any) {
          // 403 auto-retry: update card with retry status, wait, resume session
          if (is403Error(streamErr) && !abortController.signal.aborted) {
            const delay = getRetryDelay(retryAttempt);
            if (delay !== null) {
              retryAttempt++;
              const delaySec = Math.round(delay / 1000);
              const delayLabel = delaySec >= 60 ? `${delaySec / 60}min` : `${delaySec}s`;
              this.logger.warn({ chatId, retryAttempt, maxRetries: MAX_403_RETRIES, delay: delayLabel }, '403 error, retrying');

              // Update card to show retry countdown (preserve partial content)
              const retryState: CardState = {
                ...lastState,
                status: 'thinking',
                errorMessage: undefined,
                retryInfo: `Rate limited — retry ${retryAttempt}/${MAX_403_RETRIES} in ${delayLabel}...`,
              };
              await rateLimiter.cancelAndWait();
              await this.sender.updateCard(messageId, retryState);

              await new Promise((r) => setTimeout(r, delay));
              if (abortController.signal.aborted) throw streamErr;

              // Resume with existing session or retry fresh
              const resumeSessionId = processor.getSessionId() || session.sessionId;
              try { executionHandle.finish(); } catch { /* ignore */ }
              executionHandle = this.executor.startExecution({
                prompt: resumeSessionId ? 'continue' : prompt,
                cwd,
                sessionId: resumeSessionId,
                abortController,
                outputsDir,
                apiContext,
              });
              runningTask.executionHandle = executionHandle;
              lastState = { ...lastState, retryInfo: undefined };
              continue; // re-enter while loop with new stream
            }
          }
          throw streamErr; // non-403 or max retries exceeded
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
          lastState = { ...lastState, status: 'error', errorMessage: runningTask.abortReason || 'Task was stopped' };
        } else {
          this.logger.warn({ chatId }, 'Stream ended without result message, forcing complete state');
          lastState = {
            ...lastState,
            status: lastState.responseText ? 'complete' : 'error',
            errorMessage: lastState.responseText ? undefined : 'Claude session ended unexpectedly',
          };
        }
      }

      // Auto-clear stale session when Claude can't find the conversation
      if (lastState.status === 'error' && isStaleSessionError(lastState.errorMessage)) {
        this.logger.info({ chatId }, 'Clearing stale session ID due to conversation not found');
        this.sessionManager.resetSession(chatId);
        lastState = { ...lastState, status: 'running', errorMessage: undefined };
        await this.sender.updateCard(messageId, { ...lastState, responseText: '_Session expired, retrying..._' });

        // Retry execution without sessionId
        const retryHandle = this.executor.startExecution({
          prompt, cwd, sessionId: undefined, abortController, outputsDir, apiContext,
        });
        executionHandle.finish();
        runningTask.executionHandle = retryHandle;

        for await (const message of retryHandle.stream) {
          if (abortController.signal.aborted) break;
          resetIdleTimer();
          const state = processor.processMessage(message);
          lastState = state;
          if (state.completedTurnText && chatId) {
            turnBuffer += (turnBuffer ? '\n\n---\n\n' : '') + state.completedTurnText;
            if (!needsRecreate && turnBuffer.length >= TURN_MERGE_THRESHOLD) {
              await rateLimiter.flush();
              ++turnCount;
              needsRecreate = true;
            }
          }
          const newSid = processor.getSessionId();
          if (newSid) this.sessionManager.setSessionId(chatId, newSid);
          if (state.status === 'complete' || state.status === 'error') break;
          if (needsRecreate && state.responseText) {
            await rateLimiter.flush();
            rateLimiter.pause();
            try {
              messageId = await this.recreateCard(chatId, messageId, state, `Turn ${turnCount}`, turnBuffer);
            } finally {
              rateLimiter.resume();
            }
            needsRecreate = false;
            turnBuffer = '';
          }
          rateLimiter.schedule(() => this.sender.updateCard(messageId, state).catch(() => false));
        }
        await rateLimiter.cancelAndWait();
      }

      // Flush remaining turn buffer before final card (no recreate — final card updates in place)
      if (turnBuffer && !needsRecreate) ++turnCount;
      await this.sendFinalCard(messageId, lastState, chatId, turnBuffer || undefined, turnCount);

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

      // Auto-retry with fresh session when Claude can't find the conversation
      const errMsg: string = err.message || '';
      if (isStaleSessionError(errMsg) && session.sessionId) {
        this.logger.info({ chatId }, 'Stale session detected in catch, retrying with fresh session');
        this.sessionManager.resetSession(chatId);
        await this.sender.updateCard(messageId, { ...lastState, status: 'running', responseText: '_Session expired, retrying..._' });

        try {
          const retryHandle = this.executor.startExecution({
            prompt, cwd, sessionId: undefined, abortController, outputsDir, apiContext,
          });
          executionHandle.finish();
          runningTask.executionHandle = retryHandle;

          for await (const message of retryHandle.stream) {
            if (abortController.signal.aborted) break;
            resetIdleTimer();
            const state = processor.processMessage(message);
            lastState = state;
            if (state.completedTurnText && chatId) {
              turnBuffer += (turnBuffer ? '\n\n---\n\n' : '') + state.completedTurnText;
              if (!needsRecreate && turnBuffer.length >= TURN_MERGE_THRESHOLD) {
                await rateLimiter.flush();
                ++turnCount;
                needsRecreate = true;
              }
            }
            const newSid = processor.getSessionId();
            if (newSid) this.sessionManager.setSessionId(chatId, newSid);
            if (state.status === 'complete' || state.status === 'error') break;
            if (needsRecreate && state.responseText) {
              await rateLimiter.flush();
              rateLimiter.pause();
              try {
                messageId = await this.recreateCard(chatId, messageId, state, `Turn ${turnCount}`, turnBuffer);
              } finally {
                rateLimiter.resume();
              }
              needsRecreate = false;
              turnBuffer = '';
            }
            rateLimiter.schedule(() => this.sender.updateCard(messageId, state).catch(() => false));
          }
          await rateLimiter.cancelAndWait();
          if (turnBuffer && !needsRecreate) ++turnCount;
          await this.sendFinalCard(messageId, lastState, chatId, turnBuffer || undefined, turnCount);

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
      if (turnBuffer && !needsRecreate) ++turnCount;
      await this.sendFinalCard(messageId, errorState, chatId, turnBuffer || undefined, turnCount);
    } finally {
      clearInterval(thinkingTimerId);
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
    const { prompt, chatId, userId = 'api', sendCards = false, freshSession = false } = options;

    // Clear session before execution so each run starts with a clean context
    if (freshSession) {
      this.sessionManager.resetSession(chatId);
      this.logger.info({ chatId }, 'Fresh session: cleared previous session');
    }

    if (this.runningTasks.has(chatId)) {
      // Queue the API task and wait for it to complete instead of rejecting
      const queue = this.messageQueues.get(chatId) || [];
      if (queue.length >= MAX_QUEUE_SIZE) {
        return { success: false, responseText: '', error: `Queue full (${MAX_QUEUE_SIZE} pending). Try again later.` };
      }
      this.logger.info({ chatId, userId, queuePos: queue.length + 1 }, 'API task queued (chat busy)');
      return new Promise<ApiTaskResult>((resolve) => {
        const queuedMsg: IncomingMessage = {
          chatId,
          userId,
          text: prompt,
          messageId: `api-${Date.now()}`,
          _apiTaskResolve: resolve,
          _apiTaskOptions: options,
        } as any;
        queue.push(queuedMsg);
        this.messageQueues.set(chatId, queue);
        this.audit.log({ event: 'task_queued', botName: this.config.name, chatId, userId, prompt, meta: { position: queue.length } });
      });
    }

    const session = this.sessionManager.getSession(chatId);
    const cwd = session.workingDirectory;
    const abortController = new AbortController();

    const outputsDir = this.outputsManager.prepareDir(chatId);

    const displayPrompt = prompt;
    const taskStartTime = Date.now();
    const processorConfig: StreamProcessorConfig = {
      model: this.config.claude.model,
      thinking: this.config.claude.thinking ? String((this.config.claude.thinking as Record<string, unknown>).type || '') : undefined,
      effort: this.config.claude.effort,
      startTime: taskStartTime,
    };
    const processor = new StreamProcessor(displayPrompt, processorConfig, cwd);
    const rateLimiter = new RateLimiter(1500);

    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
      startTime: taskStartTime,
    };

    let messageId: string | undefined;
    let turnBuffer = '';
    let turnCount = 0;
    let needsRecreate = false;
    if (sendCards) {
      messageId = await this.sender.sendCard(chatId, initialState);
    }

    // Generate a messageId for onUpdate even if sendCards is false
    const effectiveMessageId = messageId || `api-${chatId}-${Date.now()}`;
    options.onUpdate?.(initialState, effectiveMessageId, false);

    const apiContext = { botName: this.config.name, chatId, groupMembers: options.groupMembers, groupId: options.groupId };

    let executionHandle = this.executor.startExecution({
      prompt,
      cwd,
      sessionId: session.sessionId,
      abortController,
      outputsDir,
      apiContext,
      maxTurns: options.maxTurns,
      model: options.model,
      allowedTools: options.allowedTools,
    });

    const startTime = Date.now();
    const runningTask: RunningTask = {
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
      consecutiveAutoAnswers: 0,
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
    };
    let retryAttempt = 0;

    try {
      // Retry loop for 403 errors (two-tier: 3x1min + 2x5min)
      let streamDone = false;
      while (!streamDone) {
        try {
          for await (const message of executionHandle.stream) {
            if (abortController.signal.aborted) { streamDone = true; break; }
            resetIdleTimer();

            const state = processor.processMessage(message);
            lastState = state;

            // Per-turn message: buffer short turns, send when threshold is met
            if (state.completedTurnText && chatId) {
              turnBuffer += (turnBuffer ? '\n\n---\n\n' : '') + state.completedTurnText;
              if (!needsRecreate && turnBuffer.length >= TURN_MERGE_THRESHOLD) {
                await rateLimiter.flush();
                ++turnCount;
                needsRecreate = true;
              }
            }

            const newSessionId = processor.getSessionId();
            if (newSessionId && newSessionId !== session.sessionId) {
              this.sessionManager.setSessionId(chatId, newSessionId);
            }

            if (state.status === 'waiting_for_input' && state.pendingQuestion) {
              const pending = state.pendingQuestion;
              if (options.onQuestion) {
                // Notify the caller about the question state
                options.onUpdate?.(state, effectiveMessageId, false);
                // Wait for the caller to provide an answer
                const answerJson = await options.onQuestion(pending);
                processor.clearPendingQuestion();
                // Parse answers from JSON and resolve the hook
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

            // SDK-handled tools (ExitPlanMode, EnterPlanMode): side-effects only
            // — the SDK already emits the tool_result in bypassPermissions mode.
            const sdkHandledTools = processor.drainSdkHandledTools();
            for (const tool of sdkHandledTools) {
              this.logger.info({ chatId, toolName: tool.name, toolUseId: tool.toolUseId }, 'API task: SDK-handled tool detected, running side effects');
              if (tool.name === 'ExitPlanMode' && sendCards) {
                await this.sendPlanContent(chatId, processor, state);
              }
            }

            if (state.status === 'complete') {
              streamDone = true;
              break;
            }
            if (state.status === 'error') {
              if (state.errorMessage && is403Error({ message: state.errorMessage })) {
                throw new Error(state.errorMessage);
              }
              streamDone = true;
              break;
            }

            if (sendCards && messageId) {
              if (needsRecreate && state.responseText) {
                await rateLimiter.flush();
                messageId = await this.recreateCard(chatId, messageId, state, `Turn ${turnCount}`, turnBuffer);
                needsRecreate = false;
                turnBuffer = '';
              }
              rateLimiter.schedule(() => this.sender.updateCard(messageId!, state).catch(() => false));
            }
          }
          streamDone = true;
        } catch (streamErr: any) {
          // 403 auto-retry for API tasks
          if (is403Error(streamErr) && !abortController.signal.aborted) {
            const delay = getRetryDelay(retryAttempt);
            if (delay !== null) {
              retryAttempt++;
              const delaySec = Math.round(delay / 1000);
              const delayLabel = delaySec >= 60 ? `${delaySec / 60}min` : `${delaySec}s`;
              this.logger.warn({ chatId, retryAttempt, maxRetries: MAX_403_RETRIES, delay: delayLabel }, 'API task 403, retrying');

              if (sendCards && messageId) {
                const retryState: CardState = {
                  ...lastState,
                  status: 'thinking',
                  errorMessage: undefined,
                  retryInfo: `Rate limited — retry ${retryAttempt}/${MAX_403_RETRIES} in ${delayLabel}...`,
                };
                await rateLimiter.cancelAndWait();
                await this.sender.updateCard(messageId, retryState);
              }

              await new Promise((r) => setTimeout(r, delay));
              if (abortController.signal.aborted) throw streamErr;

              const resumeSessionId = processor.getSessionId() || session.sessionId;
              try { executionHandle.finish(); } catch { /* ignore */ }
              executionHandle = this.executor.startExecution({
                prompt: resumeSessionId ? 'continue' : prompt,
                cwd,
                sessionId: resumeSessionId,
                abortController,
                outputsDir,
                apiContext,
              });
              runningTask.executionHandle = executionHandle;
              lastState = { ...lastState, retryInfo: undefined };
              continue;
            }
          }
          throw streamErr;
        }
        options.onUpdate?.(lastState, effectiveMessageId, false);
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

      if (lastState.status === 'error' && isStaleSessionError(lastState.errorMessage)) {
        this.logger.info({ chatId }, 'Clearing stale session ID due to conversation not found');
        this.sessionManager.resetSession(chatId);
        if (sendCards && messageId) {
          await this.sender.updateCard(messageId, { ...lastState, status: 'running', responseText: '_Session expired, retrying..._' });
        }

        const retryHandle = this.executor.startExecution({
          prompt, cwd, sessionId: undefined, abortController, outputsDir, apiContext,
        });
        executionHandle.finish();
        runningTask.executionHandle = retryHandle;

        for await (const message of retryHandle.stream) {
          if (abortController.signal.aborted) break;
          resetIdleTimer();
          const state = processor.processMessage(message);
          lastState = state;
          if (state.completedTurnText && chatId) {
            turnBuffer += (turnBuffer ? '\n\n---\n\n' : '') + state.completedTurnText;
            if (!needsRecreate && turnBuffer.length >= TURN_MERGE_THRESHOLD) {
              await rateLimiter.flush();
              ++turnCount;
              needsRecreate = true;
            }
          }
          const newSid = processor.getSessionId();
          if (newSid) this.sessionManager.setSessionId(chatId, newSid);
          if (state.status === 'complete' || state.status === 'error') break;
          if (sendCards && messageId) {
            if (needsRecreate && state.responseText) {
              await rateLimiter.flush();
              messageId = await this.recreateCard(chatId, messageId, state, `Turn ${turnCount}`, turnBuffer);
              needsRecreate = false;
              turnBuffer = '';
            }
            rateLimiter.schedule(() => this.sender.updateCard(messageId!, state).catch(() => false));
          }
          options.onUpdate?.(state, effectiveMessageId, false);
        }
        await rateLimiter.cancelAndWait();
      }

      if (turnBuffer && !needsRecreate) ++turnCount;
      if (sendCards && messageId) {
        await this.sendFinalCard(messageId, lastState, chatId, turnBuffer || undefined, turnCount);
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

      const errMsg: string = err.message || '';
      if (isStaleSessionError(errMsg)) {
        this.logger.info({ chatId }, 'Clearing stale session ID due to conversation not found');
        this.sessionManager.resetSession(chatId);
        if (sendCards && messageId) {
          await this.sender.updateCard(messageId, { ...lastState, status: 'running', responseText: '_Session expired, retrying..._' });
        }

        try {
          const retryHandle = this.executor.startExecution({
            prompt, cwd, sessionId: undefined, abortController, outputsDir, apiContext,
          });
          executionHandle.finish();
          runningTask.executionHandle = retryHandle;

          for await (const message of retryHandle.stream) {
            if (abortController.signal.aborted) break;
            resetIdleTimer();
            const state = processor.processMessage(message);
            lastState = state;
            if (state.completedTurnText && chatId) {
              turnBuffer += (turnBuffer ? '\n\n---\n\n' : '') + state.completedTurnText;
              if (!needsRecreate && turnBuffer.length >= TURN_MERGE_THRESHOLD) {
                await rateLimiter.flush();
                ++turnCount;
                needsRecreate = true;
              }
            }
            const newSid = processor.getSessionId();
            if (newSid) this.sessionManager.setSessionId(chatId, newSid);
            if (state.status === 'complete' || state.status === 'error') break;
            if (sendCards && messageId) {
              if (needsRecreate && state.responseText) {
                await rateLimiter.flush();
                messageId = await this.recreateCard(chatId, messageId, state, `Turn ${turnCount}`, turnBuffer);
                needsRecreate = false;
                turnBuffer = '';
              }
              rateLimiter.schedule(() => this.sender.updateCard(messageId!, state).catch(() => false));
            }
            options.onUpdate?.(state, effectiveMessageId, false);
          }
          await rateLimiter.cancelAndWait();

          if (turnBuffer && !needsRecreate) ++turnCount;
          if (sendCards && messageId) {
            await this.sendFinalCard(messageId, lastState, chatId, turnBuffer || undefined, turnCount);
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
        if (turnBuffer && !needsRecreate) ++turnCount;
        await this.sendFinalCard(messageId, errorState, chatId, turnBuffer || undefined, turnCount);
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
  private async sendFinalCard(
    messageId: string,
    state: CardState,
    chatId?: string,
    lastTurnText?: string,
    turnCount: number = 0,
  ): Promise<void> {
    // Accumulate usage into session and inject cumulative cost for display
    if (chatId && (state.status === 'complete' || state.status === 'error')) {
      this.sessionManager.addUsage(chatId, state.totalTokens ?? 0, state.costUsd ?? 0, state.durationMs ?? 0);
      const session = this.sessionManager.getSession(chatId);
      state.sessionCostUsd = session.cumulativeCostUsd;
    }
    let succeeded = false;

    if (turnCount > 0 && chatId) {
      // Multi-turn path: freeze the current card with the last turn's content,
      // then send a brand-new Result card at the bottom so it always appears
      // after all turn cards.
      const freezeState = {
        ...state,
        status: 'complete' as const,
        responseText: lastTurnText || '',
        cardTitle: `Turn ${turnCount}`,
      };
      let frozen = false;
      // updateCard is no-throw + boolean on transport failure; defensive catch
      // guards against unexpected throws (e.g. test mocks).
      try {
        frozen = await this.sender.updateCard(messageId, freezeState);
      } catch { /* fall through to retry */ }
      if (!frozen) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          frozen = await this.sender.updateCard(messageId, freezeState);
        } catch { /* fall through to background retry */ }
      }
      if (!frozen) {
        this.backgroundFreezeRetry(messageId, freezeState);
      }

      // Result card shows the SDK summary (if any), otherwise a pointer to the turn cards.
      const resultText = state.resultSummary || '_See cards above for full response_';
      const resultState = { ...state, responseText: resultText, cardTitle: '📊 Result' };
      for (let attempt = 0; attempt < FINAL_CARD_RETRIES; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, FINAL_CARD_BASE_DELAY_MS));
          // sendCard swallows transport errors and returns undefined on failure,
          // so we must check the returned message_id — not just rely on no-throw
          // — otherwise all-retries-failed would be misreported as success and
          // the text fallback below would never fire.
          const resultMessageId = await this.sender.sendCard(chatId, resultState);
          if (resultMessageId) {
            succeeded = true;
            break;
          }
          const delay = FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt);
          this.logger.warn({ attempt, delay }, 'Result card send returned no message_id, retrying');
          await new Promise((r) => setTimeout(r, delay));
        } catch {
          const delay = FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt);
          this.logger.warn({ attempt, delay }, 'Result card send threw, retrying');
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    } else {
      // Single-turn / no-split path: update the existing card in place.
      // updateCard signals failure via return value (no-throw contract),
      // so we must check it — otherwise the text fallback below could
      // never fire on real Feishu outages.
      const displayText = lastTurnText || state.responseText || '_See cards above for full response_';
      const cardState = { ...state, responseText: displayText, cardTitle: '📊 Result' };
      for (let attempt = 0; attempt < FINAL_CARD_RETRIES; attempt++) {
        let ok = false;
        try {
          ok = await this.sender.updateCard(messageId, cardState);
        } catch { /* treat as failure */ }
        if (ok) {
          succeeded = true;
          break;
        }
        const delay = FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt);
        this.logger.warn({ attempt, delay, messageId }, 'Final card update failed, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
      if (succeeded && state.resultSummary && chatId) {
        // For single-turn, send the SDK summary as a follow-up message.
        await this.sendTurnText(chatId, state.resultSummary, '📊 Result');
      }
    }

    if (!succeeded && chatId) {
      this.logger.error({ messageId, chatId }, 'All final card retries failed, sending text fallback');
      const statusEmoji = state.status === 'complete' ? '✅' : '❌';
      const summary = (state.resultSummary || lastTurnText || state.responseText || state.errorMessage || 'Task finished').slice(0, 2000);
      try {
        await this.sender.sendText(chatId, `${statusEmoji} ${summary}`);
      } catch { /* last resort failed */ }
    }
  }

  /**
   * Send completed turn text as one or more separate text messages.
   * Splits long text using the same logic as continuation cards.
   * Returns true if at least the first chunk was sent successfully.
   */
  private async sendTurnText(chatId: string, text: string, turnLabel?: string): Promise<boolean> {
    const chunks = splitResponseText(text);
    const total = chunks.length;
    let sentAny = false;
    const prefix = turnLabel || '💬';

    for (let i = 0; i < total; i++) {
      try {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500));
        const title = total > 1 ? `${prefix} (${i + 1}/${total})` : prefix;
        await this.sender.sendTextNotice(chatId, title, chunks[i], 'blue');
        sentAny = true;
      } catch (err) {
        this.logger.warn({ err, chatId, chunk: i + 1, total }, 'Failed to send turn text');
      }
    }
    return sentAny;
  }

  /**
   * Freeze old card and create a new one at the bottom so the card stays below 💬 messages.
   * Returns the new messageId, or the old one if card creation failed.
   */
  private async recreateCard(chatId: string, oldMessageId: string, state: CardState, turnLabel?: string, turnText?: string): Promise<string> {
    // Freeze old card with the completed turn's content so the card itself shows the response.
    const freezeState = { ...state, status: 'complete' as const, responseText: turnText || '', cardTitle: turnLabel };
    let frozen = false;
    // updateCard's contract is no-throw + boolean return on transport failure,
    // but we also defend against unexpected throws (e.g. mocks in tests).
    try {
      frozen = await this.sender.updateCard(oldMessageId, freezeState);
    } catch { /* treat as failure, retry below */ }
    if (!frozen) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        frozen = await this.sender.updateCard(oldMessageId, freezeState);
      } catch { /* treat as failure, fall through to background retry */ }
      if (!frozen) {
        this.logger.warn({ oldMessageId }, 'recreateCard freeze failed after retry, will retry in background');
      }
    }
    // Create new card at bottom for next turn
    let newId: string | undefined;
    try {
      newId = await this.sender.sendCard(chatId, {
        status: 'thinking',
        userPrompt: state.userPrompt,
        responseText: '',
        toolCalls: [],
        startTime: state.startTime,
      }) || undefined;
    } catch { /* fall back to old card */ }
    // Background retries for failed freeze — non-blocking so it doesn't delay the response
    if (!frozen) {
      this.backgroundFreezeRetry(oldMessageId, freezeState);
    }
    return newId || oldMessageId;
  }

  /** Fire-and-forget retries to freeze a card that failed during recreateCard. */
  private backgroundFreezeRetry(messageId: string, freezeState: CardState): void {
    const delays = [3000, 5000, 10000];
    let attempt = 0;
    const retry = () => {
      if (attempt >= delays.length) {
        this.logger.error({ messageId }, 'Background freeze gave up — card may stay stuck in running state');
        return;
      }
      setTimeout(async () => {
        // updateCard is no-throw + boolean on failure; defensive catch for mocks.
        let ok = false;
        try {
          ok = await this.sender.updateCard(messageId, freezeState);
        } catch { /* treat as failure */ }
        if (ok) {
          this.logger.info({ messageId, attempt }, 'Background freeze succeeded');
          return;
        }
        attempt++;
        retry();
      }, delays[attempt]);
    };
    retry();
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

  private async sendCompletionNotice(chatId: string, state: CardState, durationMs: number): Promise<void> {
    // Some senders (WeChat) already send the final response as a standalone message, so skip
    if (this.sender.skipCompletionNotice) return;
    // Only notify for tasks that took a while — quick tasks don't need it
    if (durationMs < 10_000) return;

    const statusEmoji = state.status === 'complete' ? '✅' : '❌';
    const durationStr = durationMs >= 60_000
      ? `${(durationMs / 60_000).toFixed(1)}min`
      : `${(durationMs / 1000).toFixed(0)}s`;
    const costStr = state.sessionCostUsd ? ` · $${state.sessionCostUsd.toFixed(2)}` : (state.costUsd ? ` · $${state.costUsd.toFixed(2)}` : '');
    const statusWord = state.status === 'complete' ? 'Done' : 'Failed';

    // Model display name: strip "claude-" prefix for brevity (e.g. "opus-4-6")
    const modelStr = state.model
      ? ` · ${state.model.replace(/^claude-/, '')}`
      : '';

    // Context usage: show totalTokens / contextWindow as percentage
    let usageStr = '';
    if (state.totalTokens && state.contextWindow) {
      const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
      const tokensK = state.totalTokens >= 1000
        ? `${(state.totalTokens / 1000).toFixed(1)}k`
        : `${state.totalTokens}`;
      const ctxK = `${Math.round(state.contextWindow / 1000)}k`;
      usageStr = ` · ${tokensK}/${ctxK} (${pct}%)`;
    } else if (state.totalTokens) {
      const tokensK = state.totalTokens >= 1000
        ? `${(state.totalTokens / 1000).toFixed(1)}k`
        : `${state.totalTokens}`;
      usageStr = ` · ${tokensK} tokens`;
    }

    const message = `${statusEmoji} ${statusWord} (${durationStr}${costStr}${modelStr}${usageStr})`;

    try {
      await this.sender.sendText(chatId, message);
    } catch (err) {
      this.logger.warn({ err, chatId }, 'Failed to send completion notice');
    }
  }

  async destroy(): Promise<void> {
    for (const [, batch] of this.pendingBatches) {
      clearTimeout(batch.timerId);
    }
    this.pendingBatches.clear();
    const updatePromises: Promise<unknown>[] = [];
    for (const [chatId, task] of this.runningTasks) {
      if (task.questionTimeoutId) {
        clearTimeout(task.questionTimeoutId);
      }
      task.executionHandle.finish();
      task.abortController.abort();
      this.logger.info({ chatId }, 'Aborted running task during shutdown');

      // Send final card update preserving existing content from the processor
      if (task.cardMessageId) {
        const currentState = task.processor.processMessage({ type: 'system', subtype: 'noop' } as any);
        const finalState: CardState = {
          ...currentState,
          status: 'error',
          errorMessage: task.abortReason || 'Service restarted',
        };
        updatePromises.push(
          this.sender.updateCard(task.cardMessageId, finalState).catch(() => {}),
        );
      }
    }
    // Wait briefly for card updates to complete
    await Promise.race([
      Promise.all(updatePromises),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
    this.runningTasks.clear();
    this.sessionManager.destroy();
  }
}

export function isStaleSessionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /no conversation found|conversation not found|session id|invalid session|each tool_use must have a single result|multiple tool_result blocks/i.test(errorMessage);
}

