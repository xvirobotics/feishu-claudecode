import type { SDKMessage } from './executor.js';
import type { CardState, ToolCall, PendingQuestion, SubagentTask } from '../types.js';
// Re-export types for backwards compatibility with existing imports
export type { CardState, ToolCall, PendingQuestion } from '../types.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);

/**
 * Tools handled by the SDK in bypassPermissions mode.
 * The SDK auto-responds to these; we only detect them for side effects
 * (e.g. sending plan content to the user) — we must NOT call sendAnswer
 * or we'll create duplicate tool_results that cause API 400 errors.
 */
const SDK_HANDLED_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode']);

export interface DetectedTool {
  toolUseId: string;
  name: string;
}

export interface StreamProcessorConfig {
  startTime?: number;
}

export class StreamProcessor {
  private responseText = '';
  private thinkingText = '';
  private toolCalls: ToolCall[] = [];
  private toolSummaries: string[] = [];
  private subagentTasks: Map<string, SubagentTask> = new Map();
  private currentToolName: string | null = null;
  private currentToolInput: unknown = undefined;
  private sessionId: string | undefined;
  private costUsd: number | undefined;
  private durationMs: number | undefined;
  private numTurns: number | undefined;
  private _imagePaths: Set<string> = new Set();
  private _pendingQuestion: PendingQuestion | null = null;
  private _sdkHandledTools: DetectedTool[] = [];
  private _planFilePath: string | null = null;
  private _config: StreamProcessorConfig;

  constructor(
    private userPrompt: string,
    config?: StreamProcessorConfig,
    private workingDirectory?: string,
  ) {
    this._config = config || {};
  }

  processMessage(message: SDKMessage): CardState {
    // Capture session_id from any message
    if (message.session_id) {
      this.sessionId = message.session_id;
    }

    switch (message.type) {
      case 'system':
        this.processSystemMessage(message);
        break;

      case 'assistant':
        this.processAssistantMessage(message);
        break;

      case 'result':
        return this.processResultMessage(message);

      case 'stream_event':
        this.processStreamEvent(message);
        break;

      case 'task_notification':
        this.processSystemMessage(message);
        break;

      case 'tool_use_summary':
        if (message.summary) {
          this.toolSummaries.push(message.summary);
        }
        break;

      case 'tool_progress':
        // Update elapsed time on running tool
        if (message.tool_name && message.elapsed_time_seconds !== undefined) {
          const tool = [...this.toolCalls].reverse().find(
            (t) => t.name === message.tool_name && t.status === 'running',
          );
          if (tool) {
            const elapsed = Math.round(message.elapsed_time_seconds);
            tool.detail = `${formatToolDetail(tool.name, undefined)} (${elapsed}s)`;
          }
        }
        break;
    }

    // Determine running status
    const hasActiveTools = this.toolCalls.some((t) => t.status === 'running');
    const status = this._pendingQuestion
      ? 'waiting_for_input'
      : hasActiveTools ? 'running' : this.responseText ? 'running' : 'thinking';

    return {
      status,
      userPrompt: this.userPrompt,
      responseText: this.responseText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      pendingQuestion: this._pendingQuestion || undefined,
      thinkingText: this.thinkingText || undefined,
      toolSummaries: this.toolSummaries.length > 0 ? [...this.toolSummaries] : undefined,
      subagentTasks: this.subagentTasks.size > 0 ? [...this.subagentTasks.values()] : undefined,
      startTime: this._config.startTime,
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
    };
  }

