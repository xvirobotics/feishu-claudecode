import { createSession, isLoggedIn } from '@moonshot-ai/kimi-agent-sdk';
import type { Session, Turn, StreamEvent, RunResult } from '@moonshot-ai/kimi-agent-sdk';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type {
  ApiContext,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
} from '../claude/executor.js';

/**
 * Executor that drives `@moonshot-ai/kimi-agent-sdk` and translates its
 * event stream into Claude-shaped `SDKMessage` objects, so that the existing
 * `StreamProcessor` (which understands Claude's event shape) can render
 * Kimi sessions as Feishu cards without further changes.
 *
 * Mapping (Kimi event → emitted SDKMessage):
 *   TurnBegin                      → system/init (carries session_id)
 *   ContentPart{type:'text'}       → stream_event(content_block_delta text_delta)
 *                                   + final assistant/text block when turn ends
 *   ContentPart{type:'think'}      → skipped (no equivalent card rendering yet)
 *   ToolCall                       → assistant/tool_use block
 *   ToolResult                     → user/tool_result block
 *   StatusUpdate                   → tracked locally for token usage
 *   TurnEnd + awaited RunResult    → result/success (or error for cancelled)
 *
 * Auth: the Kimi SDK spawns the `kimi` CLI which inherits OAuth tokens from
 * `~/.kimi/config.toml`. We pre-flight with `isLoggedIn()` and throw a clear
 * error if the user hasn't logged in — mirroring the Claude "run `claude login`"
 * troubleshooting path.
 */
