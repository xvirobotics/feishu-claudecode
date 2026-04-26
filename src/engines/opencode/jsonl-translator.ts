import type { SDKMessage } from '../claude/executor.js';

export interface OpenCodeJsonEvent {
  type: string;
  sessionID?: string;
  timestamp?: number;
  messageID?: string;
  part?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
    messageID?: string;
    sessionID?: string;
  };
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  cost?: number;
  error?: string;
  message?: string;
}

export interface OpenCodeTranslatorState {
  sessionId?: string;
  lastAgentText: string;
  startTime: number;
  model?: string;
}

export function createOpenCodeTranslatorState(options: { model?: string } = {}): OpenCodeTranslatorState {
  return { lastAgentText: '', startTime: Date.now(), model: options.model };
}

export function translateOpenCodeJsonEvent(
  event: OpenCodeJsonEvent,
  state: OpenCodeTranslatorState,
): SDKMessage[] {
  switch (event.type) {
    case 'step_start':
      return [];

    case 'text': {
      const text = event.part?.text ?? '';
      state.lastAgentText += text;
      return [{
        type: 'assistant',
        session_id: state.sessionId,
        message: { content: [{ type: 'text', text }] },
      }];
    }

    case 'step_finish': {
      const resultText = state.lastAgentText;
      state.lastAgentText = '';
      return [{
        type: 'result',
        subtype: 'success',
        session_id: state.sessionId,
        duration_ms: Date.now() - state.startTime,
        result: resultText,
        is_error: false,
        errors: undefined,
        modelUsage: state.model ? {
          [state.model]: {
            inputTokens: event.tokens?.input ?? 0,
            outputTokens: event.tokens?.output ?? 0,
            contextWindow: 128000,
            costUSD: event.cost ?? 0,
          },
        } : undefined,
      }];
    }

    case 'error':
    case 'result': {
      if (event.sessionID) state.sessionId = event.sessionID;
      const isError = event.type === 'error';
      return [{
        type: 'result',
        subtype: isError ? 'error_during_execution' : 'success',
        session_id: state.sessionId,
        duration_ms: Date.now() - state.startTime,
        result: event.error ?? event.message ?? state.lastAgentText,
        is_error: isError,
        errors: isError ? [event.error ?? event.message ?? 'Unknown error'] : undefined,
      }];
    }

    default:
      return [];
  }
}
