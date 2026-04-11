// Shared types used across IM platforms (Feishu, Telegram, etc.)

export type CardStatus = 'thinking' | 'running' | 'complete' | 'error' | 'waiting_for_input';

export interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'done';
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
  /** Primary model used (e.g. "claude-opus-4-6") */
  model?: string;
  /** Total input+output tokens consumed */
  totalTokens?: number;
  /** Context window size of the primary model */
  contextWindow?: number;
  /** Cumulative session cost (USD), accumulated across queries until /reset */
  sessionCostUsd?: number;
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
  /** Additional media from batched messages (smart debounce). */
  extraMedia?: Array<{
    messageId: string;
    imageKey?: string;
    fileKey?: string;
    fileName?: string;
  }>;
}
