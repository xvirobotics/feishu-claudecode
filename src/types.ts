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

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface BackgroundEvent {
  taskId: string;
  description: string;
  status: BackgroundTaskStatus;
  /** Latest stdout event line from the task, if any. */
  lastEvent?: string;
}

/**
 * Snapshot of an Agent Teams session, derived from Claude Code's
 * TaskCreated / TaskCompleted / TeammateIdle hooks. Rendered in the
 * Feishu card and Web UI as a "team panel" so the user can see
 * teammates and the shared task list at a glance.
 */
export interface TeamMember {
  name: string;
  status: 'working' | 'idle';
  /** Most recent task subject this teammate touched (best-effort). */
  lastSubject?: string;
}

export interface TeamTask {
  taskId: string;
  subject: string;
  status: 'in_progress' | 'completed';
  teammate?: string;
}

export interface TeamState {
  /** Team name as reported by the SDK hooks (first non-empty wins). */
  name?: string;
  teammates: TeamMember[];
  tasks: TeamTask[];
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
  /** Primary model used (e.g. "claude-opus-4-7") */
  model?: string;
  /** Total input+output tokens consumed */
  totalTokens?: number;
  /** Context window size of the primary model */
  contextWindow?: number;
  /** Cumulative session cost (USD), accumulated across queries until /reset */
  sessionCostUsd?: number;
  /** Background tasks (e.g. Monitor) the agent has spawned during this turn. */
  backgroundEvents?: BackgroundEvent[];
  /** Active /goal condition for this session, if any. Mirrored locally so the card can show "🎯 Goal" badge across turns. */
  goalCondition?: string;
  /** Snapshot of the active Agent Team (teammates + tasks), if any. */
  teamState?: TeamState;
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
