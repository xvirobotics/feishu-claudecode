import type { SDKMessage } from './executor.js';
import type { CardState, ToolCall, PendingQuestion, SubagentTask } from '../feishu/card-builder.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);

/**
 * Tools that require user interaction in the Agent SDK.
 * These tools cause the SDK stream to pause waiting for a tool_result.
 * The bridge must detect them and respond (either by asking the user
 * or auto-responding) to prevent the stream from hanging.
 */
// ExitPlanMode and EnterPlanMode are handled automatically by the SDK
// in bypassPermissions mode. Do NOT auto-respond to them from the bridge,
// as the SDK already sends a tool_result, causing duplicate tool_result errors.
const AUTO_RESPOND_TOOLS = new Set<string>();

export interface AutoRespondTool {
  toolUseId: string;
  name: string;
}

export interface StreamProcessorConfig {
  model?: string;
  thinking?: string;
  effort?: string;
  startTime?: number;
}

export class StreamProcessor {
  private responseText = '';
  private thinkingText = '';
  /** Text from the just-completed turn, consumed by the bridge after sending */
  private _completedTurnText: string | undefined;
  /** Last turn text emitted, used to deduplicate against SDK result */
  private _lastSentTurnText: string | undefined;
  /** SDK result text, stored separately so it doesn't overwrite responseText */
  private _resultSummary: string | undefined;
  private toolCalls: ToolCall[] = [];
  private toolSummaries: string[] = [];
  private subagentTasks: Map<string, SubagentTask> = new Map();
  private subagentCurrentTools: Map<string, string | null> = new Map();
  private currentToolName: string | null = null;
  private sessionId: string | undefined;
  private costUsd: number | undefined;
  private durationMs: number | undefined;
  private numTurns: number | undefined;
  private _imagePaths: Set<string> = new Set();
  private _pendingQuestions: PendingQuestion[] = [];
  private _autoRespondTools: AutoRespondTool[] = [];
  private _planFilePath: string | null = null;
  private _config: StreamProcessorConfig;
  private _model: string | undefined;
  private _totalTokens: number | undefined;
  private _contextWindow: number | undefined;

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

      case 'user':
        this.processUserMessage(message);
        break;

      case 'result':
        return this.processResultMessage(message);

      case 'stream_event':
        this.processStreamEvent(message);
        break;

      case 'tool_use_summary':
        if (message.summary) {
          this.toolSummaries.push(message.summary);
        }
        break;

