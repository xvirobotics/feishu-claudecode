import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../feishu/event-handler.js';
import { MessageSender } from '../feishu/message-sender.js';
import {
  buildCard,
  buildHelpCard,
  buildStatusCard,
  buildTextCard,
  type CardState,
  type PendingQuestion,
} from '../feishu/card-builder.js';
import { ClaudeExecutor, type ExecutionHandle } from '../claude/executor.js';
import { StreamProcessor, extractImagePaths } from '../claude/stream-processor.js';
import { SessionManager } from '../claude/session-manager.js';
import { RateLimiter } from './rate-limiter.js';

const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to answer

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

export class MessageBridge {
  private executor: ClaudeExecutor;
  private sessionManager: SessionManager;
  private runningTasks = new Map<string, RunningTask>(); // keyed by chatId

  constructor(
    private config: Config,
    private logger: Logger,
    private sender: MessageSender,
  ) {
    this.executor = new ClaudeExecutor(config, logger);
    this.sessionManager = new SessionManager(config.claude.defaultWorkingDirectory, logger);
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { userId, chatId, text } = msg;

    // Handle commands (always allowed, even during pending questions)
    if (text.startsWith('/')) {
      await this.handleCommand(msg);
      return;
    }

    // Check working directory
    if (!this.sessionManager.hasWorkingDirectory(chatId)) {
      await this.sender.sendCard(
        chatId,
        buildTextCard(
          '⚠️ Working Directory Not Set',
          'Please set a working directory first:\n`/cd /path/to/your/project`',
          'orange',
        ),
      );
      return;
    }

    // Check if there's a pending question waiting for an answer
    const task = this.runningTasks.get(chatId);
    if (task && task.pendingQuestion) {
      await this.handleAnswer(msg, task);
      return;
    }

    // Check if this chat already has a running task
    if (this.runningTasks.has(chatId)) {
      await this.sender.sendCard(
        chatId,
        buildTextCard(
          '⏳ Task In Progress',
          'You have a running task. Use `/stop` to abort it, or wait for it to finish.',
          'orange',
        ),
      );
      return;
    }

    // Execute Claude query
    await this.executeQuery(msg);
  }

  private async handleAnswer(msg: IncomingMessage, task: RunningTask): Promise<void> {
    const { chatId, text, imageKey } = msg;
    const pending = task.pendingQuestion!;

    // Reject image replies during pending question
    if (imageKey) {
      await this.sender.sendText(chatId, '请用文字回复选择，或直接输入自定义答案。');
      return;
    }

    // Parse user reply: number → option label, or free text
    const trimmed = text.trim();
    const firstQuestion = pending.questions[0];
    let answerText: string;

    if (firstQuestion) {
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= firstQuestion.options.length) {
        // User picked a numbered option
        answerText = firstQuestion.options[num - 1].label;
      } else {
        // Free text / custom answer
        answerText = trimmed;
      }
    } else {
      answerText = trimmed;
    }

    // Build answer JSON matching AskUserQuestion's expected format
    const answers: Record<string, string> = {};
    if (firstQuestion) {
      // Use a combined key from questions
      for (const q of pending.questions) {
        answers[q.header] = answerText;
      }
    }
    const answerJson = JSON.stringify({ answers });

    // Clear the pending question state
    if (task.questionTimeoutId) {
      clearTimeout(task.questionTimeoutId);
      task.questionTimeoutId = undefined;
    }
    task.pendingQuestion = null;
    task.processor.clearPendingQuestion();

    // Get session ID for the answer message
    const sessionId = task.processor.getSessionId() || '';

    // Send the answer to Claude
    task.executionHandle.sendAnswer(pending.toolUseId, sessionId, answerJson);

