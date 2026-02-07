import type { SDKMessage } from './executor.js';
import type { CardState, ToolCall } from '../feishu/card-builder.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);

export class StreamProcessor {
  private responseText = '';
  private toolCalls: ToolCall[] = [];
  private currentToolName: string | null = null;
  private sessionId: string | undefined;
  private costUsd: number | undefined;
  private durationMs: number | undefined;
  private _imagePaths: Set<string> = new Set();

  constructor(private userPrompt: string) {}

  processMessage(message: SDKMessage): CardState {
    // Capture session_id from any message
    if (message.session_id && !this.sessionId) {
      this.sessionId = message.session_id;
    }

    switch (message.type) {
      case 'system':
        // Init message, session captured above
        break;

      case 'assistant':
        this.processAssistantMessage(message);
        break;

      case 'result':
        return this.processResultMessage(message);

      case 'stream_event':
        this.processStreamEvent(message);
        break;
    }

    // Determine running status
    const hasActiveTools = this.toolCalls.some((t) => t.status === 'running');
    const status = hasActiveTools ? 'running' : this.responseText ? 'running' : 'thinking';

    return {
      status,
      userPrompt: this.userPrompt,
      responseText: this.responseText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
    };
  }

  private processAssistantMessage(message: SDKMessage): void {
    if (!message.message?.content) return;

    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) {
        // Only accumulate text from top-level assistant messages (not subagent)
        if (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) {
          // Full message text replaces accumulated stream text
          this.responseText = block.text;
        }
      } else if (block.type === 'tool_use' && block.name) {
        this.addToolCall(block.name, block.input);
      } else if (block.type === 'tool_result') {
        this.completeCurrentTool();
      }
    }
  }

  private processStreamEvent(message: SDKMessage): void {
    const event = message.event;
    if (!event) return;

    // Only process top-level stream events
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
      return;
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use' && block.name) {
        this.addToolCall(block.name, undefined);
      }
      if (block?.type === 'text') {
        // Reset for new text block
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        this.responseText += delta.text;
      }
    } else if (event.type === 'content_block_stop') {
      // Tool may be complete
      // Actual completion is tracked via assistant messages
    }
  }

  private processResultMessage(message: SDKMessage): CardState {
    this.costUsd = message.total_cost_usd;
    this.durationMs = message.duration_ms;

    // Mark all tools as done
    for (const tool of this.toolCalls) {
      tool.status = 'done';
    }

    const isError = message.subtype !== 'success';

    return {
      status: isError ? 'error' : 'complete',
      userPrompt: this.userPrompt,
      responseText: message.result || this.responseText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      errorMessage: isError
        ? (message.errors?.join('; ') || `Ended with: ${message.subtype}`)
        : undefined,
    };
  }

  private addToolCall(name: string, input: unknown): void {
    // Complete previous tool
    this.completeCurrentTool();

    this.currentToolName = name;
    const detail = formatToolDetail(name, input);
    this.toolCalls.push({ name, detail, status: 'running' });

    // Track image file paths from Write tool
    if (name === 'Write' && input && typeof input === 'object') {
      const filePath = (input as Record<string, unknown>).file_path as string;
      if (filePath && isImagePath(filePath)) {
        this._imagePaths.add(filePath);
      }
    }
  }

  private completeCurrentTool(): void {
    if (this.currentToolName) {
      const tool = this.toolCalls.find(
        (t) => t.name === this.currentToolName && t.status === 'running',
      );
      if (tool) {
        tool.status = 'done';
      }
      this.currentToolName = null;
    }
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getImagePaths(): string[] {
    return [...this._imagePaths];
  }
}

function isImagePath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** Scan text for absolute image file paths */
export function extractImagePaths(text: string): string[] {
  const pathRegex = /\/[\w./_-]+\.(?:png|jpe?g|gif|webp|bmp|svg|tiff)/gi;
  const matches = text.match(pathRegex) || [];
  return [...new Set(matches)];
}

function formatToolDetail(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const inp = input as Record<string, unknown>;

  switch (name) {
    case 'Read':
      return inp.file_path ? `\`${shortenPath(inp.file_path as string)}\`` : '';
    case 'Write':
      return inp.file_path ? `\`${shortenPath(inp.file_path as string)}\`` : '';
    case 'Edit':
      return inp.file_path ? `\`${shortenPath(inp.file_path as string)}\`` : '';
    case 'Bash':
      return inp.command ? `\`${truncate(inp.command as string, 60)}\`` : '';
    case 'Glob':
      return inp.pattern ? `\`${inp.pattern}\`` : '';
    case 'Grep':
      return inp.pattern ? `\`${inp.pattern}\`` : '';
    case 'WebSearch':
      return inp.query ? `"${truncate(inp.query as string, 50)}"` : '';
    case 'WebFetch':
      return inp.url ? `\`${truncate(inp.url as string, 60)}\`` : '';
    case 'Task':
      return inp.description ? `${inp.description}` : '';
    default:
      return '';
  }
}

function shortenPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 3) return filePath;
  return '.../' + parts.slice(-2).join('/');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}