      case 'tool_progress':
        // Update elapsed time on running tools
        if (message.tool_name) {
          const tool = this.toolCalls.find(
            (t) => t.name === message.tool_name && t.status === 'running',
          );
          if (tool && message.elapsed_time_seconds) {
            tool.detail = `${tool.detail} (${message.elapsed_time_seconds.toFixed(0)}s)`.trim();
          }
        }
        break;
    }

    // Determine running status
    // Determine running status
    const hasActiveTools = this.toolCalls.some((t) => t.status === 'running');
    const status = this._pendingQuestions.length > 0
      ? 'waiting_for_input'
      : hasActiveTools ? 'running' : this.responseText ? 'running' : 'thinking';

    // Capture and clear completedTurnText so it's only emitted once
    const turnText = this._completedTurnText;
    this._completedTurnText = undefined;

    return {
      status,
      userPrompt: this.userPrompt,
      responseText: this.responseText,
      completedTurnText: turnText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: [...this.toolCalls],
      toolSummaries: this.toolSummaries.length > 0 ? [...this.toolSummaries] : undefined,
      subagentTasks: this.subagentTasks.size > 0 ? [...this.subagentTasks.values()] : undefined,
      startTime: this._config.startTime,
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      pendingQuestion: this._pendingQuestions[0] || undefined,
      model: this._config.model,
      thinking: this._config.thinking,
      effort: this._config.effort,
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      numTurns: this.numTurns,
    };
  }

  private processAssistantMessage(message: SDKMessage): void {
    if (!message.message?.content) return;

    const isSubagent = message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined;

    if (isSubagent) {
      const task = this.getOrCreateSubagentTask(message.parent_tool_use_id!);
      for (const block of message.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          task.thinkingText = block.thinking;
        } else if (block.type === 'tool_use' && block.name) {
          if (!task.toolCalls) task.toolCalls = [];
          this.completeSubagentTool(message.parent_tool_use_id!);
          const detail = formatToolDetail(block.name, block.input);
          const inputStr = formatToolInput(block.name, block.input);
          task.toolCalls.push({ name: block.name, detail, status: 'running', input: inputStr || undefined });
          this.subagentCurrentTools.set(message.parent_tool_use_id!, block.name);
        } else if (block.type === 'tool_result') {
          const output = extractToolOutput(block.content);
          this.completeSubagentTool(message.parent_tool_use_id!, output);
        }
      }
      return;
    }

    for (const block of message.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        this.thinkingText = block.thinking;
      } else if (block.type === 'text' && block.text) {
        // Emit completed turn text for the bridge to send as a separate message.
        // Then reset responseText so the card is clean for the next turn's streaming.
        this._completedTurnText = block.text;
        this._lastSentTurnText = block.text;
        this.responseText = '';
      } else if (block.type === 'tool_use' && block.name) {
        this.addToolCall(block.name, block.input);
        if (block.name === 'AskUserQuestion' && block.id && block.input) {
          this.extractPendingQuestion(block.id, block.input);
        } else if (AUTO_RESPOND_TOOLS.has(block.name) && block.id) {
          this._autoRespondTools.push({ toolUseId: block.id, name: block.name });
        }
      } else if (block.type === 'tool_result') {
        const output = extractToolOutput(block.content);
        this.completeCurrentTool(output);
      }
    }
  }

  private processUserMessage(message: SDKMessage): void {
    if (!message.message?.content) return;

    const isSubagent = message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined;

    for (const block of message.message.content) {
      if (block.type === 'tool_result') {
        const output = extractToolOutput(block.content);
        if (isSubagent) {
          this.completeSubagentTool(message.parent_tool_use_id!, output);
        } else {
          this.completeCurrentTool(output);
        }
      }
    }
  }

  private getOrCreateSubagentTask(taskId: string): SubagentTask {
    let task = this.subagentTasks.get(taskId);
    if (!task) {
      task = { taskId, description: 'Subagent task', status: 'running', toolCalls: [] };
      this.subagentTasks.set(taskId, task);
    }
    return task;
  }

  private completeSubagentTool(taskId: string, output?: string): void {
    const currentName = this.subagentCurrentTools.get(taskId);
    if (!currentName) return;
    const task = this.subagentTasks.get(taskId);
    if (!task?.toolCalls) return;
    const tool = [...task.toolCalls].reverse().find(t => t.name === currentName && t.status === 'running');
    if (tool) {
      tool.status = 'done';
      if (output) tool.output = output;
    }
    this.subagentCurrentTools.set(taskId, null);
  }

  private processStreamEvent(message: SDKMessage): void {
    const event = message.event;
    if (!event) return;

    // Handle subagent stream events
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
      const taskId = message.parent_tool_use_id;
      const task = this.getOrCreateSubagentTask(taskId);
      if (!task.toolCalls) task.toolCalls = [];

      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use' && block.name) {
          this.completeSubagentTool(taskId);
          const detail = formatToolDetail(block.name, undefined);
          task.toolCalls.push({ name: block.name, detail, status: 'running' });
          this.subagentCurrentTools.set(taskId, block.name);
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'thinking_delta' && delta.thinking) {
          task.thinkingText = (task.thinkingText || '') + delta.thinking;
        }
      }
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
      if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.thinkingText += delta.thinking;
      } else if (delta?.type === 'text_delta' && delta.text) {
        this.responseText += delta.text;
      }
    } else if (event.type === 'content_block_stop') {
      // Tool may be complete
      // Actual completion is tracked via assistant messages
    }
  }

  private processSystemMessage(message: SDKMessage): void {
    if (!message.subtype) return;

    switch (message.subtype) {
      case 'task_started':
        if (message.task_id) {
          const existing = this.subagentTasks.get(message.task_id);
          if (existing) {
            // Merge: update description but preserve any tool calls already captured
            existing.description = message.description || message.prompt || existing.description;
          } else {
            this.subagentTasks.set(message.task_id, {
              taskId: message.task_id,
              description: message.description || message.prompt || 'Subagent task',
              status: 'running',
              toolCalls: [],
            });
          }
        }
        break;

      case 'task_progress':
        if (message.task_id) {
          const task = this.subagentTasks.get(message.task_id);
          if (task) {
            if (message.summary) task.summary = message.summary;
            if (message.usage) task.usage = message.usage;
            // last_tool_name is the SDK's way of reporting subagent tool usage
            if (message.last_tool_name) {
              if (!task.toolCalls) task.toolCalls = [];
              const last = task.toolCalls[task.toolCalls.length - 1];
              // Avoid duplicating consecutive identical tool names
              if (!last || last.name !== message.last_tool_name || last.status === 'done') {
                // Mark previous running tool done before adding new one
                if (last && last.status === 'running') last.status = 'done';
                task.toolCalls.push({ name: message.last_tool_name, detail: '', status: 'running' });
              }
            }
          }
        }
        break;

      case 'task_notification':
        if (message.task_id) {
          const task = this.subagentTasks.get(message.task_id);
          if (task) {
            task.status = (message.status as SubagentTask['status']) || 'completed';
            if (message.summary) task.summary = message.summary;
            if (message.usage) task.usage = message.usage;
            if (message.last_tool_name) {
              if (!task.toolCalls) task.toolCalls = [];
              const last = task.toolCalls[task.toolCalls.length - 1];
              if (!last || last.name !== message.last_tool_name) {
                task.toolCalls.push({ name: message.last_tool_name, detail: '', status: 'done' });
              }
            }
            // Mark all running tools as done when task completes
            if (task.toolCalls) {
              for (const t of task.toolCalls) {
                if (t.status === 'running') t.status = 'done';
              }
            }
          }
        }
        break;
    }
  }

  private processResultMessage(message: SDKMessage): CardState {
    this.costUsd = message.total_cost_usd;
    this.durationMs = message.duration_ms;
    if (message.num_turns !== undefined) {
      this.numTurns = message.num_turns;
    }

    // Extract model usage info (per-model breakdown from SDK)
    if (message.modelUsage) {
      const models = Object.keys(message.modelUsage);
      if (models.length > 0) {
        // Primary model is the one with highest cost
        const primaryModel = models.reduce((a, b) =>
          (message.modelUsage![a].costUSD ?? 0) >= (message.modelUsage![b].costUSD ?? 0) ? a : b
        );
        const mu = message.modelUsage[primaryModel];
        this._model = primaryModel;
        this._contextWindow = mu.contextWindow;
        // Use input tokens as current context usage (reflects actual context window occupation)
        let inputTokens = 0;
        for (const m of models) {
          inputTokens += (message.modelUsage![m].inputTokens ?? 0);
        }
        this._totalTokens = inputTokens;
      }
    }

    // Mark all tools as done
    for (const tool of this.toolCalls) {
      tool.status = 'done';
    }

    const resultText = message.result || '';
    const isError = message.subtype !== 'success';
    // SDK sometimes wraps API errors as "success" with the error text as result
    const isApiError = !isError && isApiErrorResult(resultText);

    // Store result separately — only if it differs from the last turn text already sent.
    // SDK result often echoes the last assistant message; skip to avoid duplication.
    this._resultSummary = (resultText && resultText !== this._lastSentTurnText) ? resultText : undefined;

    return {
      status: (isError || isApiError) ? 'error' : 'complete',
      userPrompt: this.userPrompt,
      responseText: '',
      resultSummary: isApiError ? undefined : this._resultSummary,
      thinkingText: this.thinkingText || undefined,
      toolCalls: [...this.toolCalls],
      toolSummaries: this.toolSummaries.length > 0 ? [...this.toolSummaries] : undefined,
      subagentTasks: this.subagentTasks.size > 0 ? [...this.subagentTasks.values()] : undefined,
      startTime: this._config.startTime,
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      errorMessage: isError
        ? (message.errors?.join('; ') || `Ended with: ${message.subtype}`)
        : isApiError ? resultText : undefined,
      model: this._model || this._config.model,
      thinking: this._config.thinking,
      effort: this._config.effort,
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      numTurns: this.numTurns,
      totalTokens: this._totalTokens,
      contextWindow: this._contextWindow,
    };
  }

  private addToolCall(name: string, input: unknown): void {
    // Complete previous tool
    this.completeCurrentTool();

    this.currentToolName = name;
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
        if (output) {
          tool.output = output;
        }
      }
      this.currentToolName = null;
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

    // Queue instead of overwrite — supports multiple AskUserQuestion calls
    this._pendingQuestions.push({ toolUseId, questions: parsed });
  }

  /** Remove the first pending question (after it's been fully answered). */
  clearPendingQuestion(): void {
    this._pendingQuestions.shift();
  }

  /** Peek at the first pending question without removing it. */
  getPendingQuestion(): PendingQuestion | null {
    return this._pendingQuestions[0] ?? null;
  }

  /**
   * Get and clear any tools that need auto-response (e.g. ExitPlanMode).
   * These tools cause the SDK stream to pause; we must push a tool_result
   * to unblock them.
   */
  drainAutoRespondTools(): AutoRespondTool[] {
    if (this._autoRespondTools.length === 0) return [];
    const tools = [...this._autoRespondTools];
    this._autoRespondTools = [];
    return tools;
  }

  /** Return the current card state without processing a new message. */
  getCurrentState(): CardState {
    const hasActiveTools = this.toolCalls.some((t) => t.status === 'running');
    const status = this._pendingQuestions.length > 0
      ? 'waiting_for_input'
      : hasActiveTools ? 'running' : this.responseText ? 'running' : 'thinking';
    return {
      status,
      userPrompt: this.userPrompt,
      responseText: this.responseText,
      thinkingText: this.thinkingText || undefined,
      toolCalls: [...this.toolCalls],
      toolSummaries: this.toolSummaries.length > 0 ? [...this.toolSummaries] : undefined,
      subagentTasks: this.subagentTasks.size > 0 ? [...this.subagentTasks.values()] : undefined,
      startTime: this._config.startTime,
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      pendingQuestion: this._pendingQuestions[0] || undefined,
      model: this._config.model,
      thinking: this._config.thinking,
      effort: this._config.effort,
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      numTurns: this.numTurns,
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

function shortenPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 3) return filePath;
  return '.../' + parts.slice(-2).join('/');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

function formatToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;

  switch (name) {
    case 'Read':
      return inp.file_path ? String(inp.file_path) : '';
    case 'Write':
    case 'Edit':
      return inp.file_path ? String(inp.file_path) : '';
    case 'Bash':
      return inp.command ? String(inp.command) : '';
    case 'Glob':
      return inp.pattern ? String(inp.pattern) : '';
    case 'Grep':
      return inp.pattern ? String(inp.pattern) : '';
    case 'WebSearch':
      return inp.query ? String(inp.query) : '';
    case 'WebFetch':
      return inp.url ? String(inp.url) : '';
    default:
      // For unknown tools, serialize the full input
      try {
        return JSON.stringify(input, null, 2);
      } catch {
        return '';
      }
  }
}

function extractToolOutput(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // content can be an array of content blocks
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/** Detect API error responses that the SDK wraps as successful results */
function isApiErrorResult(text: string): boolean {
  if (!text) return false;
  return /^API Error:\s*\d{3}\s/i.test(text);
}
