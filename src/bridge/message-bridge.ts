import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage, CardState, PendingQuestion } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import type { DocSync } from '../sync/doc-sync.js';
import { ClaudeExecutor, type ExecutionHandle } from '../claude/executor.js';
import { StreamProcessor } from '../claude/stream-processor.js';
import { SessionManager } from '../claude/session-manager.js';
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
const MAX_QUEUE_SIZE = 5; // max queued messages per chat
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour idle → abort
const FINAL_CARD_RETRIES = 3;
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
    this.executeQuery(next).catch((err) => {
      this.logger.error({ err, chatId }, 'Error processing queued message');
    });
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

    // All questions in this call answered — send combined result
    const answerJson = JSON.stringify({ answers: task.collectedAnswers });

    if (task.questionTimeoutId) {
      clearTimeout(task.questionTimeoutId);
      task.questionTimeoutId = undefined;
    }
    task.pendingQuestion = null;
    task.currentQuestionIndex = 0;
    task.collectedAnswers = {};
    task.processor.clearPendingQuestion();

    const sessionId = task.processor.getSessionId() || '';
    task.executionHandle.sendAnswer(pending.toolUseId, sessionId, answerJson);

    this.logger.info({ chatId, answers: task.collectedAnswers, toolUseId: pending.toolUseId }, 'Sent all answers to Claude');

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

    // No more questions — resume normal execution
    const answerSummary = Object.values(task.collectedAnswers).length > 0
      ? Object.values(task.collectedAnswers).join(', ')
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

    const answerJson = JSON.stringify({ answers: task.collectedAnswers });
    task.pendingQuestion = null;
    task.currentQuestionIndex = 0;
    task.collectedAnswers = {};
    task.processor.clearPendingQuestion();

    const sid = task.processor.getSessionId() || '';
    task.executionHandle.sendAnswer(pending.toolUseId, sid, answerJson);
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
    const processor = new StreamProcessor(displayPrompt);
    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
    };

    const messageId = await this.sender.sendCard(chatId, initialState);

    if (!messageId) {
      this.logger.error('Failed to send initial card, aborting');
      return;
    }

    const apiContext = { botName: this.config.name, chatId };

    // Start multi-turn execution
    const executionHandle = this.executor.startExecution({
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
        lastState = state;

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
          const newSid = processor.getSessionId();
          if (newSid) this.sessionManager.setSessionId(chatId, newSid);
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
            const newSid = processor.getSessionId();
            if (newSid) this.sessionManager.setSessionId(chatId, newSid);
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

    const session = this.sessionManager.getSession(chatId);
    const cwd = session.workingDirectory;
    const abortController = new AbortController();

    const outputsDir = this.outputsManager.prepareDir(chatId);

    const displayPrompt = prompt;
    const processor = new StreamProcessor(displayPrompt);
    const rateLimiter = new RateLimiter(1500);

    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
    };

    let messageId: string | undefined;
    if (sendCards) {
      messageId = await this.sender.sendCard(chatId, initialState);
    }

    // Generate a messageId for onUpdate even if sendCards is false
    const effectiveMessageId = messageId || `api-${chatId}-${Date.now()}`;
    options.onUpdate?.(initialState, effectiveMessageId, false);

    const apiContext = { botName: this.config.name, chatId, groupMembers: options.groupMembers, groupId: options.groupId };

    const executionHandle = this.executor.startExecution({
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

    try {
      for await (const message of executionHandle.stream) {
        if (abortController.signal.aborted) break;
        resetIdleTimer();

        const state = processor.processMessage(message);
        lastState = state;

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
            const sid = processor.getSessionId() || '';
            executionHandle.sendAnswer(pending.toolUseId, sid, answerJson);
          } else {
            // Auto-answer when no onQuestion handler is provided
            processor.clearPendingQuestion();
            const sid = processor.getSessionId() || '';
            const autoAnswer = JSON.stringify({ answers: { _auto: 'Please decide on your own and proceed.' } });
            executionHandle.sendAnswer(pending.toolUseId, sid, autoAnswer);
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

      // Auto-retry with fresh session when Claude can't find the conversation
      if (lastState.status === 'error' && isStaleSessionError(lastState.errorMessage) && session.sessionId) {
        this.logger.info({ chatId }, 'API task: stale session detected, retrying with fresh session');
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
          const newSid = processor.getSessionId();
          if (newSid) this.sessionManager.setSessionId(chatId, newSid);
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

      // Auto-retry with fresh session when Claude can't find the conversation
      const errMsg: string = err.message || '';
      if (isStaleSessionError(errMsg) && session.sessionId) {
        this.logger.info({ chatId }, 'API task: stale session in catch, retrying with fresh session');
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
            const newSid = processor.getSessionId();
            if (newSid) this.sessionManager.setSessionId(chatId, newSid);
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

  private async sendCompletionNotice(chatId: string, state: CardState, durationMs: number): Promise<void> {
    // Some senders (WeChat) already send the final response as a standalone message, so skip
    if (this.sender.skipCompletionNotice) return;
    // Only notify for tasks that took a while — quick tasks don't need it
    if (durationMs < 10_000) return;

    const statusEmoji = state.status === 'complete' ? '✅' : '❌';
    const durationStr = durationMs >= 60_000
      ? `${(durationMs / 60_000).toFixed(1)}min`
      : `${(durationMs / 1000).toFixed(0)}s`;
    const costStr = state.costUsd ? ` · $${state.costUsd.toFixed(2)}` : '';
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
    this.sessionManager.destroy();
  }
}

export function isStaleSessionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /no conversation found|conversation not found|session id|invalid session|multiple.*tool_result.*blocks|each tool_use must have a single result/i.test(errorMessage);
}

