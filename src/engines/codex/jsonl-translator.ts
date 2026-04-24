import type { SDKMessage } from '../claude/executor.js';

export interface CodexTranslatorState {
  sessionId?: string;
  lastAgentText: string;
  startTime: number;
  model?: string;
  contextWindow?: number;
}

export interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

export type CodexItem =
  | { id: string; type: 'agent_message'; text?: string }
  | {
      id: string;
      type: 'command_execution';
      command?: string;
      aggregated_output?: string;
      exit_code?: number | null;
      status?: string;
    }
  | { id: string; type: string; [key: string]: unknown };

export function createCodexTranslatorState(options: {
  model?: string;
  contextWindow?: number;
} = {}): CodexTranslatorState {
  return {
    lastAgentText: '',
    startTime: Date.now(),
    model: options.model,
    contextWindow: options.contextWindow,
  };
}

export function translateCodexJsonEvent(
  event: CodexJsonEvent,
  state: CodexTranslatorState,
): SDKMessage[] {
  switch (event.type) {
    case 'thread.started':
      if (!event.thread_id) return [];
      state.sessionId = event.thread_id;
      return [{ type: 'system', subtype: 'init', session_id: event.thread_id }];

    case 'item.started':
      if (!event.item) return [];
      return translateStartedItem(event.item, state);

    case 'item.completed':
      if (!event.item) return [];
      return translateCompletedItem(event.item, state);

    case 'turn.completed':
      return [buildResultMessage(event.usage, state, false)];

    case 'turn.failed':
      return [buildResultMessage(undefined, state, true, event.error?.message)];

    case 'error':
      return event.message
        ? [{ type: 'task_notification', session_id: state.sessionId, result: event.message }]
        : [];

    default:
      return [];
  }
}

function translateStartedItem(item: CodexItem, state: CodexTranslatorState): SDKMessage[] {
  if (item.type !== 'command_execution') return [];
  return [{
    type: 'assistant',
    session_id: state.sessionId,
    message: {
      content: [{
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: typeof item.command === 'string' ? item.command : '' },
      }],
    },
  }];
}

function translateCompletedItem(item: CodexItem, state: CodexTranslatorState): SDKMessage[] {
  if (item.type === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : '';
    state.lastAgentText = text;
    return [{
      type: 'assistant',
      session_id: state.sessionId,
      message: { content: [{ type: 'text', text }] },
    }];
  }

  if (item.type === 'command_execution') {
    return [{
      type: 'user',
      session_id: state.sessionId,
      message: {
        content: [{
          type: 'tool_result',
          id: item.id,
          text: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
        }],
      },
    }];
  }

  return [];
}

function buildResultMessage(
  usage: CodexUsage | undefined,
  state: CodexTranslatorState,
  isError: boolean,
  errorMessage?: string,
): SDKMessage {
  const modelUsage = state.model
    ? {
        [state.model]: {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          contextWindow: state.contextWindow ?? 0,
          costUSD: 0,
        },
      }
    : undefined;

  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    session_id: state.sessionId,
    duration_ms: Date.now() - state.startTime,
    result: state.lastAgentText,
    is_error: isError,
    errors: isError ? [errorMessage || 'Codex execution failed'] : undefined,
    modelUsage,
  };
}
