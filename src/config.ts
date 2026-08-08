import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTeamConfig } from './agent-teams/team-store.js';

function loadEnvFiles(): void {
  const originalEnv = new Set(Object.keys(process.env));
  const defaultEnvFiles = [
    process.env.METABOT_DEFAULT_ENV_FILE,
    '/etc/metabot/default.env',
    path.join(os.homedir(), '.metabot', 'default.env'),
    path.resolve('.env.defaults'),
  ].filter((p): p is string => !!p);

  const applyEnvFile = (envPath: string, canOverrideDefaults: boolean) => {
    if (!fs.existsSync(envPath)) return;
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    for (const [key, value] of Object.entries(parsed)) {
      if (originalEnv.has(key)) {
        continue;
      }
      if (canOverrideDefaults || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  };

  for (const envPath of defaultEnvFiles) {
    applyEnvFile(envPath, false);
  }
  applyEnvFile(path.resolve('.env'), true);
}

loadEnvFiles();

/** Agent engine backing a bot. */
export type EngineName = 'claude' | 'kimi' | 'codex';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultra'
  ) {
    return normalized;
  }
  return undefined;
}

/** Shared config fields used by MessageBridge and Executors (platform-agnostic). */
export interface BotConfigBase {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  voiceReply?: VoiceReplyConfig;
  /**
   * Visibility in the metabot-core agent bus. When true (default), the bridge
   * registers this bot in the central agent registry so other bridges/CLIs
   * can discover and talk to it. When false, the bot is local-only — its
   * row is either absent from the registry or marked hidden, and peers
   * cannot resolve its URL via `GET /api/agents`.
   *
   * Replaces the previous per-bot `talkSecret` — visibility itself is the
   * permission (only registered bots are reachable, ownership of the
   * credential controls who can register/hide them).
   */
  visible?: boolean;
  /**
   * Default shared flag for `metabot memory create` when no explicit
   * `--share` / `--no-share` is given. When true (default), new docs are
   * cross-bot readable (`shared:true`); when false, new docs are private to
   * the author's namespace (`shared:false`). The write path still defaults to
   * the caller's own `/users/...` namespace unless `--path` / `--folder` is
   * explicitly passed. Omitting the field in bots.json leaves the server-side
   * value sticky — `metabot memory visibility` CLI toggles are preserved
   * across bridge restarts. Setting an explicit value in bots.json pins it and
   * the bridge re-asserts it on every bulk-register.
   */
  memoryPublic?: boolean;
  /** Agent engine. Defaults to 'codex' unless METABOT_ENGINE or bots.json overrides it. */
  engine?: EngineName;
  claude: {
    defaultWorkingDirectory: string;
    maxTurns: number | undefined;
    maxBudgetUsd: number | undefined;
    model: string | undefined;
    /** Explicit Anthropic API key. When set, child Claude Code processes use this
     *  key instead of ~/.claude/.credentials.json. Supports cc-switch compatibility:
     *  leave unset to let Claude Code resolve auth dynamically. */
    apiKey: string | undefined;
    outputsBaseDir: string;
    downloadsDir: string;
    /**
     * Which backend drives Claude Code turns:
     *   - 'pty' (default) — a real interactive `claude` TUI driven over a PTY,
     *                       with structured output reconstructed from the
     *                       session jsonl. Keeps Claude Code SUBSCRIPTION
     *                       billing after the mid-June 2026 Agent-SDK cutoff
     *                       (routed through TeamClaude for Max-account load
     *                       balancing). Only applies to the persistent executor.
     *   - 'sdk'           — the legacy Agent SDK `query()`. Opt-out fallback;
     *                       loses subscription billing after the June 2026 cutoff.
     * Per-bot field (or env CLAUDE_BACKEND=sdk) overrides back to the SDK path.
     */
    backend: 'sdk' | 'pty';
  };
  /** Kimi-specific overrides. Populated only when engine === 'kimi'. Phase 2. */
  kimi?: {
    executable?: string;
    model?: string;
    thinking?: boolean;
    apiKey?: string;
    /** Kimi tool permission policy. Defaults to safe `auto`; `yolo` must be explicit. */
    permissionMode?: 'auto' | 'yolo';
    /** Kimi Code local Server origin. Personal edition accepts loopback only. */
    serverUrl?: string;
    /** Context window size in tokens (defaults to 1M for current Kimi Code). */
    contextWindow?: number;
  };
  /** Codex-specific overrides. Populated only when engine === 'codex'. */
  codex?: CodexBotConfig;
  /**
   * Stage 4 — opt-in to the persistent Claude process pool. When enabled,
   * each chatId is backed by a long-lived Claude Code process (managed by
   * ExecutorRegistry) instead of spawning a fresh process per turn.
   *
   * Benefits:
   *   - Agent Teams teammates survive between user messages
   *   - /goal multi-turn auto-drive works (Stop hook fires the next turn)
   *   - /background tasks and agentProgressSummaries actually persist
   *
   * Per-bot field overrides the global METABOT_PERSISTENT_EXECUTOR env var
   * (true here forces on, false here forces off). Only applies when the
   * bot's engine is 'claude'.
   */
  persistentExecutor?: {
    enabled?: boolean;
    /** Idle timeout (ms) before the executor self-shuts. 0 disables. Default 30 min. */
    idleTimeoutMs?: number;
    /** Max concurrent executors per bot (LRU-evicted past this). Default 20. */
    maxConcurrent?: number;
  };
}

