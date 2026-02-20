import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface BotConfig {
  name: string;
  feishu: {
    appId: string;
    appSecret: string;
  };
  auth: {
    authorizedUserIds: string[];
    authorizedChatIds: string[];
  };
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

export interface AppConfig {
  bots: BotConfig[];
  log: {
    level: string;
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

interface BotJsonEntry {
  name: string;
  feishuAppId: string;
  feishuAppSecret: string;
  defaultWorkingDirectory: string;
  authorizedUserIds?: string[];
  authorizedChatIds?: string[];
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function botFromJson(entry: BotJsonEntry): BotConfig {
  const defaultTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
  return {
    name: entry.name,
    feishu: {
      appId: entry.feishuAppId,
      appSecret: entry.feishuAppSecret,
    },
    auth: {
      authorizedUserIds: entry.authorizedUserIds || [],
      authorizedChatIds: entry.authorizedChatIds || [],
    },
    claude: {
      defaultWorkingDirectory: entry.defaultWorkingDirectory,
      allowedTools: entry.allowedTools || commaSplit(process.env.CLAUDE_ALLOWED_TOOLS) || defaultTools,
      maxTurns: entry.maxTurns ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined),
      maxBudgetUsd: entry.maxBudgetUsd ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
      model: entry.model || process.env.CLAUDE_MODEL || undefined,
      outputsBaseDir: entry.outputsBaseDir || process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), 'feishu-claudecode-outputs'),
      downloadsDir: entry.downloadsDir || process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), 'feishu-claudecode-downloads'),
    },
  };
}

function botFromEnv(): BotConfig {
  return {
    name: 'default',
    feishu: {
      appId: required('FEISHU_APP_ID'),
      appSecret: required('FEISHU_APP_SECRET'),
    },
    auth: {
      authorizedUserIds: commaSplit(process.env.AUTHORIZED_USER_IDS),
      authorizedChatIds: commaSplit(process.env.AUTHORIZED_CHAT_IDS),
    },
    claude: {
      defaultWorkingDirectory: required('CLAUDE_DEFAULT_WORKING_DIRECTORY'),
      allowedTools: commaSplit(process.env.CLAUDE_ALLOWED_TOOLS) || [
        'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash',
      ],
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || undefined,
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), 'feishu-claudecode-outputs'),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), 'feishu-claudecode-downloads'),
    },
  };
}

export function loadAppConfig(): AppConfig {
  const botsConfigPath = process.env.BOTS_CONFIG;

  let bots: BotConfig[];

  if (botsConfigPath) {
    const resolved = path.resolve(botsConfigPath);
    const raw = fs.readFileSync(resolved, 'utf-8');
    const entries: BotJsonEntry[] = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`BOTS_CONFIG file must contain a non-empty JSON array: ${resolved}`);
    }
    bots = entries.map(botFromJson);
  } else {
    bots = [botFromEnv()];
  }

  return {
    bots,
    log: {
      level: process.env.LOG_LEVEL || 'info',
    },
  };
}

