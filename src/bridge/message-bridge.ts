import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { BotConfig } from '../config.js';
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
import { OutputsManager } from './outputs-manager.js';
import { MemoryClient } from '../memory/memory-client.js';

const TASK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
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
  private outputsManager: OutputsManager;
  private memoryClient: MemoryClient;
  private runningTasks = new Map<string, RunningTask>(); // keyed by chatId

  constructor(
    private config: BotConfig,
    private logger: Logger,
    private sender: MessageSender,
    memoryServerUrl: string,
  ) {
    this.executor = new ClaudeExecutor(config, logger);
    this.sessionManager = new SessionManager(config.claude.defaultWorkingDirectory, logger, config.name);
    this.outputsManager = new OutputsManager(config.claude.outputsBaseDir, logger);
    this.memoryClient = new MemoryClient(memoryServerUrl, logger);
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { userId, chatId, text } = msg;

    // Handle commands (always allowed, even during pending questions)
    if (text.startsWith('/')) {
      await this.handleCommand(msg);
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
    const [cmd] = text.split(/\s+/);

    switch (cmd.toLowerCase()) {
      case '/help':
        await this.sender.sendCard(chatId, buildHelpCard());
        break;

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

      case '/memory': {
        const args = text.slice('/memory'.length).trim();
        await this.handleMemoryCommand(chatId, args);
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
        prompt = `${text}\n\n(Note: Failed to download the image from Feishu)`;
      }
    }

    // Handle file download if present
    if (fileKey && fileName) {
      filePath = path.join(downloadsDir, `${fileKey}_${fileName}`);
      const ok = await this.sender.downloadFile(msgId, fileKey, filePath);
      if (ok) {
        prompt = `${text}\n\n[File saved at: ${filePath}]\nPlease use the Read tool (for text/code files, images, PDFs) or Bash tool (for other formats) to read and analyze this file.`;
      } else {
        prompt = `${text}\n\n(Note: Failed to download the file from Feishu)`;
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
      outputsDir,
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
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      this.logger.warn({ chatId, userId }, 'Task timeout, aborting');
      timedOut = true;
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

        // Break on final states — the multi-turn stream won't close on its own
        if (state.status === 'complete' || state.status === 'error') {
          break;
        }

        // Throttled card update for non-final states
        rateLimiter.schedule(() => {
          this.sender.updateCard(messageId, buildCard(state));
        });
      }

      // Flush any pending rate-limited update before sending final card
      await rateLimiter.flush();

      // If the stream ended without producing a terminal state (no 'result' message),
      // force the card into a terminal state. This happens when:
      // - The execution was aborted (timeout, /stop)
      // - The SDK process crashed or disconnected
      // - AbortError was swallowed in wrapStream
      if (lastState.status !== 'complete' && lastState.status !== 'error') {
        if (timedOut) {
          lastState = {
            ...lastState,
            status: 'error',
            errorMessage: 'Task timed out (1 hour limit)',
          };
        } else if (abortController.signal.aborted) {
          lastState = {
            ...lastState,
            status: 'error',
            errorMessage: 'Task was stopped',
          };
        } else {
          // Stream ended normally without result — treat as complete
          // This can happen if maxTurns is reached or SDK exits cleanly without result
          this.logger.warn({ chatId }, 'Stream ended without result message, forcing complete state');
          lastState = {
            ...lastState,
            status: lastState.responseText ? 'complete' : 'error',
            errorMessage: lastState.responseText ? undefined : 'Claude session ended unexpectedly',
          };
        }
      }

      // Send final card
      await this.sender.updateCard(messageId, buildCard(lastState));

      // Send any output files produced by Claude
      await this.sendOutputFiles(chatId, outputsDir, processor, lastState);
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
      // Cleanup temp downloaded files
      if (imagePath) {
        try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
      }
      if (filePath) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
      // Safety net: clean up outputs directory
      this.outputsManager.cleanup(outputsDir);
    }
  }

  private async handleMemoryCommand(chatId: string, args: string): Promise<void> {
    const [subCmd, ...rest] = args.split(/\s+/);

    if (!subCmd) {
      await this.sender.sendCard(
        chatId,
        buildTextCard(
          '📝 Memory',
          'Usage:\n- `/memory list` — Show folder tree\n- `/memory search <query>` — Search documents\n- `/memory status` — Health check',
          'blue',
        ),
      );
      return;
    }

    try {
      switch (subCmd.toLowerCase()) {
        case 'list': {
          const tree = await this.memoryClient.listFolderTree();
          const formatted = this.memoryClient.formatFolderTree(tree);
          await this.sender.sendCard(
            chatId,
            buildTextCard('📂 Memory Folders', formatted, 'blue'),
          );
          break;
        }
        case 'search': {
          const query = rest.join(' ').trim();
          if (!query) {
            await this.sender.sendCard(chatId, buildTextCard('📝 Memory', 'Usage: `/memory search <query>`', 'blue'));
            return;
          }
          const results = await this.memoryClient.search(query);
          const formatted = this.memoryClient.formatSearchResults(results);
          await this.sender.sendCard(
            chatId,
            buildTextCard(`🔍 Search: ${query}`, formatted, 'blue'),
          );
          break;
        }
        case 'status': {
          const health = await this.memoryClient.health();
          await this.sender.sendCard(
            chatId,
            buildTextCard(
              '📝 Memory Status',
              `Status: ${health.status}\nDocuments: ${health.document_count}\nFolders: ${health.folder_count}`,
              'green',
            ),
          );
          break;
        }
        default:
          await this.sender.sendCard(
            chatId,
            buildTextCard('📝 Memory', `Unknown sub-command: \`${subCmd}\`\nUse \`/memory\` for help.`, 'orange'),
          );
      }
    } catch (err: any) {
      this.logger.error({ err, chatId }, 'Memory command error');
      await this.sender.sendCard(
        chatId,
        buildTextCard('❌ Memory Error', `Failed to connect to memory server: ${err.message}`, 'red'),
      );
    }
  }

  private async sendOutputFiles(
    chatId: string,
    outputsDir: string,
    processor: StreamProcessor,
    state: CardState,
  ): Promise<void> {
    const sentPaths = new Set<string>();

    // 1. Scan the outputs directory for any files Claude placed there
    const outputFiles = this.outputsManager.scanOutputs(outputsDir);
    for (const file of outputFiles) {
      try {
        if (file.isImage && file.sizeBytes < 10 * 1024 * 1024) {
          this.logger.info({ filePath: file.filePath }, 'Sending output image from outputs dir');
          await this.sender.sendImageFile(chatId, file.filePath);
        } else if (!file.isImage && file.sizeBytes < 30 * 1024 * 1024) {
          // Try file upload first; fall back to sending text content for small text files
          const feishuType = OutputsManager.feishuFileType(file.extension);
          this.logger.info({ filePath: file.filePath, feishuType }, 'Sending output file from outputs dir');
          const sent = await this.sender.sendLocalFile(chatId, file.filePath, file.fileName, feishuType);
          if (!sent && OutputsManager.isTextFile(file.extension) && file.sizeBytes < 30 * 1024) {
            this.logger.info({ filePath: file.filePath }, 'File upload failed, sending as text message');
            const content = fs.readFileSync(file.filePath, 'utf-8');
            await this.sender.sendText(chatId, `📄 ${file.fileName}\n\n${content}`);
          }
        } else {
          this.logger.warn({ filePath: file.filePath, sizeBytes: file.sizeBytes }, 'Output file too large to send');
        }
        sentPaths.add(file.filePath);
      } catch (err) {
        this.logger.warn({ err, filePath: file.filePath }, 'Failed to send output file');
      }
    }

    // 2. Fallback: send images detected via old method (Write tool tracking + response text scanning)
    const imagePaths = new Set<string>(processor.getImagePaths());
    if (state.responseText) {
      for (const p of extractImagePaths(state.responseText)) {
        imagePaths.add(p);
      }
    }

    for (const imgPath of imagePaths) {
      if (sentPaths.has(imgPath)) continue; // Already sent from outputs dir
      try {
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).isFile()) {
          const size = fs.statSync(imgPath).size;
          if (size > 0 && size < 10 * 1024 * 1024) {
            this.logger.info({ imgPath }, 'Sending output image (fallback)');
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
