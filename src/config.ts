import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Shared config fields used by MessageBridge and ClaudeExecutor (platform-agnostic). */
export interface BotConfigBase {
  name: string;
  claude: {
    defaultWorkingDirectory: string;
    allowedTools: string[];
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

export interface AppConfig {
  feishuBots: BotConfig[];
  telegramBots: TelegramBotConfig[];
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
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function commaSplit(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// --- Feishu JSON entry (used in bots.json) ---

export interface FeishuBotJsonEntry {
  name: string;
  feishuAppId: string;
  feishuAppSecret: string;
  defaultWorkingDirectory: string;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function feishuBotFromJson(entry: FeishuBotJsonEntry): BotConfig {
  return {
    name: entry.name,
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
  telegramBotToken: string;
  defaultWorkingDirectory: string;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function telegramBotFromJson(entry: TelegramBotJsonEntry): TelegramBotConfig {
  return {
    name: entry.name,
    telegram: {
      botToken: entry.telegramBotToken,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Shared Claude config builder ---

function buildClaudeConfig(entry: {
  defaultWorkingDirectory: string;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}): BotConfigBase['claude'] {
  const defaultTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
  return {
    defaultWorkingDirectory: entry.defaultWorkingDirectory,
    allowedTools: entry.allowedTools || commaSplit(process.env.CLAUDE_ALLOWED_TOOLS) || defaultTools,
    maxTurns: entry.maxTurns ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined),
    maxBudgetUsd: entry.maxBudgetUsd ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    model: entry.model || process.env.CLAUDE_MODEL || 'claude-opus-4-6',
    outputsBaseDir: entry.outputsBaseDir || process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), 'metabot-outputs'),
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
      allowedTools: commaSplit(process.env.CLAUDE_ALLOWED_TOOLS) || [
        'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash',
      ],
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), 'metabot-outputs'),
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
      allowedTools: commaSplit(process.env.CLAUDE_ALLOWED_TOOLS) || [
        'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash',
      ],
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), 'metabot-outputs'),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), 'metabot-downloads'),
    },
  };
}

// --- New bots.json format ---

export interface BotsJsonNewFormat {
  feishuBots?: FeishuBotJsonEntry[];
  telegramBots?: TelegramBotJsonEntry[];
}

export function loadAppConfig(): AppConfig {
  const botsConfigPath = process.env.BOTS_CONFIG;

  let feishuBots: BotConfig[] = [];
  let telegramBots: TelegramBotConfig[] = [];

  if (botsConfigPath) {
    const resolved = path.resolve(botsConfigPath);
    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      // Old format: array of feishu bot entries (backward compatible)
      if (parsed.length === 0) {
        throw new Error(`BOTS_CONFIG file must contain a non-empty array or object: ${resolved}`);
      }
      feishuBots = (parsed as FeishuBotJsonEntry[]).map(feishuBotFromJson);
    } else if (parsed && typeof parsed === 'object') {
      // New format: { feishuBots: [...], telegramBots: [...] }
      const cfg = parsed as BotsJsonNewFormat;
      if (cfg.feishuBots) {
        feishuBots = cfg.feishuBots.map(feishuBotFromJson);
      }
      if (cfg.telegramBots) {
        telegramBots = cfg.telegramBots.map(telegramBotFromJson);
      }
      if (feishuBots.length === 0 && telegramBots.length === 0) {
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

  const memoryServerUrl = (process.env.MEMORY_SERVER_URL || 'http://localhost:8100').replace(/\/+$/, '');

  const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 9100;
  const apiSecret = process.env.API_SECRET || undefined;

  // Expose as METABOT_* env vars so Claude Code skills can read them via shell expansion
  process.env.METABOT_API_PORT = String(apiPort);
  if (apiSecret) {
    process.env.METABOT_API_SECRET = apiSecret;
  }

  const memoryEnabled = process.env.MEMORY_ENABLED !== 'false';
  const memoryPort = process.env.MEMORY_PORT ? parseInt(process.env.MEMORY_PORT, 10) : 8100;
  const memoryDatabaseDir = process.env.MEMORY_DATABASE_DIR || './data';
  const memorySecret = process.env.MEMORY_SECRET || process.env.API_SECRET || '';
  const memoryAdminToken = process.env.MEMORY_ADMIN_TOKEN || undefined;
  const memoryReaderToken = process.env.MEMORY_TOKEN || undefined;

  return {
    feishuBots,
    telegramBots,
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
  };
}
