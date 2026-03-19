// Shared types used across IM platforms (Feishu, Telegram, etc.)

export type CardStatus = 'thinking' | 'running' | 'complete' | 'error' | 'waiting_for_input';

export interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'done';
  input?: string;
  output?: string;
}

export interface SubagentTask {
  taskId: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  toolCalls?: ToolCall[];
  thinkingText?: string;
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

export interface CardState {
  status: CardStatus;
  userPrompt: string;
  responseText: string;
  toolCalls: ToolCall[];
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  pendingQuestion?: PendingQuestion;
  thinkingText?: string;
  toolSummaries?: string[];
  subagentTasks?: SubagentTask[];
  startTime?: number;
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