  private processAssistantMessage(message: SDKMessage): void {
    if (!message.message?.content) return;

    for (const block of message.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        // Capture thinking content from assistant messages
        if (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) {
          this.thinkingText += block.thinking;
        } else {
          // Subagent thinking — attach to matching task
          this.appendSubagentThinking(message.parent_tool_use_id, block.thinking);
        }
      } else if (block.type === 'text' && block.text) {
        // Only accumulate text from top-level assistant messages (not subagent)
        if (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) {
          // Full message text replaces accumulated stream text
          this.responseText = block.text;
        }
      } else if (block.type === 'tool_use' && block.name) {
        if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
          // Subagent tool call — attach to matching task
          this.addSubagentToolCall(message.parent_tool_use_id, block.name, block.input);
        } else {
          this.addToolCall(block.name, block.input);
        }
        // Detect interactive tools at top level
        if (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) {
          if (block.name === 'AskUserQuestion' && block.id && block.input) {
            this.extractPendingQuestion(block.id, block.input);
          } else if (SDK_HANDLED_TOOLS.has(block.name) && block.id) {
            this._sdkHandledTools.push({ toolUseId: block.id, name: block.name });
          }
        }
      } else if (block.type === 'tool_result') {
        const output = extractToolOutput(block.content);
        this.completeCurrentTool(output);
      }
    }
  }

  private processSystemMessage(message: SDKMessage): void {
    // Handle task lifecycle messages (subagent tracking)
    if (message.subtype === 'task_started' && message.task_id) {
      this.subagentTasks.set(message.task_id, {
        taskId: message.task_id,
        description: message.description || '',
        status: 'running',
      });
    } else if (message.subtype === 'task_progress' && message.task_id) {
      const task = this.subagentTasks.get(message.task_id);
      if (task && message.summary) {
        task.summary = message.summary;
      }
    } else if (message.type === 'task_notification' && message.task_id) {
      const task = this.subagentTasks.get(message.task_id);
      if (task) {
        task.status = message.status === 'completed' ? 'completed' : 'failed';
        if (message.summary) task.summary = message.summary;
        if (message.usage) task.usage = message.usage;
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
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.thinkingText += delta.thinking;
      }
    } else if (event.type === 'content_block_stop') {
      // Tool may be complete
      // Actual completion is tracked via assistant messages
    }
  }

  private processResultMessage(message: SDKMessage): CardState {
    this.costUsd = message.total_cost_usd;
    this.durationMs = message.duration_ms;
    this.numTurns = message.num_turns;

    // Mark all tools as done
    for (const tool of this.toolCalls) {
      tool.status = 'done';
    }

    const resultText = message.result || this.responseText;
    const isError = message.subtype !== 'success';
    // SDK sometimes wraps API errors as "success" with the error text as result
    const isApiError = !isError && isApiErrorResult(resultText);

    return {
      status: (isError || isApiError) ? 'error' : 'complete',
      userPrompt: this.userPrompt,
      responseText: isApiError ? '' : resultText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      errorMessage: isError
        ? (message.errors?.join('; ') || `Ended with: ${message.subtype}`)
        : isApiError ? resultText : undefined,
      thinkingText: this.thinkingText || undefined,
      toolSummaries: this.toolSummaries.length > 0 ? [...this.toolSummaries] : undefined,
      subagentTasks: this.subagentTasks.size > 0 ? [...this.subagentTasks.values()] : undefined,
      startTime: this._config.startTime,
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      numTurns: this.numTurns,
    };
  }

  private addToolCall(name: string, input: unknown): void {
    // Complete previous tool
    this.completeCurrentTool();

    this.currentToolName = name;
    this.currentToolInput = input;
    const detail = formatToolDetail(name, input);
    const inputStr = formatToolInput(name, input);
    this.toolCalls.push({ name, detail, status: 'running', input: inputStr || undefined });

    // Track image file paths and plan file paths from Write tool
    if (name === 'Write' && input && typeof input === 'object') {
      const filePath = (input as Record<string, unknown>).file_path as string;
      if (filePath && isImagePath(filePath)) {
        this._imagePaths.add(filePath);
      }
      if (filePath && filePath.includes('.claude/plans/') && filePath.endsWith('.md')) {
        this._planFilePath = filePath;
      }
    }
  }

  private completeCurrentTool(output?: string): void {
    if (this.currentToolName) {
      const tool = this.toolCalls.find(
        (t) => t.name === this.currentToolName && t.status === 'running',
      );
      if (tool) {
        tool.status = 'done';
        if (output) tool.output = output;
      }
      this.currentToolName = null;
      this.currentToolInput = undefined;
    }
  }

  private appendSubagentThinking(parentToolUseId: string, thinking: string): void {
    for (const task of this.subagentTasks.values()) {
      if (task.status === 'running') {
        task.thinkingText = (task.thinkingText || '') + thinking;
        return;
      }
    }
  }

  private addSubagentToolCall(parentToolUseId: string, name: string, input: unknown): void {
    for (const task of this.subagentTasks.values()) {
      if (task.status === 'running') {
        if (!task.toolCalls) task.toolCalls = [];
        const detail = formatToolDetail(name, input);
        task.toolCalls.push({ name, detail, status: 'running' });
        return;
      }
    }
  }

  private extractPendingQuestion(toolUseId: string, input: unknown): void {
    if (!input || typeof input !== 'object') return;
    const inp = input as Record<string, unknown>;
    const questions = inp.questions;
    if (!Array.isArray(questions)) return;

    const parsed = questions.map((q: any) => ({
      question: String(q.question || ''),
      header: String(q.header || ''),
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => ({
            label: String(o.label || ''),
            description: String(o.description || ''),
          }))
        : [],
      multiSelect: Boolean(q.multiSelect),
    }));

    this._pendingQuestion = { toolUseId, questions: parsed };
  }

  clearPendingQuestion(): void {
    this._pendingQuestion = null;
  }

  getPendingQuestion(): PendingQuestion | null {
    return this._pendingQuestion;
  }

  /**
   * Get and clear any SDK-handled tools detected in the stream.
   * These tools are auto-responded to by the SDK in bypassPermissions mode;
   * the bridge should NOT call sendAnswer for them, only perform side effects
   * like sending plan content to the user.
   */
  drainSdkHandledTools(): DetectedTool[] {
    if (this._sdkHandledTools.length === 0) return [];
    const tools = [...this._sdkHandledTools];
    this._sdkHandledTools = [];
    return tools;
  }

  /** Return the current card state without processing a new message. */
  getCurrentState(): CardState {
    const hasActiveTools = this.toolCalls.some((t) => t.status === 'running');
    const status = this._pendingQuestion
      ? 'waiting_for_input'
      : hasActiveTools ? 'running' : this.responseText ? 'running' : 'thinking';
    return {
      status,
      userPrompt: this.userPrompt,
      responseText: this.responseText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      pendingQuestion: this._pendingQuestion || undefined,
      thinkingText: this.thinkingText || undefined,
      toolSummaries: this.toolSummaries.length > 0 ? [...this.toolSummaries] : undefined,
      subagentTasks: this.subagentTasks.size > 0 ? [...this.subagentTasks.values()] : undefined,
      startTime: this._config.startTime,
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
    };
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getImagePaths(): string[] {
    return [...this._imagePaths];
  }

  getPlanFilePath(): string | null {
    return this._planFilePath;
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
    case 'AskUserQuestion': {
      const qs = inp.questions;
      if (Array.isArray(qs) && qs.length > 0) {
        const first = qs[0] as Record<string, unknown>;
        return first.question ? truncate(String(first.question), 50) : '';
      }
      return '';
    }
    default:
      return '';
  }
}

/** Extract key fields from tool input for display */
function formatToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['file_path', 'command', 'pattern', 'query', 'url', 'prompt', 'description']) {
    if (inp[key] && typeof inp[key] === 'string') {
      parts.push(`${key}: ${truncate(inp[key] as string, 200)}`);
    }
  }
  return parts.join('\n');
}

/** Extract tool output from various content formats */
function extractToolOutput(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return truncate(content, 500);
  if (Array.isArray(content)) {
    const texts = content
      .filter((c: any) => c.type === 'text' && c.text)
      .map((c: any) => c.text);
    return truncate(texts.join('\n'), 500);
  }
  try {
    return truncate(JSON.stringify(content), 500);
  } catch {
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

/** Detect API error responses that the SDK wraps as successful results */
function isApiErrorResult(text: string): boolean {
  if (!text) return false;
  return /^API Error:\s*\d{3}\s/i.test(text);
}
