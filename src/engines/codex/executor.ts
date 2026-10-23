import { startAppServerRun, type AppServerRun } from './app-server.js';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BotConfigBase, CodexBotConfig, CodexReasoningEffort } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type {
  ApiContext,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
} from '../claude/executor.js';
import { buildMetaBotApiPromptContext } from '../prompt-context.js';
import {
  createCodexTranslatorState,
  translateCodexJsonEvent,
  type CodexJsonEvent,
} from './jsonl-translator.js';

const isWindows = process.platform === 'win32';
const FALLBACK_CODEX_CONTEXT_WINDOW = 272000;
const CODEX_AUTH_ENV_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
const CODEX_EXIT_GRACE_MS = 1000;

function findWindowsCodexBinary(npmPrefix: string | undefined): string | undefined {
  if (!npmPrefix) return undefined;

  const target = process.arch === 'arm64'
    ? { packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
    : { packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' };
  const candidate = path.join(
    npmPrefix,
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    target.packageName,
    'vendor',
    target.triple,
    'bin',
    'codex.exe',
  );
  return existsSync(candidate) ? candidate : undefined;
}

export function buildCodexSpawnCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform !== 'win32') return { command: executable, args };

  if (path.basename(executable).toLowerCase() === 'codex.cmd') {
    const codexScript = path.join(
      path.dirname(executable),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (existsSync(codexScript)) {
      return { command: process.execPath, args: [codexScript, ...args] };
    }
    throw new Error(`Unable to resolve Codex npm entrypoint for ${executable}`);
  }

  if (/\.(?:cmd|bat)$/i.test(executable)) {
    throw new Error(`Codex executable must be a native executable on Windows: ${executable}`);
  }
  return { command: executable, args };
}

export function resolveCodexPath(explicitPath?: string): string {
  const override = explicitPath || process.env.CODEX_EXECUTABLE_PATH;
  if (override && existsSync(override)) return override;

  try {
    if (isWindows) {
      const npmPrefix = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : undefined;
      const nativeBinary = findWindowsCodexBinary(npmPrefix);
      if (nativeBinary) return nativeBinary;
    }
    const cmd = isWindows ? 'where codex.cmd' : 'which codex';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    if (!isWindows) {
      const home = os.homedir();
      for (const candidate of [
        path.join(home, '.local', 'bin', 'codex'),
        '/usr/local/bin/codex',
        '/usr/bin/codex',
        '/opt/homebrew/bin/codex',
        path.join(home, '.npm-global', 'bin', 'codex'),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    return 'codex';
  }
}

interface CodexModelMetadata {
  model?: string;
  contextWindow?: number;
}

export function resolveCodexModelMetadata(codexConfig: CodexBotConfig, requestedModel?: string): CodexModelMetadata {
  const model = requestedModel
    || codexConfig.model
    || codexConfig.displayModel
    || readCodexConfigModel(codexConfig.profile)
    || readDefaultModelFromCache();
  return {
    model,
    contextWindow: codexConfig.contextWindow ?? readContextWindowFromCache(model) ?? (model ? FALLBACK_CODEX_CONTEXT_WINDOW : undefined),
  };
}

function readCodexConfigModel(profile?: string): string | undefined {
  const configPath = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'config.toml')
    : path.join(os.homedir(), '.codex', 'config.toml');
  try {
    const text = readFileSync(configPath, 'utf-8');
    const profileModel = profile ? readTomlSectionValue(text, `profiles.${profile}`, 'model') : undefined;
    return profileModel ?? readTomlTopLevelValue(text, 'model');
  } catch {
    return undefined;
  }
}

function readDefaultModelFromCache(): string | undefined {
  return readModelsCache()?.models?.find((m) => m.slug)?.slug;
}

function readContextWindowFromCache(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const found = readModelsCache()?.models?.find((m) => m.slug === model);
  return found?.context_window ?? found?.max_context_window;
}

function readModelsCache(): { models?: Array<{ slug?: string; context_window?: number; max_context_window?: number }> } | undefined {
  const cachePath = process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'models_cache.json')
    : path.join(os.homedir(), '.codex', 'models_cache.json');
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as { models?: Array<{ slug?: string; context_window?: number; max_context_window?: number }> };
  } catch {
    return undefined;
  }
}

interface CodexTokenCountSnapshot {
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  contextWindow?: number;
}

function readLastTokenCountFromSession(sessionId: string | undefined): CodexTokenCountSnapshot | undefined {
  if (!sessionId) return undefined;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  const sessionPath = findCodexSessionFile(sessionsDir, sessionId);
  if (!sessionPath) return undefined;

  try {
    const lines = readFileSync(sessionPath, 'utf-8').trimEnd().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      const rec = JSON.parse(lines[i]) as {
        type?: string;
        payload?: {
          type?: string;
          info?: {
            last_token_usage?: CodexTokenCountSnapshot['usage'];
            model_context_window?: number;
          };
        };
      };
      if (rec.type !== 'event_msg' || rec.payload?.type !== 'token_count') continue;
      const usage = rec.payload.info?.last_token_usage;
      if (!usage) return undefined;
      return {
        usage,
        contextWindow: rec.payload.info?.model_context_window,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function findCodexSessionFile(root: string, sessionId: string): string | undefined {
  try {
    if (!existsSync(root)) return undefined;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        let stat;
        try { stat = statSync(fullPath); } catch { continue; }
        if (stat.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.endsWith('.jsonl') && entry.includes(sessionId)) {
          return fullPath;
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function applyTokenCountSnapshot(message: SDKMessage, snapshot: CodexTokenCountSnapshot | undefined): SDKMessage {
  if (!snapshot?.usage || !message.modelUsage) return message;
  const model = Object.keys(message.modelUsage)[0];
  if (!model) return message;
  const outputTokens = snapshot.usage.output_tokens ?? 0;
  const inputTokens = typeof snapshot.usage.total_tokens === 'number'
    ? Math.max(0, snapshot.usage.total_tokens - outputTokens)
    : snapshot.usage.input_tokens ?? 0;
  return {
    ...message,
    modelUsage: {
      ...message.modelUsage,
      [model]: {
        ...message.modelUsage[model],
        inputTokens,
        outputTokens,
        contextWindow: snapshot.contextWindow ?? message.modelUsage[model].contextWindow,
      },
    },
  };
}

function readTomlTopLevelValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) return undefined;
    const value = parseTomlStringAssignment(trimmed, key);
    if (value) return value;
  }
  return undefined;
}

function readTomlSectionValue(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      inSection = header[1] === section;
      continue;
    }
    if (!inSection) continue;
    const value = parseTomlStringAssignment(trimmed, key);
    if (value) return value;
  }
  return undefined;
}

function parseTomlStringAssignment(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`^${key}\\s*=\\s*(.+?)(?:\\s+#.*)?$`));
  if (!match) return undefined;
  const raw = match[1].trim();
  const quoted = raw.match(/^["'](.+)["']$/);
  return quoted ? quoted[1] : raw;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the environment for the Codex CLI child process.
 *
 * When `codex.apiKey` is configured, normalize it to OPENAI_API_KEY and remove
 * other Codex/OpenAI auth env vars first. Codex reports an auth conflict when
 * multiple supported auth env vars are present, so explicit per-bot config
 * must win cleanly over inherited .env / host values.
 */
export function buildCodexEnv(
  codexConfig: CodexBotConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(codexConfig.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }

  const explicitApiKey = codexConfig.apiKey?.trim();
  if (explicitApiKey) {
    for (const key of CODEX_AUTH_ENV_VARS) delete env[key];
    env.OPENAI_API_KEY = explicitApiKey;
  }

  return env;
}

/**
 * Build the argv array for `codex exec`. Exported for unit testing.
 * Values are passed as discrete argv entries (never through a shell), so
 * `extraArgs` / `profile` / `model` cannot introduce shell-injection even
 * if they contain metacharacters — but they will still be visible to the
 * Codex CLI as literal arguments.
 */
export function buildCodexArgs(
  codexConfig: CodexBotConfig,
  cwd: string,
  prompt: string,
  sessionId: string | undefined,
  model: string | undefined,
  reasoningEffort?: CodexReasoningEffort,
): string[] {
  const args: string[] = [];

  if (codexConfig.dangerouslyBypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-a', codexConfig.approvalPolicy ?? 'never');
    args.push('--sandbox', codexConfig.sandbox ?? 'workspace-write');
  }

  args.push('-C', cwd);
  if (model) args.push('-m', model);
  if (codexConfig.profile) args.push('-p', codexConfig.profile);
  if (codexConfig.baseUrl) args.push('-c', `openai_base_url=${tomlString(codexConfig.baseUrl)}`);
  const effectiveEffort = reasoningEffort ?? codexConfig.reasoningEffort;
  if (effectiveEffort) args.push('-c', `model_reasoning_effort=${tomlString(effectiveEffort)}`);
  for (const extraArg of codexConfig.extraArgs ?? []) args.push(extraArg);

  args.push('exec');
  if (sessionId) {
    args.push('resume', '--json', '--skip-git-repo-check', sessionId, prompt);
  } else {
    args.push('--json', '--color', 'never', '--skip-git-repo-check', prompt);
  }
  return args;
}

export class CodexExecutor {
  private appServerRuns = new Map<string, AppServerRun>();

  canSteer(chatId: string): boolean {
    return this.appServerRuns.get(chatId)?.canSteer() ?? false;
  }

  async steer(chatId: string, prompt: string): Promise<'steered' | 'no-active-turn'> {
    return this.appServerRuns.get(chatId)?.steer(prompt) ?? 'no-active-turn';
  }

  private startAppServer(options: ExecutorOptions): ExecutionHandle {
    const config = this.config.codex ?? {};
    const metadata = resolveCodexModelMetadata(config, options.model);
    const args = buildCodexArgs(config, options.cwd, '', undefined, options.model ?? config.model, options.reasoningEffort);
    const command = buildCodexSpawnCommand(resolveCodexPath(config.executable), [
      ...args.slice(0, args.indexOf('exec')), 'app-server', '--listen', 'stdio://',
    ]);
    const run = startAppServerRun({
      command: command.command, args: command.args, env: buildCodexEnv(config),
      cwd: options.cwd, prompt: this.buildPromptWithContext(options.prompt, options.outputsDir, options.apiContext),
      sessionId: options.sessionId, model: metadata.model, contextWindow: metadata.contextWindow,
      effort: options.reasoningEffort ?? config.reasoningEffort,
      approvalPolicy: config.dangerouslyBypassApprovalsAndSandbox ? 'never' : config.approvalPolicy ?? 'never',
      sandbox: config.dangerouslyBypassApprovalsAndSandbox ? 'danger-full-access' : config.sandbox ?? 'workspace-write',
      signal: options.abortController.signal, logger: this.logger,
    });
    const chatId = options.apiContext?.chatId;
    if (chatId) this.appServerRuns.set(chatId, run);
    const finish = run.finish.bind(run);
    run.finish = () => {
      if (chatId && this.appServerRuns.get(chatId) === run) this.appServerRuns.delete(chatId);
      finish();
    };
    return run;
  }

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    if (this.config.codex?.transport === 'app-server') return this.startAppServer(options);
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;
    const codexConfig = this.config.codex ?? {};
    const model = options.model ?? codexConfig.model;
    const modelMetadata = resolveCodexModelMetadata(codexConfig, model);
    const fullPrompt = this.buildPromptWithContext(prompt, outputsDir, apiContext);
    const queue = new AsyncQueue<SDKMessage>();
    const state = createCodexTranslatorState({
      model: modelMetadata.model,
      contextWindow: modelMetadata.contextWindow,
    });
    const args = buildCodexArgs(codexConfig, cwd, fullPrompt, sessionId, model, options.reasoningEffort);
    const startTime = Date.now();
    let child: ChildProcess | undefined;
    let sawResult = false;
    let pendingResult: SDKMessage | undefined;
    let stderr = '';
    let stdoutBuffer = '';
    let terminalResultDelivered = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;

    const executable = resolveCodexPath(codexConfig.executable);
    this.logger.info({ cwd, hasSession: !!sessionId, outputsDir, executable, engine: 'codex' }, 'Starting Codex execution');

    const finishWithError = (message: string): void => {
      if (terminalResultDelivered) return;
      sawResult = true;
      terminalResultDelivered = true;
      queue.enqueue({
        type: 'result',
        subtype: abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
        session_id: state.sessionId ?? sessionId,
        duration_ms: Date.now() - startTime,
        result: state.lastAgentText,
        is_error: true,
        errors: [message],
      });
      queue.finish();
    };

    const deliverPendingResult = (): void => {
      if (!pendingResult || terminalResultDelivered) return;
      terminalResultDelivered = true;
      const snapshot = state.lastUsage
        ? { usage: state.lastUsage, contextWindow: state.contextWindow }
        : readLastTokenCountFromSession(state.sessionId ?? sessionId);
      queue.enqueue(applyTokenCountSnapshot(pendingResult, snapshot));
      queue.finish();

      exitTimer = setTimeout(() => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        this.logger.warn({ pid: child.pid }, 'Codex emitted a terminal result but did not exit; terminating process');
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, CODEX_EXIT_GRACE_MS);
        killTimer.unref?.();
      }, CODEX_EXIT_GRACE_MS);
      exitTimer.unref?.();
    };

    const emitEvent = (event: CodexJsonEvent): void => {
      const messages = translateCodexJsonEvent(event, state);
      for (const message of messages) {
        if (message.type === 'result') {
          sawResult = true;
          pendingResult = message;
          deliverPendingResult();
        } else {
          queue.enqueue(message);
        }
      }
    };

    const processStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          emitEvent(JSON.parse(line) as CodexJsonEvent);
        } catch (err) {
          this.logger.warn({ err, line }, 'Failed to parse Codex JSONL event');
        }
      }
    };

    try {
      const spawnCommand = buildCodexSpawnCommand(executable, args);
      child = spawn(spawnCommand.command, spawnCommand.args, {
        cwd,
        env: buildCodexEnv(codexConfig),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err: any) {
      finishWithError(err?.message || String(err));
      queue.finish();
    }

    if (child) {
      if (abortController.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        abortController.signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true });
      }

      child.stdout?.on('data', processStdout);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        finishWithError(err.message);
      });
      child.on('close', (code, signal) => {
        if (exitTimer) clearTimeout(exitTimer);
        if (stdoutBuffer.trim()) {
          try {
            emitEvent(JSON.parse(stdoutBuffer) as CodexJsonEvent);
          } catch (err) {
            this.logger.warn({ err, line: stdoutBuffer }, 'Failed to parse final Codex JSONL event');
          }
        }
        if (code !== 0 && !sawResult) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          finishWithError(`Codex exited with ${signal ? `signal ${signal}` : `code ${code}`}${suffix}`);
        } else {
          deliverPendingResult();
        }
        if (stderr.trim()) {
          this.logger.debug({ stderr: stderr.trim() }, 'Codex stderr');
        }
        queue.finish();
      });
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'codex' }, 'sendAnswer called on Codex executor — not implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'codex' }, 'resolveQuestion called on Codex executor — not implemented');
      },
      finish: () => {
        if (exitTimer) clearTimeout(exitTimer);
        if (child && !child.killed) child.kill('SIGTERM');
        queue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const msg of handle.stream) {
        yield msg;
      }
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
      sections.push(buildMetaBotApiPromptContext(apiContext));

      if (apiContext.teamContext) sections.push(apiContext.teamContext);

      if (apiContext.groupMembers && apiContext.groupMembers.length > 0) {
        const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
        if (apiContext.groupId) {
          sections.push(
            `## Group Chat\nYou are in a group chat (group: ${apiContext.groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`metabot talk <botName> grouptalk-${apiContext.groupId}-<botName> "message"\``,
          );
        }
      }
    }

    if (sections.length === 0) return prompt;
    return `${prompt}\n\n---\n\n${sections.join('\n\n')}`;
  }
}
