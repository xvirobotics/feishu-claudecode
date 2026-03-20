// Shared types used across IM platforms (Feishu, Telegram, etc.)

export type CardStatus = 'thinking' | 'running' | 'complete' | 'error' | 'waiting_for_input';

export interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'done';
  input?: string;
  output?: string;
}

export interface PendingQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface SubagentTask {
  taskId: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  summary?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  thinkingText?: string;
  toolCalls?: ToolCall[];
}

export interface CardState {
  status: CardStatus;
  userPrompt: string;
  responseText: string;
  thinkingText?: string;
  toolCalls: ToolCall[];
  toolSummaries?: string[];
  subagentTasks?: SubagentTask[];
  startTime?: number;
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  retryInfo?: string;
  pendingQuestion?: PendingQuestion;
  model?: string;
  thinking?: string;
  effort?: string;
  sessionId?: string;
  workingDirectory?: string;
  numTurns?: number;
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
  text: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
}
