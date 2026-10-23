/**
 * PTY backend — shared contract.
 *
 * WHY THIS EXISTS
 * ---------------
 * From mid-June 2026, the Claude Agent SDK (and `claude -p` / headless) no
 * longer bills against a Claude Code subscription — only INTERACTIVE
 * `claude` (the TUI, started without `-p`) stays on the subscription pool.
 * The billing pool is selected by the user-agent entrypoint marker
 * (`(external, cli)` interactive vs `(external, sdk-cli)` headless), which is
 * driven by the `CLAUDE_CODE_ENTRYPOINT` env var. TeamClaude is a transparent
 * header-preserving proxy, so a PTY-driven interactive `claude` routed through
 * TeamClaude = subscription pool + multi-Max-account load balancing.
 *
 * GOAL
 * ----
 * Replace the single Agent-SDK `query()` call in persistent-executor.ts with a
 * drop-in `ptyQuery()` that drives a REAL interactive `claude` process via a
 * PTY and reconstructs the structured `SDKMessage` stream by tailing the
 * session jsonl. Everything else in persistent-executor.ts stays the same.
 *
 * THE SEAM (persistent-executor.ts ~line 428)
 * -------------------------------------------
 *   const stream = query({ prompt: this.inputQueue, options: queryOptions });
 *   this.queryHandle = stream;                       // used for .interrupt()
 *   this.rawStream  = stream as AsyncGenerator<SDKMessage>; // consumed in consumeLoop
 *
 * consumeLoop (line ~828) only relies on the stream being an async-iterable of
 * SDKMessage and on `msg.session_id` / `msg.type === 'result'`. abort() (line
 * ~497) only relies on `queryHandle.interrupt()`. So the drop-in must satisfy
 * exactly {@link PtyQuery}: async-iterable<SDKMessage> + interrupt().
 *
 * The prompt source is an `AsyncIterable<SDKUserMessage>` (an AsyncQueue). Each
 * enqueued user message = one turn (or a tool_result injection). The PTY
 * session consumes that iterable and types prompts into the TUI as keystrokes.
 *
 * This file is types/interfaces ONLY — no runtime logic — so every teammate
 * can build against a stable shape in parallel.
 */

import type { SDKMessage } from '../executor.js';
import type { Logger } from '../../../utils/logger.js';

