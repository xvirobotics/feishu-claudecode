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
} from '../feishu/card-builder.js';
import { ClaudeExecutor } from '../claude/executor.js';
import { StreamProcessor, extractImagePaths } from '../claude/stream-processor.js';
import { SessionManager } from '../claude/session-manager.js';
import { RateLimiter } from './rate-limiter.js';

const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface RunningTask {
  abortController: AbortController;
  startTime: number;
}

export class MessageBridge {
  private executor: ClaudeExecutor;
  private sessionManager: SessionManager;
  private runningTasks = new Map<string, RunningTask>(); // keyed by userId

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

    // Handle commands
    if (text.startsWith('/')) {
      await this.handleCommand(msg);
      return;
    }

    // Check working directory
    if (!this.sessionManager.hasWorkingDirectory(userId)) {
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

    // Check if user already has a running task
    if (this.runningTasks.has(userId)) {
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

        this.sessionManager.setWorkingDirectory(userId, resolvedPath);
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ Working Directory Set', `\`${resolvedPath}\``, 'green'),
        );
        break;
      }

      case '/reset':
        this.sessionManager.resetSession(userId);
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ Session Reset', 'Conversation cleared. Working directory preserved.', 'green'),
        );
        break;

      case '/stop': {
        const task = this.runningTasks.get(userId);
        if (task) {
          task.abortController.abort();
          this.runningTasks.delete(userId);
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
        const session = this.sessionManager.getSession(userId);
        const isRunning = this.runningTasks.has(userId);
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
    const session = this.sessionManager.getSession(userId);
    const cwd = session.workingDirectory!;
    const abortController = new AbortController();

    // Register running task
    this.runningTasks.set(userId, { abortController, startTime: Date.now() });

    // Setup timeout
    const timeoutId = setTimeout(() => {
      this.logger.warn({ userId }, 'Task timeout, aborting');
      abortController.abort();
    }, TASK_TIMEOUT_MS);

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
      this.runningTasks.delete(userId);
      clearTimeout(timeoutId);
      return;
    }

    const rateLimiter = new RateLimiter(1500);
    let lastState: CardState = initialState;

    try {
      const stream = this.executor.execute({
        prompt,
        cwd,
        sessionId: session.sessionId,
        abortController,
      });

      for await (const message of stream) {
        if (abortController.signal.aborted) break;

        const state = processor.processMessage(message);
        lastState = state;

        // Update session ID if discovered
        const newSessionId = processor.getSessionId();
        if (newSessionId && newSessionId !== session.sessionId) {
          this.sessionManager.setSessionId(userId, newSessionId);
        }

        // Throttled card update for non-final states
        if (state.status !== 'complete' && state.status !== 'error') {
          rateLimiter.schedule(() => {
            this.sender.updateCard(messageId, buildCard(state));
          });
        }
      }

      // Flush any pending update
      await rateLimiter.flush();

      // Send final card
      await this.sender.updateCard(messageId, buildCard(lastState));

      // Send any images produced by Claude
      await this.sendOutputImages(chatId, processor, lastState);
    } catch (err: any) {
      this.logger.error({ err, userId }, 'Claude execution error');

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
      this.runningTasks.delete(userId);
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
    for (const [userId, task] of this.runningTasks) {
      task.abortController.abort();
      this.logger.info({ userId }, 'Aborted running task during shutdown');
    }
    this.runningTasks.clear();
    this.sessionManager.destroy();
  }
}
