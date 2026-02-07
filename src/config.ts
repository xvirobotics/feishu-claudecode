import 'dotenv/config';

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
  };
  auth: {
    authorizedUserIds: string[];
    authorizedChatIds: string[];
  };
  claude: {
    defaultWorkingDirectory: string | undefined;
    allowedTools: string[];
    maxTurns: number;
    maxBudgetUsd: number;
    model: string | undefined;
  };
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

export function loadConfig(): Config {
  return {
    feishu: {
      appId: required('FEISHU_APP_ID'),
      appSecret: required('FEISHU_APP_SECRET'),
    },
    auth: {
      authorizedUserIds: commaSplit(process.env.AUTHORIZED_USER_IDS),
      authorizedChatIds: commaSplit(process.env.AUTHORIZED_CHAT_IDS),
    },
    claude: {
      defaultWorkingDirectory: process.env.CLAUDE_DEFAULT_WORKING_DIRECTORY || undefined,
      allowedTools: commaSplit(process.env.CLAUDE_ALLOWED_TOOLS) || [
        'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash',
      ],
      maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || '50', 10),
      maxBudgetUsd: parseFloat(process.env.CLAUDE_MAX_BUDGET_USD || '1.0'),
      model: process.env.CLAUDE_MODEL || undefined,
    },
    log: {
      level: process.env.LOG_LEVEL || 'info',
    },
  };
}
