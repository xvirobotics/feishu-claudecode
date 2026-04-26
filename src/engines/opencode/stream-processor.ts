import type { SDKMessage } from '../claude/executor.js';
import type { CardState } from '../../types.js';

export class OpenCodeStreamProcessor {
  private responseText = '';
  private toolCalls: { toolUseId: string; name: string; input: string }[] = [];
  private currentToolName: string | null = null;
  private currentToolInput = '';
  private sessionId: string | undefined;
  private costUsd: number | undefined;
  private durationMs: number | undefined;
  private errorMessage: string | undefined;
  private _model: string | undefined;
  private _imagePaths: Set<string> = new Set();
  private _status: 'thinking' | 'running' | 'complete' | 'error' = 'thinking';
  private _userPrompt: string;

  constructor(userPrompt: string) {
    this._userPrompt = userPrompt;
  }

  processMessage(message: SDKMessage): CardState | undefined {
    if (message.session_id) this.sessionId = message.session_id;

    switch (message.type) {
      case 'assistant': {
        this._status = 'running';
        if (message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              this.responseText += block.text ?? '';
            }
            if (block.type === 'tool_use') {
              this.currentToolName = block.name ?? 'unknown';
              this.currentToolInput = JSON.stringify(block.input ?? {});
            }
            if (block.type === 'content_block_end' && this.currentToolName) {
              this.toolCalls.push({
                toolUseId: `oc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                name: this.currentToolName,
                input: this.currentToolInput,
              });
              this.currentToolName = null;
              this.currentToolInput = '';
            }
          }
        }
        return undefined;
      }

      case 'result': {
        this._status = message.is_error ? 'error' : 'complete';
        if (message.duration_ms) this.durationMs = message.duration_ms;
        if (message.modelUsage) {
          const firstModel = Object.values(message.modelUsage)[0] as { costUSD?: number };
          this.costUsd = firstModel?.costUSD;
        }
        if (message.is_error && message.errors?.length) {
          this.errorMessage = message.errors[0];
        }
        if (message.result && !this.responseText) {
          this.responseText = message.result;
        }
        return this.buildCardState();
      }

      default:
        return undefined;
    }
  }

  extractImagePaths(): string[] {
    return Array.from(this._imagePaths);
  }

  private buildCardState(): CardState {
    return {
      status: this._status,
      userPrompt: this._userPrompt,
      responseText: this.responseText,
      toolCalls: this.toolCalls,
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      errorMessage: this.errorMessage,
      model: this._model,
    };
  }
}
