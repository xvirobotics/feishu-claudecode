import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Shared config fields used by MessageBridge and ClaudeExecutor (platform-agnostic). */
export interface BotConfigBase {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  claude: {
    defaultWorkingDirectory: string;
    maxTurns: number | undefined;
    maxBudgetUsd: number | undefined;
    model: string | undefined;
    outputsBaseDir: string;
    downloadsDir: string;
  };
}

/** Feishu bot config (extends base with Feishu credentials). */
export interface BotConfig extends BotConfigBase {
  feishu: {
    appId: string;
    appSecret: string;
  };
}

/** Telegram bot config (extends base with Telegram credentials). */
export interface TelegramBotConfig extends BotConfigBase {
  telegram: {
    botToken: string;
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
  /** Twilio phone call integration (Jarvis-style hands-free voice). */
  twilio?: {
    accountSid: string;
    authToken: string;
    phoneNumber: string;
    defaultBotName: string;
    callbackNumber?: string;
    /** Base URL for Twilio webhooks (must be publicly accessible). */
    baseUrl: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// --- Feishu JSON entry (used in bots.json) ---

export interface FeishuBotJsonEntry {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  feishuAppId: string;
  feishuAppSecret: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function feishuBotFromJson(entry: FeishuBotJsonEntry): BotConfig {
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    feishu: {
      appId: entry.feishuAppId,
      appSecret: entry.feishuAppSecret,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Telegram JSON entry (used in bots.json) ---

export interface TelegramBotJsonEntry {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  telegramBotToken: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function telegramBotFromJson(entry: TelegramBotJsonEntry): TelegramBotConfig {
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    telegram: {
      botToken: entry.telegramBotToken,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Web bot JSON entry (used in bots.json — no IM credentials needed) ---

export interface WebBotJsonEntry {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

export function webBotFromJson(entry: WebBotJsonEntry): BotConfigBase {
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    claude: buildClaudeConfig(entry),
  };
}

// --- Shared Claude config builder ---

function buildClaudeConfig(entry: {
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}): BotConfigBase['claude'] {
  return {
    defaultWorkingDirectory: entry.defaultWorkingDirectory,
    maxTurns: entry.maxTurns ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined),
    maxBudgetUsd: entry.maxBudgetUsd ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    model: entry.model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
    outputsBaseDir: entry.outputsBaseDir || process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
    downloadsDir: entry.downloadsDir || process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), 'metabot-downloads'),
  };
}

// --- Single-bot env var mode ---

function feishuBotFromEnv(): BotConfig {
  return {
    name: 'default',
    feishu: {
      appId: required('FEISHU_APP_ID'),
      appSecret: required('FEISHU_APP_SECRET'),
    },
    claude: {
      defaultWorkingDirectory: required('CLAUDE_DEFAULT_WORKING_DIRECTORY'),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), 'metabot-downloads'),
    },
  };
}

function telegramBotFromEnv(): TelegramBotConfig {
  return {
    name: 'telegram-default',
    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
    },
    claude: {
      defaultWorkingDirectory: required('CLAUDE_DEFAULT_WORKING_DIRECTORY'),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), 'metabot-downloads'),
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
  peers?: PeerJsonEntry[];
}

export function loadAppConfig(): AppConfig {
  const botsConfigPath = process.env.BOTS_CONFIG;

  let feishuBots: BotConfig[] = [];
  let telegramBots: TelegramBotConfig[] = [];
  let webBots: BotConfigBase[] = [];
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
      if (feishuBots.length === 0 && telegramBots.length === 0 && webBots.length === 0) {
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
    if (feishuBots.length === 0 && telegramBots.length === 0) {
      throw new Error('No bot configured. Set FEISHU_APP_ID/FEISHU_APP_SECRET or TELEGRAM_BOT_TOKEN, or use BOTS_CONFIG for multi-bot mode.');
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

  // Parse Twilio config
  let twilio: AppConfig['twilio'];
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    twilio = {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
      defaultBotName: process.env.TWILIO_DEFAULT_BOT || 'default',
      callbackNumber: process.env.TWILIO_CALLBACK_NUMBER || undefined,
      baseUrl: (process.env.TWILIO_BASE_URL || `http://localhost:${apiPort}`).replace(/\/+$/, ''),
    };
  }

  return {
    feishuBots,
    telegramBots,
    webBots,
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
    twilio,
  };
}