    this.logger.info({ chatId, answer: answerText, toolUseId: pending.toolUseId }, 'Sent user answer to Claude');
  }

  private async handleCommand(msg: IncomingMessage): Promise<void> {
    const { userId, chatId, text } = msg;
    const [cmd, ...args] = text.split(/\s+/);
    const arg = args.join(' ').trim();

    switch (cmd.toLowerCase()) {
      case '/help':
        await this.sender.sendCard(chatId, buildHelpCard());
        break;

      case '/cd': {
        if (!arg) {
          await this.sender.sendCard(
            chatId,
            buildTextCard('⚠️ Usage', '`/cd /path/to/project`', 'orange'),
          );
          return;
        }

        // Expand ~ to home directory
        const expanded = arg.startsWith('~') ? arg.replace('~', os.homedir()) : arg;
        const resolvedPath = path.resolve(expanded);

        // Validate directory exists
        try {
          const stat = fs.statSync(resolvedPath);
          if (!stat.isDirectory()) {
            await this.sender.sendCard(
              chatId,
              buildTextCard('❌ Error', `Not a directory: \`${resolvedPath}\``, 'red'),
            );
            return;
          }
        } catch {
          await this.sender.sendCard(
            chatId,
            buildTextCard('❌ Error', `Directory not found: \`${resolvedPath}\``, 'red'),
          );
          return;
        }

        this.sessionManager.setWorkingDirectory(chatId, resolvedPath);
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ Working Directory Set', `\`${resolvedPath}\``, 'green'),
        );
        break;
      }

      case '/reset':
        this.sessionManager.resetSession(chatId);
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ Session Reset', 'Conversation cleared. Working directory preserved.', 'green'),
        );
        break;

      case '/stop': {
        const task = this.runningTasks.get(chatId);
        if (task) {
          if (task.questionTimeoutId) {
            clearTimeout(task.questionTimeoutId);
          }
          task.executionHandle.finish();
          task.abortController.abort();
          this.runningTasks.delete(chatId);
          await this.sender.sendCard(
            chatId,
            buildTextCard('🛑 Stopped', 'Current task has been aborted.', 'orange'),
          );
        } else {
          await this.sender.sendCard(
            chatId,
            buildTextCard('ℹ️ No Running Task', 'There is no task to stop.', 'blue'),
          );
        }
        break;
      }

      case '/status': {
        const session = this.sessionManager.getSession(chatId);
        const isRunning = this.runningTasks.has(chatId);
        await this.sender.sendCard(
          chatId,
          buildStatusCard(userId, session.workingDirectory, session.sessionId, isRunning),
        );
        break;
      }

      default:
        await this.sender.sendCard(
          chatId,
          buildTextCard('❓ Unknown Command', `Unknown command: \`${cmd}\`\nUse \`/help\` for available commands.`, 'orange'),
        );
    }
  }

  private async executeQuery(msg: IncomingMessage): Promise<void> {
    const { userId, chatId, text, imageKey, messageId: msgId } = msg;
    const session = this.sessionManager.getSession(chatId);
    const cwd = session.workingDirectory!;
    const abortController = new AbortController();

    // Handle image download if present
    let prompt = text;
    let imagePath: string | undefined;
    if (imageKey) {
      const tmpDir = path.join(os.tmpdir(), 'feishu-claudecode');
      fs.mkdirSync(tmpDir, { recursive: true });
      imagePath = path.join(tmpDir, `${imageKey}.png`);
      const ok = await this.sender.downloadImage(msgId, imageKey, imagePath);
      if (ok) {
        prompt = `${text}\n\n[Image saved at: ${imagePath}]\nPlease use the Read tool to read and analyze this image file.`;
      } else {
        prompt = `${text}\n\n(Note: Failed to download the image from Feishu)`;
      }
    }

    // Send initial "thinking" card
    const displayPrompt = imageKey ? '🖼️ ' + text : text;
    const processor = new StreamProcessor(displayPrompt);
    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
    };

    const messageId = await this.sender.sendCard(chatId, buildCard(initialState));

    if (!messageId) {
      this.logger.error('Failed to send initial card, aborting');
      return;
    }

    // Start multi-turn execution
    const executionHandle = this.executor.startExecution({
      prompt,
      cwd,
      sessionId: session.sessionId,
      abortController,
    });

    const rateLimiter = new RateLimiter(1500);

    // Register running task
    const runningTask: RunningTask = {
      abortController,
      startTime: Date.now(),
      executionHandle,
      pendingQuestion: null,
      cardMessageId: messageId,
      processor,
      rateLimiter,
      chatId,
    };
    this.runningTasks.set(chatId, runningTask);

    // Setup timeout
    const timeoutId = setTimeout(() => {
      this.logger.warn({ chatId, userId }, 'Task timeout, aborting');
      executionHandle.finish();
      abortController.abort();
    }, TASK_TIMEOUT_MS);

    let lastState: CardState = initialState;

    try {
      for await (const message of executionHandle.stream) {
        if (abortController.signal.aborted) break;

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

          // Immediately update card to show the question
          await rateLimiter.flush();
          await this.sender.updateCard(messageId, buildCard(state));

          // Set question timeout
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

          // The for-await loop will naturally block on stream.next()
          // until Claude produces new messages after receiving the answer
          continue;
        }

        // If we just got a message after answering a question, clear timeout state
        if (runningTask.pendingQuestion === null && runningTask.questionTimeoutId) {
          clearTimeout(runningTask.questionTimeoutId);
          runningTask.questionTimeoutId = undefined;
        }

        // Break on final result — the stream won't end on its own because
        // the AsyncQueue is still open waiting for more user messages.
        if (state.status === 'complete' || state.status === 'error') {
          break;
        }

        // Throttled card update for non-final states
        rateLimiter.schedule(() => {
          this.sender.updateCard(messageId, buildCard(state));
        });
      }

      // Flush any pending update
      await rateLimiter.flush();

      // Send final card
      await this.sender.updateCard(messageId, buildCard(lastState));

      // Send any images produced by Claude
      await this.sendOutputImages(chatId, processor, lastState);
    } catch (err: any) {
      this.logger.error({ err, chatId, userId }, 'Claude execution error');

      const errorState: CardState = {
        status: 'error',
        userPrompt: displayPrompt,
        responseText: lastState.responseText,
        toolCalls: lastState.toolCalls,
        errorMessage: err.message || 'Unknown error',
      };
      await rateLimiter.flush();
      await this.sender.updateCard(messageId, buildCard(errorState));
    } finally {
      clearTimeout(timeoutId);
      if (runningTask.questionTimeoutId) {
        clearTimeout(runningTask.questionTimeoutId);
      }
      executionHandle.finish();
      this.runningTasks.delete(chatId);
      // Cleanup temp image
      if (imagePath) {
        try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
      }
    }
  }

  private async sendOutputImages(
    chatId: string,
    processor: StreamProcessor,
    state: CardState,
  ): Promise<void> {
    // Collect image paths from tool calls and response text
    const imagePaths = new Set<string>(processor.getImagePaths());

    // Also scan response text for image paths
    if (state.responseText) {
      for (const p of extractImagePaths(state.responseText)) {
        imagePaths.add(p);
      }
    }

    // Send each image that exists on disk
    for (const imgPath of imagePaths) {
      try {
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).isFile()) {
          const size = fs.statSync(imgPath).size;
          if (size > 0 && size < 10 * 1024 * 1024) { // Feishu limit: 10MB
            this.logger.info({ imgPath }, 'Sending output image to Feishu');
            await this.sender.sendImageFile(chatId, imgPath);
          }
        }
      } catch (err) {
        this.logger.warn({ err, imgPath }, 'Failed to send output image');
      }
    }
  }

  destroy(): void {
    // Abort all running tasks
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
