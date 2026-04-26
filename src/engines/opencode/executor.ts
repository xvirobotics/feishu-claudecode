import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type {
  ApiContext,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
} from '../claude/executor.js';
import {
  createOpenCodeTranslatorState,
  translateOpenCodeJsonEvent,
  type OpenCodeJsonEvent,
} from './jsonl-translator.js';

const isWindows = process.platform === 'win32';

function resolveOpenCodePath(): string {
  if (process.env.OPENCODE_EXECUTABLE_PATH) return process.env.OPENCODE_EXECUTABLE_PATH;
  if (isWindows) {
    const exePaths = [
      'C:\\Users\\<USER>\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe',
      'C:\\Program Files\\opencode\\opencode.exe',
      'opencode',
    ];
    for (const p of exePaths) {
      if (p !== 'opencode') {
        try { execSync(`if exist "${p}" (echo ${p})`, { encoding: 'utf-8', shell: 'cmd.exe' }); } catch { continue; }
      }
    }
    try {
      return execSync('where opencode', { encoding: 'utf-8', shell: 'cmd.exe' }).trim().split(/\r?\n/)[0];
    } catch {
      return 'opencode';
    }
  }
  try {
    return execSync('which opencode', { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return '/usr/local/bin/opencode';
  }
}

const OPENCODE_EXECUTABLE = resolveOpenCodePath();

export function buildOpenCodeArgs(
  opencodeConfig: { model?: string; dangerouslySkipPermissions?: boolean; extraArgs?: string[] },
  sessionId: string | undefined,
  model: string,
  prompt: string,
): string[] {
  const args: string[] = [];
  args.push('run', '--format', 'json');
  if (model) args.push('--model', model);
  if (sessionId) args.push('--continue', '--session', sessionId);
  if (opencodeConfig.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  if (opencodeConfig.extraArgs) {
    for (const extraArg of opencodeConfig.extraArgs) args.push(extraArg);
  }
  args.push('--', prompt);
  return args;
}

export class OpenCodeExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext, model } = options;
    const opencodeConfig = this.config.opencode ?? {};
    const effectiveModel = model ?? opencodeConfig.model ?? 'minimax-cn-coding-plan/MiniMax-M2.5-highspeed';
    const fullPrompt = this.buildPromptWithContext(prompt, outputsDir, apiContext);
    const queue = new AsyncQueue<SDKMessage>();
    const state = createOpenCodeTranslatorState({ model: effectiveModel });
    const args = buildOpenCodeArgs(opencodeConfig, sessionId, effectiveModel, fullPrompt);
    const startTime = Date.now();
    let child: ChildProcess | undefined;
    let sawResult = false;
    let stderr = '';
    let stdoutBuffer = '';

    this.logger.info({ cwd, hasSession: !!sessionId, model: effectiveModel, engine: 'opencode' }, 'Starting OpenCode execution');

    const finishWithError = (message: string): void => {
      if (sawResult) return;
      sawResult = true;
      queue.enqueue({
        type: 'result',
        subtype: abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
        session_id: state.sessionId ?? sessionId,
        duration_ms: Date.now() - startTime,
        result: state.lastAgentText,
        is_error: true,
        errors: [message],
      });
    };

    const emitEvent = (event: OpenCodeJsonEvent): void => {
      if (event.sessionID && !state.sessionId) state.sessionId = event.sessionID;
      const messages = translateOpenCodeJsonEvent(event, state);
      for (const message of messages) {
        if (message.type === 'result') sawResult = true;
        queue.enqueue(message);
      }
    };

    const processStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          emitEvent(JSON.parse(line) as OpenCodeJsonEvent);
        } catch (err) {
          this.logger.warn({ err, line }, 'Failed to parse OpenCode JSONL event');
        }
      }
    };

    try {
      child = spawn(OPENCODE_EXECUTABLE, args, {
        cwd,
        env: { ...process.env, ...(opencodeConfig.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      finishWithError(err instanceof Error ? err.message : String(err));
      queue.finish();
    }

    if (child) {
      if (abortController.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        abortController.signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true });
      }

      child.stdout?.on('data', processStdout);
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.on('error', (err) => {
        finishWithError(err.message);
        queue.finish();
      });
      child.on('close', (code, signal) => {
        if (stdoutBuffer.trim()) {
          try { emitEvent(JSON.parse(stdoutBuffer) as OpenCodeJsonEvent); } catch { /* ignore */ }
        }
        if (code !== 0 && !sawResult) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          finishWithError(`OpenCode exited with ${signal ? `signal ${signal}` : `code ${code}`}${suffix}`);
        }
        if (stderr.trim()) this.logger.debug({ stderr: stderr.trim() }, 'OpenCode stderr');
        queue.finish();
      });
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'opencode' }, 'sendAnswer called on OpenCode executor — not implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'opencode' }, 'resolveQuestion called on OpenCode executor — not implemented');
      },
      finish: () => {
        if (child && !child.killed) child.kill('SIGTERM');
        queue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const msg of handle.stream) yield msg;
    } finally {
      handle.finish();
    }
  }

  private buildPromptWithContext(
    prompt: string,
    outputsDir: string | undefined,
    apiContext: ApiContext | undefined,
  ): string {
    const sections: string[] = [];
    if (outputsDir) {
      sections.push(
        `## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nThe bridge will automatically send files placed there to the user.`,
      );
    }
    if (apiContext) {
      sections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`,
      );
      if (apiContext.groupMembers && apiContext.groupMembers.length > 0) {
        const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
        if (apiContext.groupId) {
          sections.push(
            `## Group Chat\nYou are in a group chat (group: ${apiContext.groupId}) with these bots: ${others.join(', ')}.`,
          );
        }
      }
    }
    if (sections.length === 0) return prompt;
    return `${prompt}\n\n---\n\n${sections.join('\n\n')}`;
  }
}
