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

const TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to answer
const MAX_QUEUE_SIZE = 5; // max queued messages per chat
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour idle → abort
const FINAL_CARD_RETRIES = 3;
const FINAL_CARD_BASE_DELAY_MS = 2000;
const TASK_TIMEOUT_MESSAGE = 'Task timed out (24 hour limit)';
const IDLE_TIMEOUT_MESSAGE = 'Task aborted: no activity for 1 hour';

interface RunningTask {
  abortController: AbortController;
  startTime: number;
  executionHandle: ExecutionHandle;
  pendingQuestion: PendingQuestion | null;
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
}

export interface ApiTaskResult {
  success: boolean;
  responseText: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

export class MessageBridge {
  private executor: ClaudeExecutor;
  private sessionManager: SessionManager;
  private outputsManager: OutputsManager;
  private audit: AuditLogger;
  private commandHandler: CommandHandler;
  private outputHandler: OutputHandler;
  readonly costTracker: CostTracker;
  private runningTasks = new Map<string, RunningTask>(); // keyed by chatId
  private messageQueues = new Map<string, IncomingMessage[]>(); // per-chatId message queue

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

  /** Inject the doc sync service for /sync commands. */
  setDocSync(docSync: DocSync): void {
    this.commandHandler.setDocSync(docSync);
  }

  isBusy(chatId: string): boolean {
    return this.runningTasks.has(chatId);
  }

  private stopTask(chatId: string): void {
    const task = this.runningTasks.get(chatId);
    if (!task) return;
    if (task.questionTimeoutId) clearTimeout(task.questionTimeoutId);
    task.executionHandle.finish();
    task.abortController.abort();
    this.runningTasks.delete(chatId);
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
      this.audit.log({ event: 'task_queued', botName: this.config.name, chatId, userId: msg.userId, prompt: text, meta: { position: queue.length } });
      await this.sender.sendTextNotice(
        chatId,
        '📋 Queued',
        `Your message has been queued (position #${queue.length}). It will run after the current task finishes.`,
        'blue',
      );
      return;
    }

    // Execute Claude query
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
    const firstQuestion = pending.questions[0];
    let answerText: string;

    if (firstQuestion) {
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= firstQuestion.options.length) {
        answerText = firstQuestion.options[num - 1].label;
      } else {
        answerText = trimmed;
      }
    } else {
      answerText = trimmed;
    }

    const answers: Record<string, string> = {};
    if (firstQuestion) {
      for (const q of pending.questions) {
        answers[q.header] = answerText;
      }
    }
    const answerJson = JSON.stringify({ answers });

    if (task.questionTimeoutId) {
      clearTimeout(task.questionTimeoutId);
      task.questionTimeoutId = undefined;
    }
    task.pendingQuestion = null;
    task.processor.clearPendingQuestion();

    const sessionId = task.processor.getSessionId() || '';
    task.executionHandle.sendAnswer(pending.toolUseId, sessionId, answerJson);

    this.logger.info({ chatId, answer: answerText, toolUseId: pending.toolUseId }, 'Sent user answer to Claude');

    // Update the card: remove question UI, show "running" with answer confirmation
    const currentState = task.processor.getCurrentState();
    await this.sender.updateCard(task.cardMessageId, {
      ...currentState,
      status: 'running',
      responseText: currentState.responseText
        ? currentState.responseText + `\n\n> **Reply:** ${answerText}\n\n_Continuing..._`
        : `> **Reply:** ${answerText}\n\n_Continuing..._`,
    });
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

    // Prepare per-chat outputs directory
    const outputsDir = this.outputsManager.prepareDir(chatId);