export class KimiExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  /**
   * Pre-flight auth check. Runs once per executor construction.
   * Using `isLoggedIn()` from the Kimi SDK which checks `~/.kimi/config.toml`.
   */
  private assertLoggedIn(): void {
    try {
      if (!isLoggedIn()) {
        throw new Error(
          'Kimi CLI is not logged in. Run `kimi login` in a separate terminal ' +
          'to authenticate with your Moonshot subscription, then restart MetaBot.'
        );
      }
    } catch (err: any) {
      if (err.message?.includes('Kimi CLI is not logged in')) throw err;
      this.logger.warn({ err }, 'Kimi isLoggedIn() check failed — continuing and letting SDK surface the real error');
    }
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;

    this.assertLoggedIn();

    this.logger.info(
      { cwd, hasSession: !!sessionId, outputsDir, engine: 'kimi' },
      'Starting Kimi execution (multi-turn)',
    );

    const session = this.createKimiSession(cwd, sessionId, options);

    // The Kimi SDK has no `systemPrompt.append` equivalent. We prepend the
    // MetaBot context (outputs directory, bot identity, group membership)
    // to the user's message so Kimi bots receive the same instructions
    // Claude bots do.
    const fullPrompt = this.buildPromptWithContext(prompt, outputsDir, apiContext);
    const turn: Turn = session.prompt(fullPrompt);

    // Wire abort signal → turn.interrupt(). Kimi's SDK doesn't accept an
    // AbortSignal directly, so we forward cancellation manually.
    if (abortController.signal.aborted) {
      turn.interrupt().catch(() => { /* already aborting */ });
    } else {
      abortController.signal.addEventListener(
        'abort',
        () => {
          this.logger.info({ sessionId: session.sessionId }, 'Kimi turn aborted via signal');
          turn.interrupt().catch((err) => this.logger.warn({ err }, 'turn.interrupt() rejected'));
        },
        { once: true },
      );
    }

    // Local state used when accumulating deltas for the final assistant message
    const state: TurnState = {
      sessionId: session.sessionId,
      accumulatedText: '',
      openToolCalls: new Map(),
      startTime: Date.now(),
    };

    const logger = this.logger;

    async function* wrapStream(): AsyncGenerator<SDKMessage> {
      // Emit a synthetic init message so StreamProcessor captures session_id
      yield {
        type: 'system',
        subtype: 'init',
        session_id: state.sessionId,
      };

      try {
        for await (const event of turn) {
          const emitted = translateEvent(event, state, logger);
          for (const msg of emitted) yield msg;
        }

        // Turn iterator finished — await the RunResult for final status
        const result: RunResult = await turn.result;
        yield buildResultMessage(result, state);
      } catch (err: any) {
        if (abortController.signal.aborted || err?.name === 'AbortError') {
          logger.info({ sessionId: state.sessionId }, 'Kimi execution aborted');
          // Emit a cancelled-style result so the bridge still closes the card
          yield {
            type: 'result',
            subtype: 'error_cancelled',
            session_id: state.sessionId,
            duration_ms: Date.now() - state.startTime,
            is_error: true,
            errors: ['Aborted by user'],
          };
          return;
        }
        logger.error({ err, sessionId: state.sessionId }, 'Kimi execution failed');
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: state.sessionId,
          duration_ms: Date.now() - state.startTime,
          is_error: true,
          errors: [err?.message || String(err)],
        };
      } finally {
        // Always close the Kimi session — sessionId is persisted on disk so
        // the next turn resumes by passing the same sessionId.
        try {
          await session.close();
        } catch (err) {
          logger.warn({ err, sessionId: state.sessionId }, 'Failed to close Kimi session');
        }
      }
    }

    return {
      stream: wrapStream(),
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        // Kimi uses `turn.respondQuestion(...)` for QuestionRequest events.
        // Phase 2 MVP: AskUserQuestion is not yet wired through for Kimi.
        // Log and no-op so the bridge doesn't crash.
        logger.warn({ engine: 'kimi' }, 'sendAnswer called on Kimi executor — not yet implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        logger.warn({ engine: 'kimi' }, 'resolveQuestion called on Kimi executor — not yet implemented');
      },
      finish: () => {
        // No input queue to close — single-turn model.
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const msg of handle.stream) {
        yield msg;
      }
    } finally {
      handle.finish();
    }
  }

  private createKimiSession(
    cwd: string,
    sessionId: string | undefined,
    options: ExecutorOptions,
  ): Session {
    const kimiOpts = this.config.kimi ?? {};
    return createSession({
      workDir: cwd,
      sessionId,
      model: options.model ?? kimiOpts.model,
      thinking: kimiOpts.thinking,
      yoloMode: true,
      executable: kimiOpts.executable,
    });
  }

  private buildPromptWithContext(
    prompt: string,
    outputsDir: string | undefined,
    apiContext: ApiContext | undefined,
  ): string {
    const sections: string[] = [];

    if (outputsDir) {
      sections.push(
        `## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nThe bridge will automatically send files placed there to the user.`,
      );
    }

    if (apiContext) {
      sections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`,
      );

      if (apiContext.groupMembers && apiContext.groupMembers.length > 0) {
        const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
        const groupId = apiContext.groupId;
        if (groupId) {
          sections.push(
            `## Group Chat\nYou are in a group chat (group: ${groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`mb talk <botName> grouptalk-${groupId}-<botName> "message"\``,
          );
        }
      }
    }

    if (sections.length === 0) return prompt;
    return `${prompt}\n\n---\n\n${sections.join('\n\n')}`;
  }
}

// --- Kimi → Claude event translation ---

interface TurnState {
  sessionId: string;
  accumulatedText: string;
  /** Kimi streams tool arguments across ToolCall + ToolCallPart events. */
  openToolCalls: Map<string, { name: string; argsBuffer: string }>;
  startTime: number;
}