export interface VoiceReplyConfig {
  enabled?: boolean;
  provider?: string;
  voice?: string;
  maxChars?: number;
  summaryProvider?: 'none' | 'openai';
  summaryModel?: string;
}

/** Codex-specific overrides. Populated only when engine === 'codex'. */
export interface CodexBotConfig {
  executable?: string;
  model?: string;
  displayModel?: string;
  profile?: string;
  /** Explicit OpenAI-compatible API key for Codex CLI API-key mode. */
  apiKey?: string;
  /** OpenAI-compatible API base URL for Codex CLI API-key mode. */
  baseUrl?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Context window size in tokens for display only. */
  contextWindow?: number;
  /** Default reasoning effort for Codex CLI (`model_reasoning_effort`). */
  reasoningEffort?: CodexReasoningEffort;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/** Feishu bot config (extends base with Feishu credentials). */
export interface BotConfig extends BotConfigBase {
  feishu: {
    appId: string;
    appSecret: string;
  };
  /** When true, respond to all messages in group chats without requiring @mention. */
  groupNoMention?: boolean;
}

/** Telegram bot config (extends base with Telegram credentials). */
export interface TelegramBotConfig extends BotConfigBase {
  telegram: {
    botToken: string;
  };
}

/** WeChat bot config (extends base with iLink credentials). */
export interface WechatBotConfig extends BotConfigBase {
  wechat: {
    ilinkBaseUrl?: string;
    botToken?: string;
  };
}

/** Slack bot config (Events API + Web API). */
export interface SlackBotConfig extends BotConfigBase {
  slack: {
    botToken: string;
    signingSecret: string;
    /** Optional bot user ID. If omitted, startup tries Slack auth.test. */
    botUserId?: string;
  };
  /** When true, respond to all channel/group messages without requiring @mention. */
  groupNoMention?: boolean;
}

export interface PeerConfig {
  name: string;
  url: string;
  secret?: string;
}

export interface AppConfig {
  feishuBots: BotConfig[];
  telegramBots: TelegramBotConfig[];
  webBots: BotConfigBase[];
  wechatBots: WechatBotConfig[];
  slackBots: SlackBotConfig[];
  /** Dedicated Feishu service app for wiki sync & doc reader (independent of chat bots). */
  feishuService?: {
    appId: string;
    appSecret: string;
  };
  log: {
    level: string;
  };
  api: {
    port: number;
    secret?: string;
  };
  /** Peer MetaBot instances for cross-instance bot discovery and task delegation. */
  peers: PeerConfig[];
  /** Resident MetaBot Agent Teams reconciled into the bridge runtime. */
  agentTeams: AgentTeamConfig[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function expandUserPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  if (!value) return value;
  // Resolve relative paths (".", "./x", "x/y") to absolute. Required because
  // the PTY backend derives a session's jsonl path by escaping cwd
  // (cwd.replace(/\//g,'-')); a relative cwd like "." escapes to "." and the
  // scanner tails a non-existent dir → claude runs but the Feishu card renders
  // BLANK. (Seen 2026-05-30: the `metabot` bot's defaultWorkingDirectory was
  // ".".) Absolute paths pass through unchanged.
  return path.isAbsolute(value) ? value : path.resolve(value);
}

// --- Feishu JSON entry (used in bots.json) ---

/** Kimi-specific overrides in bots.json. */
export interface KimiJsonConfig {
  executable?: string;
  model?: string;
  thinking?: boolean;
  apiKey?: string;
  /** Kimi tool permission policy. Defaults to safe `auto`; `yolo` must be explicit. */
  permissionMode?: 'auto' | 'yolo';
  /** Kimi Code local Server origin. Personal edition accepts loopback only. */
  serverUrl?: string;
  /** Context window size in tokens (defaults to 1M for current Kimi Code). */
  contextWindow?: number;
}

/** Codex-specific overrides in bots.json. */
export interface CodexJsonConfig {
  executable?: string;
  model?: string;
  displayModel?: string;
  profile?: string;
  /** Explicit OpenAI-compatible API key for Codex CLI API-key mode. */
  apiKey?: string;
  /** OpenAI-compatible API base URL for Codex CLI API-key mode. */
  baseUrl?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Context window size in tokens for display only. */
  contextWindow?: number;
  reasoningEffort?: CodexReasoningEffort;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/** Fields shared across all bot JSON entries (engine selection and engine overrides). */
interface EngineJsonFields {
  engine?: EngineName;
  kimi?: KimiJsonConfig;
  codex?: CodexJsonConfig;
  /** Claude turn backend: 'pty' (default) or 'sdk' (legacy opt-out). Overrides env CLAUDE_BACKEND. */
  backend?: 'sdk' | 'pty';
}

export interface FeishuBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  voiceReply?: VoiceReplyConfig;
  /** See BotConfigBase.visible — defaults to true if omitted. */
  visible?: boolean;
  /** See BotConfigBase.memoryPublic — defaults to true if omitted. */
  memoryPublic?: boolean;
  feishuAppId: string;
  feishuAppSecret: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
  /** When true, respond to all messages in group chats without requiring @mention. */
  groupNoMention?: boolean;
}

function feishuBotFromJson(entry: FeishuBotJsonEntry): BotConfig {
  const codex = buildCodexConfig(entry.codex);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    ...(entry.ttsVoice ? { ttsVoice: entry.ttsVoice } : {}),
    ...(entry.voiceReply ? { voiceReply: entry.voiceReply } : {}),
    ...(entry.visible !== undefined ? { visible: entry.visible } : {}),
    ...(entry.memoryPublic !== undefined ? { memoryPublic: entry.memoryPublic } : {}),
    ...(entry.groupNoMention ? { groupNoMention: true } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    feishu: {
      appId: entry.feishuAppId,
      appSecret: entry.feishuAppSecret,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Telegram JSON entry (used in bots.json) ---

export interface TelegramBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  voiceReply?: VoiceReplyConfig;
  /** See BotConfigBase.visible — defaults to true if omitted. */
  visible?: boolean;
  /** See BotConfigBase.memoryPublic — defaults to true if omitted. */
  memoryPublic?: boolean;
  telegramBotToken: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function telegramBotFromJson(entry: TelegramBotJsonEntry): TelegramBotConfig {
  const codex = buildCodexConfig(entry.codex);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    ...(entry.ttsVoice ? { ttsVoice: entry.ttsVoice } : {}),
    ...(entry.voiceReply ? { voiceReply: entry.voiceReply } : {}),
    ...(entry.visible !== undefined ? { visible: entry.visible } : {}),
    ...(entry.memoryPublic !== undefined ? { memoryPublic: entry.memoryPublic } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    telegram: {
      botToken: entry.telegramBotToken,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Web bot JSON entry (used in bots.json — no IM credentials needed) ---

export interface WebBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  voiceReply?: VoiceReplyConfig;
  /** See BotConfigBase.visible — defaults to true if omitted. */
  visible?: boolean;
  /** See BotConfigBase.memoryPublic — defaults to true if omitted. */
  memoryPublic?: boolean;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

export function webBotFromJson(entry: WebBotJsonEntry): BotConfigBase {
  const codex = buildCodexConfig(entry.codex);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    ...(entry.ttsVoice ? { ttsVoice: entry.ttsVoice } : {}),
    ...(entry.voiceReply ? { voiceReply: entry.voiceReply } : {}),
    ...(entry.visible !== undefined ? { visible: entry.visible } : {}),
    ...(entry.memoryPublic !== undefined ? { memoryPublic: entry.memoryPublic } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    claude: buildClaudeConfig(entry),
  };
}

// --- WeChat JSON entry (used in bots.json) ---

export interface WechatBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  /** See BotConfigBase.visible — defaults to true if omitted. */
  visible?: boolean;
  /** See BotConfigBase.memoryPublic — defaults to true if omitted. */
  memoryPublic?: boolean;
  ilinkBaseUrl?: string;
  wechatBotToken?: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function wechatBotFromJson(entry: WechatBotJsonEntry): WechatBotConfig {
  const codex = buildCodexConfig(entry.codex);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.visible !== undefined ? { visible: entry.visible } : {}),
    ...(entry.memoryPublic !== undefined ? { memoryPublic: entry.memoryPublic } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    wechat: {
      ilinkBaseUrl: entry.ilinkBaseUrl,
      botToken: entry.wechatBotToken,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Slack JSON entry (used in bots.json) ---

export interface SlackBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  voiceReply?: VoiceReplyConfig;
  /** See BotConfigBase.visible — defaults to true if omitted. */
  visible?: boolean;
  /** See BotConfigBase.memoryPublic — defaults to true if omitted. */
  memoryPublic?: boolean;
  slackBotToken: string;
  slackSigningSecret: string;
  slackBotUserId?: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
  /** When true, respond to all channel/group messages without requiring @mention. */
  groupNoMention?: boolean;
}

function slackBotFromJson(entry: SlackBotJsonEntry): SlackBotConfig {
  const codex = buildCodexConfig(entry.codex);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    ...(entry.ttsVoice ? { ttsVoice: entry.ttsVoice } : {}),
    ...(entry.voiceReply ? { voiceReply: entry.voiceReply } : {}),
    ...(entry.visible !== undefined ? { visible: entry.visible } : {}),
    ...(entry.memoryPublic !== undefined ? { memoryPublic: entry.memoryPublic } : {}),
    ...(entry.groupNoMention ? { groupNoMention: true } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    slack: {
      botToken: entry.slackBotToken,
      signingSecret: entry.slackSigningSecret,
      ...(entry.slackBotUserId ? { botUserId: entry.slackBotUserId } : {}),
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Shared Claude config builder ---

function buildClaudeConfig(entry: {
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
  backend?: 'sdk' | 'pty';
}): BotConfigBase['claude'] {
  const backendEnv = process.env.CLAUDE_BACKEND;
  return {
    defaultWorkingDirectory: expandUserPath(entry.defaultWorkingDirectory),
    backend: entry.backend ?? (backendEnv === 'sdk' ? 'sdk' : 'pty'),
    maxTurns: entry.maxTurns ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined),
    maxBudgetUsd:
      entry.maxBudgetUsd ??
      (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    model: entry.model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-fable-5',
    apiKey: entry.apiKey || undefined,
    outputsBaseDir:
      entry.outputsBaseDir ||
      process.env.OUTPUTS_BASE_DIR ||
      path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
    downloadsDir:
      entry.downloadsDir ||
      process.env.DOWNLOADS_DIR ||
      path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
  };
}

function buildCodexConfig(entry?: CodexJsonConfig): BotConfigBase['codex'] | undefined {
  const envReasoningEffort = normalizeCodexReasoningEffort(process.env.CODEX_REASONING_EFFORT);
  const cfg: BotConfigBase['codex'] = {
    ...(process.env.CODEX_EXECUTABLE_PATH ? { executable: process.env.CODEX_EXECUTABLE_PATH } : {}),
    ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
    ...(process.env.CODEX_DISPLAY_MODEL ? { displayModel: process.env.CODEX_DISPLAY_MODEL } : {}),
    ...(process.env.CODEX_PROFILE ? { profile: process.env.CODEX_PROFILE } : {}),
    ...(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
      ? { apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY }
      : {}),
    ...(process.env.CODEX_BASE_URL || process.env.OPENAI_BASE_URL
      ? { baseUrl: process.env.CODEX_BASE_URL || process.env.OPENAI_BASE_URL }
      : {}),
    ...(process.env.CODEX_APPROVAL_POLICY
      ? { approvalPolicy: process.env.CODEX_APPROVAL_POLICY as CodexJsonConfig['approvalPolicy'] }
      : {}),
    ...(process.env.CODEX_SANDBOX ? { sandbox: process.env.CODEX_SANDBOX as CodexJsonConfig['sandbox'] } : {}),
    ...(process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX === 'true'
      ? { dangerouslyBypassApprovalsAndSandbox: true }
      : {}),
    ...(process.env.CODEX_CONTEXT_WINDOW ? { contextWindow: parseInt(process.env.CODEX_CONTEXT_WINDOW, 10) } : {}),
    ...(envReasoningEffort ? { reasoningEffort: envReasoningEffort } : {}),
    ...(entry ?? {}),
  };
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

// --- Single-bot env var mode ---

function feishuBotFromEnv(): BotConfig {
  const codex = buildCodexConfig();
  return {
    name: 'default',
    ...(process.env.METABOT_ENGINE ? { engine: process.env.METABOT_ENGINE as EngineName } : {}),
    ...(codex ? { codex } : {}),
    feishu: {
      appId: required('FEISHU_APP_ID'),
      appSecret: required('FEISHU_APP_SECRET'),
    },
    claude: {
      defaultWorkingDirectory: expandUserPath(required('CLAUDE_DEFAULT_WORKING_DIRECTORY')),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-fable-5',
      apiKey: undefined,
      outputsBaseDir:
        process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
      backend: process.env.CLAUDE_BACKEND === 'sdk' ? 'sdk' : 'pty',
    },
  };
}

function telegramBotFromEnv(): TelegramBotConfig {
  const codex = buildCodexConfig();
  return {
    name: 'telegram-default',
    ...(process.env.METABOT_ENGINE ? { engine: process.env.METABOT_ENGINE as EngineName } : {}),
    ...(codex ? { codex } : {}),
    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
    },
    claude: {
      defaultWorkingDirectory: expandUserPath(required('CLAUDE_DEFAULT_WORKING_DIRECTORY')),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-fable-5',
      apiKey: undefined,
      outputsBaseDir:
        process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
      backend: process.env.CLAUDE_BACKEND === 'sdk' ? 'sdk' : 'pty',
    },
  };
}

function wechatBotFromEnv(): WechatBotConfig {
  const codex = buildCodexConfig();
  return {
    name: 'wechat-default',
    ...(process.env.METABOT_ENGINE ? { engine: process.env.METABOT_ENGINE as EngineName } : {}),
    ...(codex ? { codex } : {}),
    wechat: {
      botToken: process.env.WECHAT_BOT_TOKEN || undefined,
    },
    claude: {
      defaultWorkingDirectory: expandUserPath(required('CLAUDE_DEFAULT_WORKING_DIRECTORY')),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-fable-5',
      apiKey: undefined,
      outputsBaseDir: expandUserPath(
        process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      ),
      downloadsDir: expandUserPath(
        process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
      ),
      backend: process.env.CLAUDE_BACKEND === 'sdk' ? 'sdk' : 'pty',
    },
  };
}

function slackBotFromEnv(): SlackBotConfig {
  const codex = buildCodexConfig();
  return {
    name: 'slack-default',
    ...(process.env.METABOT_ENGINE ? { engine: process.env.METABOT_ENGINE as EngineName } : {}),
    ...(codex ? { codex } : {}),
    slack: {
      botToken: required('SLACK_BOT_TOKEN'),
      signingSecret: required('SLACK_SIGNING_SECRET'),
      ...(process.env.SLACK_BOT_USER_ID ? { botUserId: process.env.SLACK_BOT_USER_ID } : {}),
    },
    ...(process.env.SLACK_GROUP_NO_MENTION === 'true' ? { groupNoMention: true } : {}),
    claude: {
      defaultWorkingDirectory: expandUserPath(required('CLAUDE_DEFAULT_WORKING_DIRECTORY')),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-fable-5',
      apiKey: undefined,
      outputsBaseDir: expandUserPath(
        process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      ),
      downloadsDir: expandUserPath(
        process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
      ),
      backend: process.env.CLAUDE_BACKEND === 'sdk' ? 'sdk' : 'pty',
    },
  };
}

// --- New bots.json format ---

export interface PeerJsonEntry {
  name: string;
  url: string;
  secret?: string;
}

export interface BotsJsonNewFormat {
  feishuBots?: FeishuBotJsonEntry[];
  telegramBots?: TelegramBotJsonEntry[];
  webBots?: WebBotJsonEntry[];
  wechatBots?: WechatBotJsonEntry[];
  slackBots?: SlackBotJsonEntry[];
  peers?: PeerJsonEntry[];
  agentTeams?: AgentTeamConfig[];
}

export function loadAppConfig(): AppConfig {
  const botsConfigPath = process.env.BOTS_CONFIG;

  let feishuBots: BotConfig[] = [];
  let telegramBots: TelegramBotConfig[] = [];
  let webBots: BotConfigBase[] = [];
  let wechatBots: WechatBotConfig[] = [];
  let slackBots: SlackBotConfig[] = [];
  let agentTeams: AgentTeamConfig[] = [];
  let parsedConfig: unknown;

  if (botsConfigPath) {
    const resolved = path.resolve(botsConfigPath);
    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw);
    parsedConfig = parsed;

    if (Array.isArray(parsed)) {
      // Old format: array of feishu bot entries (backward compatible)
      if (parsed.length === 0) {
        throw new Error(`BOTS_CONFIG file must contain a non-empty array or object: ${resolved}`);
      }
      feishuBots = (parsed as FeishuBotJsonEntry[]).map(feishuBotFromJson);
    } else if (parsed && typeof parsed === 'object') {
      // New format: { feishuBots: [...], telegramBots: [...], webBots: [...] }
      const cfg = parsed as BotsJsonNewFormat;
      if (cfg.feishuBots) {
        feishuBots = cfg.feishuBots.map(feishuBotFromJson);
      }
      if (cfg.telegramBots) {
        telegramBots = cfg.telegramBots.map(telegramBotFromJson);
      }
      if (cfg.webBots) {
        webBots = cfg.webBots.map(webBotFromJson);
      }
      if (cfg.wechatBots) {
        wechatBots = cfg.wechatBots.map(wechatBotFromJson);
      }
      if (cfg.slackBots) {
        slackBots = cfg.slackBots.map(slackBotFromJson);
      }
      if (cfg.agentTeams) {
        agentTeams = cfg.agentTeams.map(normalizeAgentTeamConfig);
      }
      if (
        feishuBots.length === 0 &&
        telegramBots.length === 0 &&
        webBots.length === 0 &&
        wechatBots.length === 0 &&
        slackBots.length === 0
      ) {
        throw new Error(`BOTS_CONFIG file must define at least one bot: ${resolved}`);
      }
    } else {
      throw new Error(`BOTS_CONFIG file must contain a JSON array or object: ${resolved}`);
    }
  } else {
    // Single-bot mode from environment variables
    if (process.env.FEISHU_APP_ID) {
      feishuBots = [feishuBotFromEnv()];
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      telegramBots = [telegramBotFromEnv()];
    }
    if (process.env.WECHAT_BOT_TOKEN || process.env.WECHAT_ILINK_ENABLED === 'true') {
      wechatBots = [wechatBotFromEnv()];
    }
    if (process.env.SLACK_BOT_TOKEN) {
      slackBots = [slackBotFromEnv()];
    }
    if (feishuBots.length === 0 && telegramBots.length === 0 && wechatBots.length === 0 && slackBots.length === 0) {
      throw new Error(
        'No bot configured. Set FEISHU_APP_ID/FEISHU_APP_SECRET, TELEGRAM_BOT_TOKEN, WECHAT_ILINK_ENABLED=true, SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET, or use BOTS_CONFIG for multi-bot mode.',
      );
    }
  }

  const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 9100;
  const apiSecret = process.env.API_SECRET || undefined;

  // Expose as METABOT_* env vars so Claude Code skills can read them via shell expansion
  process.env.METABOT_API_PORT = String(apiPort);
  if (apiSecret) {
    process.env.METABOT_API_SECRET = apiSecret;
  }

  // Feishu service app for wiki sync & doc reader (falls back to first Feishu bot)
  let feishuService: AppConfig['feishuService'];
  if (process.env.FEISHU_SERVICE_APP_ID && process.env.FEISHU_SERVICE_APP_SECRET) {
    feishuService = {
      appId: process.env.FEISHU_SERVICE_APP_ID,
      appSecret: process.env.FEISHU_SERVICE_APP_SECRET,
    };
  } else if (feishuBots.length > 0) {
    feishuService = {
      appId: feishuBots[0].feishu.appId,
      appSecret: feishuBots[0].feishu.appSecret,
    };
  }

  // Parse peers from JSON config and/or env vars
  const peers: PeerConfig[] = [];
  if (botsConfigPath && parsedConfig && !Array.isArray(parsedConfig)) {
    const cfg = parsedConfig as BotsJsonNewFormat;
    if (cfg.peers) {
      for (const p of cfg.peers) {
        peers.push({ name: p.name, url: p.url.replace(/\/+$/, ''), secret: p.secret });
      }
    }
  }
  if (process.env.METABOT_PEERS) {
    const urls = process.env.METABOT_PEERS.split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    const secrets = (process.env.METABOT_PEER_SECRETS || '').split(',').map((s) => s.trim());
    const names = (process.env.METABOT_PEER_NAMES || '').split(',').map((s) => s.trim());
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i].replace(/\/+$/, '');
      if (!peers.some((p) => p.url === url)) {
        const autoName = names[i] || url.replace(/^https?:\/\//, '').replace(/[:.]/g, '-');
        peers.push({ name: autoName, url, secret: secrets[i] || undefined });
      }
    }
  }

  return {
    feishuBots,
    telegramBots,
    webBots,
    wechatBots,
    slackBots,
    feishuService,
    log: {
      level: process.env.LOG_LEVEL || 'info',
    },
    api: {
      port: apiPort,
      secret: apiSecret,
    },
    peers,
    agentTeams,
  };
}

function normalizeAgentTeamConfig(team: AgentTeamConfig): AgentTeamConfig {
  return {
    name: team.name,
    ...(team.description ? { description: team.description } : {}),
    ...(team.status === 'active' || team.status === 'stopped' ? { status: team.status } : {}),
    ...(Array.isArray(team.chatIds)
      ? { chatIds: team.chatIds.filter((v): v is string => typeof v === 'string' && !!v.trim()) }
      : {}),
    ...(Array.isArray(team.displayChatIds)
      ? { displayChatIds: team.displayChatIds.filter((v): v is string => typeof v === 'string' && !!v.trim()) }
      : {}),
    ...(Array.isArray(team.agents)
      ? {
          agents: team.agents
            .filter((agent) => agent && typeof agent.name === 'string' && !!agent.name.trim())
            .map((agent) => ({
              name: agent.name.trim(),
              ...(agent.role ? { role: agent.role } : {}),
              ...(agent.engine === 'claude' || agent.engine === 'codex' || agent.engine === 'kimi'
                ? { engine: agent.engine }
                : {}),
              ...(agent.prompt ? { prompt: agent.prompt } : {}),
              ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
              ...(agent.status === 'idle' || agent.status === 'working' || agent.status === 'stopped'
                ? { status: agent.status }
                : {}),
            })),
        }
      : {}),
    ...(Array.isArray(team.tasks)
      ? {
          tasks: team.tasks
            .filter((task) => task && typeof task.subject === 'string' && !!task.subject.trim())
            .map((task) => ({
              ...(typeof task.id === 'number' ? { id: task.id } : {}),
              subject: task.subject.trim(),
              ...(task.description ? { description: task.description } : {}),
              ...(task.owner ? { owner: task.owner } : {}),
              ...(Array.isArray(task.blockedBy)
                ? { blockedBy: task.blockedBy.filter((v): v is number => typeof v === 'number') }
                : {}),
              ...(task.status === 'pending' ||
              task.status === 'in_progress' ||
              task.status === 'completed' ||
              task.status === 'deleted'
                ? { status: task.status }
                : {}),
              ...(task.result ? { result: task.result } : {}),
            })),
        }
      : {}),
  };
}
