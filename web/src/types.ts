/* ============================================================
   MetaBot Web — Type Definitions
   ============================================================ */

export type CardStatus =
  | 'thinking'
  | 'running'
  | 'complete'
  | 'error'
  | 'waiting_for_input';

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
    options: Array<{
      label: string;
      description: string;
    }>;
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
}

export interface BotInfo {
  name: string;
  description?: string;
  platform: string;
  workingDirectory: string;
}

export interface FileAttachment {
  name: string;
  type: string;   // MIME type
  size: number;
  url: string;     // /api/files/chatId/filename — for browser preview
  path: string;    // server absolute path — for Claude to read
}

export interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  state?: CardState;
  timestamp: number;
  attachments?: FileAttachment[];
  /** In group chats, which bot sent this message. */
  botName?: string;
}

export interface ChatSession {
  id: string;
  botName: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** If set, this session is a group chat. */
  groupId?: string;
}

/* --- Group types --- */

export interface ChatGroup {
  id: string;
  name: string;
  members: string[];
  createdAt: number;
}

/* --- Memory types --- */

export interface MemoryFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface MemoryDocument {
  id: string;
  title: string;
  path: string;
  content?: string;
  snippet?: string;
  tags: string[];
  created_by?: string;
  updated_at: string;
}

/* --- WebSocket messages --- */

export type WSIncomingMessage =
  | { type: 'connected'; bots: BotInfo[] }
  | { type: 'bots_updated'; bots: BotInfo[] }
  | { type: 'state'; chatId: string; messageId: string; state: CardState; botName?: string }
  | { type: 'complete'; chatId: string; messageId: string; state: CardState; botName?: string }
  | { type: 'error'; chatId: string; messageId: string; error: string }
  | { type: 'notice'; text?: string; chatId?: string; title?: string; content?: string }
  | { type: 'file'; chatId: string; url: string; name: string; mimeType: string; size?: number }
  | { type: 'group_created'; group: ChatGroup }
  | { type: 'group_deleted'; groupId: string }
  | { type: 'groups_list'; groups: ChatGroup[] }
  | { type: 'pong' };

export type WSOutgoingMessage =
  | { type: 'chat'; botName: string; chatId: string; text: string; messageId: string }
  | { type: 'group_chat'; groupId: string; chatId: string; text: string; messageId: string }
  | { type: 'stop'; chatId: string }
  | { type: 'answer'; chatId: string; toolUseId: string; answer: string }
  | { type: 'create_group'; name: string; members: string[] }
  | { type: 'delete_group'; groupId: string }
  | { type: 'list_groups' }
  | { type: 'ping' };

export type ActiveView = 'chat' | 'memory' | 'voice' | 'settings';
export type Theme = 'dark' | 'light';