function translateEvent(event: StreamEvent, state: TurnState, logger: Logger): SDKMessage[] {
  // ParseError and WireRequest types are not AsyncIterable events we expect
  // to process here with the current set of capabilities; log and skip.
  if (event.type === 'error') {
    logger.warn({ event }, 'Kimi emitted ParseError — skipping');
    return [];
  }

  switch (event.type) {
    case 'TurnBegin':
    case 'StepBegin':
    case 'StepInterrupted':
    case 'CompactionBegin':
    case 'CompactionEnd':
    case 'HookTriggered':
    case 'HookResolved':
    case 'SteerInput':
    case 'ApprovalResponse':
      // Lifecycle events with no direct CardState equivalent; skip.
      return [];

    case 'ContentPart': {
      const part = event.payload as { type: string; text?: string };
      if (part.type === 'text' && part.text) {
        state.accumulatedText += part.text;
        // Emit a streaming text_delta so StreamProcessor appends it live.
        return [{
          type: 'stream_event',
          session_id: state.sessionId,
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: part.text },
          },
        }];
      }
      // Thinking, images, audio, video — no rendering in the current card.
      return [];
    }

    case 'ToolCall': {
      const call = event.payload;
      const name = call.function.name;
      const args = call.function.arguments ?? '';
      state.openToolCalls.set(call.id, { name, argsBuffer: args });
      const input = safeParseJson(args);
      return [{
        type: 'assistant',
        session_id: state.sessionId,
        message: {
          content: [{ type: 'tool_use', id: call.id, name, input }],
        },
      }];
    }

    case 'ToolCallPart':
      // Streaming argument chunks. We already emitted the tool_use block on
      // ToolCall; StreamProcessor just needs the name to update the card.
      // Skip per-chunk emission to avoid duplicate card entries.
      return [];

    case 'ToolResult': {
      const tr = event.payload;
      state.openToolCalls.delete(tr.tool_call_id);
      const output = typeof tr.return_value.output === 'string'
        ? tr.return_value.output
        : JSON.stringify(tr.return_value.output);
      return [{
        type: 'user',
        session_id: state.sessionId,
        message: {
          content: [{ type: 'tool_result', id: tr.tool_call_id, text: output }],
        },
      }];
    }

    case 'StatusUpdate': {
      // Token usage is tracked but we don't emit until RunResult.
      return [];
    }

    case 'SubagentEvent': {
      // Flatten nested subagent events — StreamProcessor already filters
      // based on parent_tool_use_id. We pass through a minimal marker.
      const inner = event.payload.event;
      const msgs = translateEvent(inner as StreamEvent, state, logger);
      return msgs.map((m) => ({ ...m, parent_tool_use_id: event.payload.parent_tool_call_id }));
    }

    case 'TurnEnd':
      // Emit the final full assistant text block so StreamProcessor's
      // "full message text replaces accumulated stream text" branch captures
      // the complete answer text.
      if (state.accumulatedText) {
        return [{
          type: 'assistant',
          session_id: state.sessionId,
          message: {
            content: [{ type: 'text', text: state.accumulatedText }],
          },
        }];
      }
      return [];

    // WireRequest types that arrive in the iterator
    case 'ApprovalRequest':
      logger.info({ requestId: (event.payload as any).request_id }, 'Kimi ApprovalRequest — yoloMode should have allowed this');
      return [];
    case 'ToolCallRequest':
    case 'QuestionRequest':
    case 'HookRequest':
      logger.info({ type: event.type }, 'Kimi wire request — not yet handled');
      return [];

    default:
      return [];
  }
}

function buildResultMessage(result: RunResult, state: TurnState): SDKMessage {
  const isError = result.status !== 'finished';
  const subtype = result.status === 'finished'
    ? 'success'
    : result.status === 'cancelled'
      ? 'error_cancelled'
      : 'error_max_steps';
  return {
    type: 'result',
    subtype,
    session_id: state.sessionId,
    duration_ms: Date.now() - state.startTime,
    result: state.accumulatedText,
    is_error: isError,
    num_turns: result.steps,
    // Cost is unknown for Kimi (subscription model, no per-call price emitted).
    // Leave undefined — the card will omit the cost line.
  };
}

function safeParseJson(s: string): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}