// SDKUserMessage is the SDK's input shape. We re-declare the structural subset
// the PTY backend consumes so the pty module has no hard dependency on the SDK
// package (which we are migrating away from). It is assignment-compatible with
// `@anthropic-ai/claude-agent-sdk`'s SDKUserMessage for the fields we read.
export interface PtyUserMessage {
  type: 'user';
  message: {
    role: 'user';
    /** Either a plain prompt string, or structured content blocks (e.g. tool_result). */
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
        }>;
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

/** Async-iterable prompt source (the persistent executor's inputQueue). */
export type PtyPromptSource = AsyncIterable<PtyUserMessage>;

/**
 * Options accepted by {@link ptyQuery}. This is intentionally a SUBSET of the
 * Agent SDK's query options — only the fields the PTY backend can honor. The
 * caller (persistent-executor.ts) passes its full `queryOptions` object; extra
 * fields are ignored. We list the ones that matter so teammates know what to
 * wire through to the spawned `claude` process.
 */
export interface PtyQueryOptions {
  /** Working directory for the claude process. Drives the jsonl path. */
  cwd: string;
  /** Resume an existing session id (claude --resume / --session-id). */
  resume?: string;
  /** Model override (claude --model). */
  model?: string;
  /**
   * System prompt. The SDK uses { type:'preset', preset:'claude_code', append }.
   * For PTY we map `append` → `--append-system-prompt <text>`. The preset
   * (claude_code) is the interactive default, so only `append` is forwarded.
   */
  systemPrompt?: { type: 'preset'; preset: string; append?: string } | string;
  /**
   * Hook definitions (AskUserQuestion PreToolUse + Agent Teams observers). In
   * SDK mode these are JS callbacks. In PTY mode they must be written into the
   * generated --settings json as `command` hooks that bridge back to this
   * process (file/fifo). The adapter owns this translation; ptyQuery receives
   * the already-built {@link PtyHookBridge} rather than raw SDK hooks.
   */
  hookBridge?: PtyHookBridge;
  /** Logger (mirrors PersistentExecutorOptions.logger). */
  logger: Logger;
  /**
   * Extra env to merge onto the spawned process. Production passes the
   * TeamClaude creds (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) so traffic is
   * load-balanced across Max accounts. CLAUDE_CODE_ENTRYPOINT is left as the
   * interactive default (NOT 'sdk-cli') so billing lands on the subscription.
   */
  env?: NodeJS.ProcessEnv;
  /** Path to the claude executable (defaults to resolveClaudePath()). */
  pathToClaudeExecutable?: string;
  /** PTY geometry. Defaults: 120x40. */
  cols?: number;
  rows?: number;
  /**
   * Resolve an interactive tool that the TUI renders as a blocking menu.
   *
   * In SDK mode AskUserQuestion answers arrive as a `tool_result` on the input
   * stream (and ExitPlanMode is auto-approved via `canUseTool`). The PTY can
   * only TYPE into the TUI, so instead ptyQuery detects these tool_use records
   * in the jsonl and asks the executor (which owns the Feishu question/plan
   * machinery) how to respond; ptyQuery then drives the native menu via
   * keystrokes. Returning is the SAME resolve path the bridge already uses
   * (executor.resolveQuestion → pendingQuestionResolvers).
   *
   * Called once per detected interactive tool_use. For ExitPlanMode it should
   * return `{ kind: 'approve' }` promptly; for AskUserQuestion it resolves only
   * after the user answers (or the executor's 6-min timeout).
   */
  onInteractiveTool?: (tool: PtyInteractiveTool) => Promise<PtyInteractiveResponse>;
}

/** An interactive tool_use detected in the session jsonl. */
export interface PtyInteractiveTool {
  /** Tool name: 'AskUserQuestion' | 'ExitPlanMode'. */
  name: string;
  /** The tool_use id (used as the resolver key). */
  toolUseId: string;
  /** The raw tool_use.input (questions[] for AskUserQuestion, plan for ExitPlanMode). */
  input: unknown;
}

/** How ptyQuery should drive the TUI menu for a detected interactive tool. */
export type PtyInteractiveResponse =
  | {
      kind: 'answers';
      /** Map of question header/text → chosen label or custom free text. */
      answers: Record<string, string>;
      /** Parsed questions (header + ordered option labels + multiSelect flag). */
      questions: PtyParsedQuestion[];
    }
  | { kind: 'approve' }
  | { kind: 'cancel' };

/** A single AskUserQuestion question, parsed into the fields the keystroke layer needs. */
export interface PtyParsedQuestion {
  /** Header/title (the key used in the answers map). */
  header: string;
  /** The question text (fallback answers-map key). */
  question: string;
  /** Option labels in menu order. */
  options: string[];
  multiSelect: boolean;
}

/**
 * The drop-in return value. Mirrors the SDK `Query`'s two contact points used
 * by persistent-executor.ts:
 *   1. async-iterable of SDKMessage (for `for await` in consumeLoop)
 *   2. interrupt(): Promise<void> (for turn abort)
 */
export interface PtyQuery extends AsyncIterable<SDKMessage> {
  canSteer?(): boolean;
  steer?(text: string): Promise<'steered' | 'no-active-turn'>;
  /** Interrupt the in-flight turn (sends ESC/Ctrl-C to the TUI). */
  interrupt(): Promise<void>;
  /** Tear down the PTY process + scanner. Called on executor shutdown. */
  dispose?(): Promise<void>;
}

/**
 * Drop-in replacement for the SDK's `query()`. Shaped identically at the call
 * site:
 *   const stream = ptyQuery({ prompt, options });
 */
export type PtyQueryFn = (args: {
  prompt: PtyPromptSource;
  options: PtyQueryOptions;
}) => PtyQuery;

// ── PtyClaudeSession (W1) ────────────────────────────────────────────────────

/**
 * Owns the long-lived interactive `claude` PTY process for one session.
 * Responsibilities:
 *   - Self-generate a session id (uuid) so the jsonl path is predictable, OR
 *     adopt `resume`.
 *   - spawn `claude` (NO -p) with --session-id/--resume, --settings,
 *     --dangerously-skip-permissions, --append-system-prompt.
 *   - Wait for TUI readiness (the `❯` input box) before accepting input.
 *   - typePrompt(): feed a prompt as keystrokes + submit (Enter), with the
 *     double-Enter safeguard proven in the POC.
 *   - interrupt(): ESC/Ctrl-C to stop the current turn.
 *   - lifecycle: ready/exit/error events; dispose() kills the process.
 */
export interface PtyClaudeSession {
  readonly sessionId: string;
  /** Resolves once the TUI input box is ready to accept typing. */
  ready(): Promise<void>;
  /** Type a prompt string into the TUI and submit it. */
  typePrompt(text: string): Promise<void>;
  /** Submit plain text while the model is working, without interrupting it. */
  steerPrompt?(text: string): Promise<void>;
  /**
   * Write raw bytes to the PTY (no prompt-submit framing). Used by the
   * interactive-tool keystroke layer to drive native TUI menus.
   */
  sendKeys(data: string): void;
  /** ANSI-stripped snapshot of the recent PTY output ring (for menu parsing). */
  snapshot(): string;
  /**
   * The current terminal SCREEN as clean text rows (cursor-resolved grid from a
   * headless emulator). Reliable for parsing structured menus (AskUserQuestion
   * question/options/checkboxes/tabs), unlike the append-log `snapshot()`.
   */
  screen(): string;
  /** Send an interrupt (ESC / Ctrl-C) to cancel the in-flight turn. */
  interrupt(): Promise<void>;
  /** Kill the PTY process and clean up. */
  dispose(): Promise<void>;
  /** Path to the session jsonl file the scanner should tail. */
  readonly jsonlPath: string;
}

export interface PtyClaudeSessionOptions {
  cwd: string;
  resume?: string;
  model?: string;
  appendSystemPrompt?: string;
  /** Absolute path to a settings.json (contains Stop + team hooks). */
  settingsPath: string;
  env?: NodeJS.ProcessEnv;
  pathToClaudeExecutable?: string;
  cols?: number;
  rows?: number;
  logger: Logger;
  /**
   * Fired when the underlying `claude` process exits. ptyQuery uses this to
   * detect an UNEXPECTED death (crash, killed menu, etc.) while a turn is still
   * in flight, so it can synthesize a terminal `result` and avoid orphaning the
   * caller's turn. A normal dispose() also triggers the process exit; the
   * consumer distinguishes via its own disposed flag.
   */
  onExit?: (info: { exitCode: number; signal?: number }) => void;
}

// ── JsonlScanner (W2) ────────────────────────────────────────────────────────

/** A raw line parsed from the session jsonl (shape varies by record type). */
export type RawJsonlRecord = Record<string, unknown>;

/**
 * Tails `<session>.jsonl`, emitting each newly-appended JSON record exactly
 * once (in order). Must handle: file-not-yet-created, partial last line,
 * truncation/rotation on resume. Polling (fs.watch + interval fallback) is
 * acceptable; the POC used a simple read-diff loop.
 */
export interface JsonlScanner extends AsyncIterable<RawJsonlRecord> {
  /** Stop tailing and end the async iteration. */
  stop(): void;
}

export type CreateJsonlScanner = (args: {
  jsonlPath: string;
  logger: Logger;
  /** Poll interval ms (default ~120). */
  pollMs?: number;
  /**
   * Start tailing from the file's current EOF instead of replaying existing
   * lines. Used for `claude --resume`: the old transcript is context, not new
   * output for this bridge turn.
   */
  startAtEnd?: boolean;
}) => JsonlScanner;

// ── messageAdapter (W2) ──────────────────────────────────────────────────────

/**
 * Translates raw jsonl records → the in-repo {@link SDKMessage} shape that
 * stream-processor.ts already understands. Key responsibilities:
 *   - assistant records → { type:'assistant', message:{content:[...]}, session_id, uuid }
 *   - user records (tool_result, task-notification) → { type:'user', ... }
 *   - system records → { type:'system', subtype, session_id }
 *   - Synthesize a terminal { type:'result', subtype:'success', session_id, ... }
 *     when the Stop-hook sentinel fires (jsonl has no explicit result line in
 *     interactive mode). usage/cost pulled from the last assistant record.
 *   - Drop / passthrough partial stream events as appropriate.
 *
 * Stateless per-record where possible; turn-boundary (result synthesis) is
 * driven by the hook bridge, not the adapter alone.
 */
export type AdaptJsonlRecord = (
  record: RawJsonlRecord,
) => SDKMessage | SDKMessage[] | null;

/** Build a synthetic terminal `result` SDKMessage to close a turn. */
export interface SynthesizeResultArgs {
  sessionId: string;
  /** Accumulated assistant text for the `result` field (optional). */
  resultText?: string;
  isError?: boolean;
  numTurns?: number;
  /** Real model name (from the assistant jsonl records), e.g. claude-fable-5. */
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUSD?: number;
  };
}
export type SynthesizeResult = (args: SynthesizeResultArgs) => SDKMessage;