    // Send initial "thinking" card
    const displayPrompt = fileKey ? '📎 ' + text : imageKey ? '🖼️ ' + text : text;
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
      cardMessageId: messageId,
      processor,
      rateLimiter,
      chatId,
    };
    this.runningTasks.set(chatId, runningTask);
    metrics.setGauge('metabot_active_tasks', this.runningTasks.size);

    this.audit.log({ event: 'task_start', botName: this.config.name, chatId, userId, prompt: text });

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
          runningTask.pendingQuestion = state.pendingQuestion;

          await rateLimiter.flush();
          await this.sender.updateCard(messageId, state);

          runningTask.questionTimeoutId = setTimeout(() => {
            this.logger.warn({ chatId }, 'Question timeout, auto-answering');
            const pending = runningTask.pendingQuestion;
            if (pending) {
              runningTask.pendingQuestion = null;
              processor.clearPendingQuestion();
              const sid = processor.getSessionId() || '';
              const autoAnswer = JSON.stringify({ answers: { _timeout: '用户未及时回复，请自行判断继续' } });
              executionHandle.sendAnswer(pending.toolUseId, sid, autoAnswer);
            }
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

        // Throttled card update for non-final states
        rateLimiter.schedule(() => {
          this.sender.updateCard(messageId, state);
        });
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
      this.costTracker.record({ botName: this.config.name, userId, success: lastState.status === 'complete', costUsd: lastState.costUsd, durationMs });
      metrics.incCounter('metabot_tasks_total');
      metrics.incCounter('metabot_tasks_by_status', lastState.status === 'complete' ? 'success' : 'error');
      metrics.observeHistogram('metabot_task_duration_seconds', durationMs / 1000);
      if (lastState.costUsd) metrics.observeHistogram('metabot_task_cost_usd', lastState.costUsd);

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
          this.costTracker.record({ botName: this.config.name, userId, success: lastState.status === 'complete', costUsd: lastState.costUsd, durationMs });
          metrics.incCounter('metabot_tasks_total');
          metrics.incCounter('metabot_tasks_by_status', lastState.status === 'complete' ? 'success' : 'error');

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
      this.runningTasks.delete(chatId);
      metrics.setGauge('metabot_active_tasks', this.runningTasks.size);
      this.processQueue(chatId);
      if (imagePath) {
        try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
      }
      if (filePath) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
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

    let messageId: string | undefined;
    if (sendCards) {
      const initialState: CardState = {
        status: 'thinking',
        userPrompt: displayPrompt,
        responseText: '',
        toolCalls: [],
      };
      messageId = await this.sender.sendCard(chatId, initialState);
    }

    const apiContext = { botName: this.config.name, chatId };

    const executionHandle = this.executor.startExecution({
      prompt,
      cwd,
      sessionId: session.sessionId,
      abortController,
      outputsDir,
      apiContext,
    });

    const startTime = Date.now();
    const runningTask: RunningTask = {
      abortController,
      startTime,
      executionHandle,
      pendingQuestion: null,
      cardMessageId: messageId || '',
      processor,
      rateLimiter,
      chatId,
    };
    this.runningTasks.set(chatId, runningTask);
    metrics.setGauge('metabot_active_tasks', this.runningTasks.size);

    this.audit.log({ event: 'api_task_start', botName: this.config.name, chatId, userId, prompt });

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
          processor.clearPendingQuestion();
          const sid = processor.getSessionId() || '';
          const autoAnswer = JSON.stringify({ answers: { _auto: 'Please decide on your own and proceed.' } });
          executionHandle.sendAnswer(pending.toolUseId, sid, autoAnswer);
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
        }
        await rateLimiter.cancelAndWait();
      }

      if (sendCards && messageId) {
        await this.sendFinalCard(messageId, lastState, chatId);
      }

      await this.outputHandler.sendOutputFiles(chatId, outputsDir, processor, lastState);

      const durationMs = Date.now() - startTime;
      this.audit.log({
        event: 'api_task_complete', botName: this.config.name, chatId, userId, prompt,
        durationMs, costUsd: lastState.costUsd, error: lastState.errorMessage,
      });
      this.costTracker.record({ botName: this.config.name, userId, success: lastState.status === 'complete', costUsd: lastState.costUsd, durationMs });
      metrics.incCounter('metabot_api_tasks_total');
      metrics.observeHistogram('metabot_task_duration_seconds', durationMs / 1000);
      if (lastState.costUsd) metrics.observeHistogram('metabot_task_cost_usd', lastState.costUsd);

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
          }
          await rateLimiter.cancelAndWait();

          if (sendCards && messageId) {
            await this.sendFinalCard(messageId, lastState, chatId);
          }

          await this.outputHandler.sendOutputFiles(chatId, outputsDir, processor, lastState);

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
      try {
        await this.sender.updateCard(messageId, state);
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, FINAL_CARD_BASE_DELAY_MS));
          await this.sender.updateCard(messageId, state);
        }
        return;
      } catch {
        const delay = FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt);
        this.logger.warn({ attempt, delay, messageId }, 'Final card update failed, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
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
  private async sendCompletionNotice(chatId: string, state: CardState, durationMs: number): Promise<void> {
    // Only notify for tasks that took a while — quick tasks don't need it
    if (durationMs < 10_000) return;

    const statusEmoji = state.status === 'complete' ? '✅' : '❌';
    const durationStr = durationMs >= 60_000
      ? `${(durationMs / 60_000).toFixed(1)}min`
      : `${(durationMs / 1000).toFixed(0)}s`;
    const costStr = state.costUsd ? ` · $${state.costUsd.toFixed(2)}` : '';
    const statusWord = state.status === 'complete' ? 'Task completed' : 'Task failed';
    const message = `${statusEmoji} ${statusWord} (${durationStr}${costStr})`;

    try {
      await this.sender.sendText(chatId, message);
    } catch (err) {
      this.logger.warn({ err, chatId }, 'Failed to send completion notice');
    }
  }

  destroy(): void {
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

