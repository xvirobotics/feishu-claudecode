import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Agent engine backing a bot. */
export type EngineName = 'claude' | 'kimi' | 'codex';

/** Shared config fields used by MessageBridge and Executors (platform-agnostic). */
export interface BotConfigBase {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  /** Agent engine. Defaults to 'claude' for backward compatibility. */
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
  };
  /** Kimi-specific overrides. Populated only when engine === 'kimi'. Phase 2. */
  kimi?: {
    executable?: string;
    model?: string;
    thinking?: boolean;
    apiKey?: string;
    /** Context window size in tokens (defaults to 262144 — Kimi for Coding default). */
    contextWindow?: number;
  };
  /** Codex-specific overrides. Populated only when engine === 'codex'. */
  codex?: {
    executable?: string;
    model?: string;
    displayModel?: string;
    profile?: string;
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    dangerouslyBypassApprovalsAndSandbox?: boolean;
    /** Context window size in tokens for display only. */
    contextWindow?: number;
    extraArgs?: string[];
    env?: Record<string, string>;
  };
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
  /** Dedicated Feishu service app for wiki sync & doc reader (independent of chat bots). */
  feishuService?: {
    appId: string;
    appSecret: string;
  };
  log: {
    level: string;
  };
  memoryServerUrl: string;
  api: {
    port: number;
    secret?: string;
  };
  memory: {
    enabled: boolean;
    port: number;
    databaseDir: string;
    secret: string;
    adminToken?: string;
    readerToken?: string;
  };
  /** Peer MetaBot instances for cross-instance bot discovery and task delegation. */
  peers: PeerConfig[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function expandUserPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

// --- Feishu JSON entry (used in bots.json) ---

/** Kimi-specific overrides in bots.json. */
export interface KimiJsonConfig {
  executable?: string;
  model?: string;
  thinking?: boolean;
  apiKey?: string;
  /** Context window size in tokens (defaults to 262144 — Kimi for Coding default). */
  contextWindow?: number;
}

/** Codex-specific overrides in bots.json. */
export interface CodexJsonConfig {
  executable?: string;
  model?: string;
  displayModel?: string;
  profile?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Context window size in tokens for display only. */
  contextWindow?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/** Fields shared across all bot JSON entries (engine selection and engine overrides). */
interface EngineJsonFields {
  engine?: EngineName;
  kimi?: KimiJsonConfig;
  codex?: CodexJsonConfig;
}

export interface FeishuBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
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

// --- Shared Claude config builder ---

function buildClaudeConfig(entry: {
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}): BotConfigBase['claude'] {
  return {
    defaultWorkingDirectory: expandUserPath(entry.defaultWorkingDirectory),
    maxTurns: entry.maxTurns ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined),
    maxBudgetUsd: entry.maxBudgetUsd ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    model: entry.model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
    apiKey: entry.apiKey || undefined,
    outputsBaseDir: entry.outputsBaseDir || process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
    downloadsDir: entry.downloadsDir || process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
  };
}

function buildCodexConfig(entry?: CodexJsonConfig): BotConfigBase['codex'] | undefined {
  const cfg: BotConfigBase['codex'] = {
    ...(process.env.CODEX_EXECUTABLE_PATH ? { executable: process.env.CODEX_EXECUTABLE_PATH } : {}),
    ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
    ...(process.env.CODEX_DISPLAY_MODEL ? { displayModel: process.env.CODEX_DISPLAY_MODEL } : {}),
    ...(process.env.CODEX_PROFILE ? { profile: process.env.CODEX_PROFILE } : {}),
    ...(process.env.CODEX_APPROVAL_POLICY ? { approvalPolicy: process.env.CODEX_APPROVAL_POLICY as CodexJsonConfig['approvalPolicy'] } : {}),
    ...(process.env.CODEX_SANDBOX ? { sandbox: process.env.CODEX_SANDBOX as CodexJsonConfig['sandbox'] } : {}),
    ...(process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX === 'true' ? { dangerouslyBypassApprovalsAndSandbox: true } : {}),
    ...(process.env.CODEX_CONTEXT_WINDOW ? { contextWindow: parseInt(process.env.CODEX_CONTEXT_WINDOW, 10) } : {}),
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
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-7',
      apiKey: undefined,
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
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
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-7',
      apiKey: undefined,
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
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
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-7',
      apiKey: undefined,
      outputsBaseDir: expandUserPath(process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`)),
      downloadsDir: expandUserPath(process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`)),
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
  peers?: PeerJsonEntry[];
}

export function loadAppConfig(): AppConfig {
  const botsConfigPath = process.env.BOTS_CONFIG;

  let feishuBots: BotConfig[] = [];
  let telegramBots: TelegramBotConfig[] = [];
  let webBots: BotConfigBase[] = [];
  let wechatBots: WechatBotConfig[] = [];
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
      if (feishuBots.length === 0 && telegramBots.length === 0 && webBots.length === 0 && wechatBots.length === 0) {
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
    if (feishuBots.length === 0 && telegramBots.length === 0 && wechatBots.length === 0) {
      throw new Error('No bot configured. Set FEISHU_APP_ID/FEISHU_APP_SECRET, TELEGRAM_BOT_TOKEN, or WECHAT_ILINK_ENABLED=true, or use BOTS_CONFIG for multi-bot mode.');
    }
  }

  const memoryServerUrl = (process.env.META_MEMORY_URL || process.env.MEMORY_SERVER_URL || 'http://localhost:8100').replace(/\/+$/, '');

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

  const memoryEnabled = process.env.MEMORY_ENABLED !== 'false';
  const memoryPort = process.env.MEMORY_PORT ? parseInt(process.env.MEMORY_PORT, 10) : 8100;
  const memoryDatabaseDir = process.env.MEMORY_DATABASE_DIR || './data';
  const memorySecret = process.env.MEMORY_SECRET || process.env.API_SECRET || '';
  const memoryAdminToken = process.env.MEMORY_ADMIN_TOKEN || undefined;
  const memoryReaderToken = process.env.MEMORY_TOKEN || undefined;

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
    const urls = process.env.METABOT_PEERS.split(',').map((u) => u.trim()).filter(Boolean);
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
    feishuService,
    log: {
      level: process.env.LOG_LEVEL || 'info',
    },
    memoryServerUrl,
    api: {
      port: apiPort,
      secret: apiSecret,
    },
    memory: {
      enabled: memoryEnabled,
      port: memoryPort,
      databaseDir: memoryDatabaseDir,
      secret: memorySecret,
      adminToken: memoryAdminToken,
      readerToken: memoryReaderToken,
    },
    peers,
  };
}