// ── Hook bridge (W2/W4) ──────────────────────────────────────────────────────

/**
 * In SDK mode hooks are JS callbacks invoked in-process. In PTY mode the
 * spawned `claude` runs hooks as shell `command`s defined in --settings json.
 * The hook bridge is the file/fifo channel that turns those shell invocations
 * back into in-process signals:
 *   - Stop hook → fires `onTurnComplete` (drives result synthesis)
 *   - TaskCreated/TaskCompleted/TeammateIdle → fire `onTeamEvent`
 *   - PreToolUse(AskUserQuestion) → harder; phase 2 (questions). For phase 1 we
 *     can omit interactive question answering and document the gap.
 *
 * `writeSettings()` materializes the settings.json (with command hooks pointed
 * at small bridge scripts) and returns its path for the session to consume.
 */
export interface PtyHookBridge {
  /** Absolute path of the generated settings.json (with command hooks). */
  writeSettings(): Promise<string>;
  /** Register the per-turn completion callback (Stop hook sentinel). */
  onTurnComplete(cb: () => void): void;
  /** Register team-event callback (TaskCreated/Completed/TeammateIdle). */
  onTeamEvent(cb: (event: { kind: string; payload: unknown }) => void): void;
  /** Tear down watchers/fifos. */
  dispose(): Promise<void>;
}

/**
 * MILESTONE TEST CONTRACT (W5) — the integration test must prove, against a
 * REAL `claude` (or the capture stub), that:
 *   1. ptyQuery({prompt, options}) yields a `session` system msg, ≥1 `assistant`
 *      msg with text, and a terminal `result` msg — for a one-line prompt.
 *   2. A second enqueued PtyUserMessage drives a SECOND turn on the SAME
 *      process (proves persistence / no -p).
 *   3. interrupt() ends the in-flight turn (result/abort) without killing the
 *      process; a subsequent turn still works.
 *   4. The emitted SDKMessage shapes are accepted by stream-processor.ts
 *      without throwing (snapshot the CardState transitions).
 */
