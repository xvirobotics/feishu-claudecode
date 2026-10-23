/**
 * PTY backend — ptyQuery(): drop-in replacement for the Agent SDK's query().
 *
 * Shaped identically at the call site in persistent-executor.ts:
 *   const stream = ptyQuery({ prompt: this.inputQueue, options: queryOptions });
 *   // stream is async-iterable<SDKMessage> AND has .interrupt()
 *
 * It wires together the three W1/W2 modules:
 *   - PtyClaudeSession  — drives a REAL interactive `claude` process (no -p),
 *     so the turn bills against the Claude Code subscription pool (via
 *     TeamClaude for load balancing) rather than the Agent SDK credit pool.
 *   - JsonlScanner      — tails the session jsonl, yielding raw records.
 *   - messageAdapter    — raw record → SDKMessage (the shape stream-processor
 *     already understands).
 *   - PtyHookBridge     — settings.json command hooks; the Stop hook fires
 *     onTurnComplete, which we turn into a synthesized terminal `result`
 *     SDKMessage (interactive jsonl has no explicit result line).
 *
 * Concurrency model: one unified AsyncQueue<SDKMessage> (`out`) is the single
 * output channel the caller iterates. Three detached loops feed/drive it:
 *   1. scanner loop  — adapts jsonl records into `out`, tracking usage/session.
 *   2. prompt loop   — consumes the input prompt iterable, typing each user
 *                      message into the TUI (one turn per message).
 *   3. turn-complete — on each Stop-hook fire, after a short drain delay (so
 *                      the scanner flushes the turn's final lines), emit the
 *                      synthesized `result`.
 */

import { randomUUID } from 'node:crypto';
import { openSync, readSync, statSync, closeSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '../executor.js';
import { AsyncQueue } from '../../../utils/async-queue.js';
import type {
  PtyQuery,
  PtyQueryOptions,
  PtyPromptSource,
  PtyUserMessage,
  PtyHookBridge,
  RawJsonlRecord,
} from './contract.js';
import { createPtyClaudeSession } from './pty-session.js';
import { createJsonlScanner } from './jsonl-scanner.js';
import { adaptJsonlRecord, synthesizeResult } from './message-adapter.js';
import { createHookBridge } from './hook-bridge.js';
import { driveInteractiveTool, isExitPlanMenu, parseAskMenuFromScreen } from './interactive-driver.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How often the ExitPlanMode screen watcher polls the snapshot. */
const EXITPLAN_WATCH_POLL_MS = 250;
/** Tail of the snapshot we scan for the approval prompt. */
const EXITPLAN_SNAPSHOT_TAIL = 4000;
/** Tail bytes of the jsonl we read to recover the latest ExitPlanMode tool_use. */
const EXITPLAN_JSONL_TAIL = 1024 * 1024;

/**
 * Recover the most recent ExitPlanMode tool_use from a session jsonl by reading
 * its tail and parsing every line — INCLUDING a trailing line with no newline.
 *
 * This is the crux of the "card only appears after /stop" fix: when `claude`
 * calls ExitPlanMode it blocks on the approval menu before flushing the line's
 * terminating newline, so the newline-only jsonl scanner can't see the record.
 * Reading raw bytes lets us recover `{ toolUseId, plan }` while the menu is
 * still on screen, so the bridge can surface the approval card immediately.
 *
 * Returns null if no ExitPlanMode tool_use is present in the tail.
 * Exported for unit tests.
 */
/**
 * The ExitPlanMode menu screen shows the plan file path
 * (`~/.claude/plans/<slug>.md`). claude writes that file BEFORE blocking on the
 * menu, so — unlike the ExitPlanMode tool_use record, whose newline isn't
 * flushed while the menu blocks — the plan body IS readable from disk. Parse the
 * path off the screen tail and read it. Returns '' if not found/readable.
 * Exported for unit tests.
 */
export function readPlanFromScreen(tail: string, homeDir: string = os.homedir()): string {
  const m = /\.claude\/plans\/([A-Za-z0-9._-]+\.md)/.exec(tail);
  if (!m) return '';
  try {
    return readFileSync(path.join(homeDir, '.claude', 'plans', m[1]), 'utf8');
  } catch {
    return '';
  }
}

export function readLatestExitPlan(
  jsonlPath: string,
  tailBytes: number = EXITPLAN_JSONL_TAIL,
): { toolUseId: string; plan: string } | null {
  let fd: number | undefined;
  try {
    const size = statSync(jsonlPath).size;
    if (size <= 0) return null;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fd = openSync(jsonlPath, 'r');
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    // Walk from the end so we return the LATEST ExitPlanMode. The very first
    // element may be a partial record (tail cut mid-line) — JSON.parse fails on
    // it and we skip, which is correct.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type !== 'assistant') continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && block?.name === 'ExitPlanMode' && block?.id) {
          const plan = typeof block.input?.plan === 'string' ? block.input.plan : '';
          return { toolUseId: block.id, plan };
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Drain delay after a Stop-hook fires before synthesizing the `result`. The
 * scanner polls every ~120ms; this gives it room to read the turn's final
 * assistant line(s) so the `result` is ordered AFTER them. Matches the POC's
 * proven ~500ms settle.
 */
const RESULT_DRAIN_MS = 450;

/** Extract a typeable prompt string from an input user message, or null. */
function extractPromptText(m: PtyUserMessage): string | null {
  const content = m.message?.content;
  if (typeof content === 'string') {
    return content.trim() ? content : null;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
    // tool_result-only message (e.g. AskUserQuestion answer fallback): cannot
    // be reliably injected via keystrokes in phase 1. See contract phase-2 note.
    return null;
  }
  return null;
}

/** Accumulated per-turn usage pulled off the latest assistant jsonl record. */
interface UsageAccum {
  inputTokens?: number;
  outputTokens?: number;
  /** Real model name from the assistant record's `message.model`. */
  model?: string;
}

export const ptyQuery = (args: {
  prompt: PtyPromptSource;
  options: PtyQueryOptions;
}): PtyQuery => {
  const { prompt, options } = args;
  const { logger } = options;

  // The single output channel the caller iterates.
  const out = new AsyncQueue<SDKMessage>();

  // Hook bridge: owns settings.json + Stop/team-event command hooks.
  const hookBridge: PtyHookBridge = options.hookBridge ?? createHookBridge();

  // Mutable per-run state.
  let sessionId = options.resume ?? '';
  let lastUsage: UsageAccum = {};
  let disposed = false;
  // True between the moment we type a prompt and the moment that turn's
  // terminal `result` is emitted (Stop hook). The exit watchdog uses it to
  // decide whether an unexpected claude death orphaned an in-flight turn.
  let turnInFlight = false;
  let typing = false;
  let session: ReturnType<typeof createPtyClaudeSession> | null = null;
  let scanner: ReturnType<typeof createJsonlScanner> | null = null;
  // Map the SDK-style systemPrompt ({type:'preset', append}) → --append flag.
  let appendSystemPrompt: string | undefined;
  const sp = options.systemPrompt;
  if (typeof sp === 'string') appendSystemPrompt = sp;
  else if (sp && typeof sp === 'object' && typeof sp.append === 'string') appendSystemPrompt = sp.append;

  // ── Boot: write settings, spawn session, start scanner ───────────────────
  const boot = (async () => {
    const settingsPath = await hookBridge.writeSettings();

    session = createPtyClaudeSession({
      cwd: options.cwd,
      resume: options.resume,
      model: options.model,
      appendSystemPrompt,
      settingsPath,
      env: options.env,
      pathToClaudeExecutable: options.pathToClaudeExecutable,
      cols: options.cols,
      rows: options.rows,
      logger,
      onExit: handleSessionExit,
    });
    if (!sessionId) sessionId = session.sessionId;

    scanner = createJsonlScanner({
      jsonlPath: session.jsonlPath,
      logger,
      startAtEnd: Boolean(options.resume),
    });

    // Stop-hook → synthesize a terminal `result` after a short drain delay.
    hookBridge.onTurnComplete(() => {
      if (disposed) return;
      // Mark the turn complete IMMEDIATELY (not in the drain timeout below) so
      // the slash-command idle watchdog stands down and never double-emits.
      turnInFlight = false;
      const usage = { ...lastUsage };
      // Reset for the next turn.
      lastUsage = {};
      setTimeout(() => {
        if (disposed) return;
        out.enqueue(
          synthesizeResult({
            sessionId,
            model: usage.model,
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
          }),
        );
      }, RESULT_DRAIN_MS);
    });

    // Scanner loop: adapt each raw record into the output channel.
    void runScanner();
    // Prompt loop: type each enqueued user message into the TUI.
    void runPromptLoop();
    // Screen watcher: the SINGLE detector for both interactive menus
    // (AskUserQuestion + ExitPlanMode). The jsonl record's newline isn't
    // flushed until the menu resolves, so a scanner alone surfaces the card too
    // late (only after /stop).
    void runInteractiveMenuWatcher();
  })();

  boot.catch((err) => {
    logger.error({ err }, 'ptyQuery: boot failed');
    out.finish();
  });

  // ── Scanner loop ─────────────────────────────────────────────────────────
  async function runScanner(): Promise<void> {
    if (!scanner) return;
    try {
      for await (const rec of scanner) {
        if (disposed) break;
        trackUsage(rec);
        if (!sessionId) {
          const sid = (rec.sessionId ?? rec.session_id) as string | undefined;
          if (sid) sessionId = sid;
        }
        const adapted = adaptJsonlRecord(rec);
        if (!adapted) continue;
        if (Array.isArray(adapted)) {
          for (const m of adapted) out.enqueue(m);
        } else {
          out.enqueue(adapted);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'ptyQuery: scanner loop ended with error');
    }
  }

  async function handleInteractiveTool(tool: {
    name: string;
    toolUseId: string;
    input: unknown;
  }): Promise<void> {
    if (disposed || !options.onInteractiveTool) return;
    try {
      const response = await options.onInteractiveTool(tool);
      if (!session) await boot;
      if (!session || disposed) {
        // The answer arrived after the session was torn down (e.g. claude died
        // while we awaited the user's reply). The exit watchdog has already
        // synthesized a terminal `result`, so this answer is moot — drop it.
        logger.warn(
          { tool: tool.name, toolUseId: tool.toolUseId, disposed },
          'ptyQuery: interactive answer arrived after session ended — dropping',
        );
        return;
      }
      await driveInteractiveTool({ session, tool, response, logger });

      // "Keep planning" Esc-cancels the ExitPlanMode tool (there is no "No,
      // keep planning" option in claude 2.1.x — only "Tell Claude what to
      // change"). claude marks "[Request interrupted by user for tool use]"
      // and returns to the prompt idle WITHOUT firing the Stop hook, so no
      // terminal `result` is emitted and the bridge would keep this turn
      // "running" forever — queueing the user's follow-up feedback instead of
      // sending it. Synthesize a terminal result to close the turn cleanly
      // (claude stays alive in plan mode; the next message revises the plan).
      if (tool.name === 'ExitPlanMode' && response.kind === 'cancel' && turnInFlight && !disposed) {
        await sleep(500); // let claude's interrupt line land first
        if (turnInFlight && !disposed) {
          logger.info('ptyQuery: keep-planning — synthesizing terminal result to end turn');
          turnInFlight = false;
          const usage = { ...lastUsage };
          lastUsage = {};
          out.enqueue(
            synthesizeResult({
              sessionId,
              model: usage.model,
              usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
            }),
          );
        }
      }
    } catch (err) {
      logger.warn({ err, tool: tool.name }, 'ptyQuery: interactive tool handling failed');
    }
  }

  /**
   * Watch the PTY SCREEN for either blocking interactive menu and surface its
   * Feishu card the moment it renders. BOTH tools are screen-detected because
   * ground-truth capture shows BOTH block before writing their tool_use line to
   * the jsonl — so a scanner-based detector only ever fires after the user gives
   * up (/stop). ExitPlanMode is read from the append-log snapshot + on-screen
   * plan file; AskUserQuestion is parsed from the clean `screen()` grid (its
   * question/options aren't in the jsonl yet).
   *
   * `armed` gates one hand-off per menu appearance: it flips false once we've
   * fired and re-arms when no menu is on screen for 2 consecutive polls (so a
   * single mid-redraw frame doesn't re-fire).
   */
  async function runInteractiveMenuWatcher(): Promise<void> {
    let armed = true;          // ExitPlanMode: one hand-off per menu appearance
    let absent = 0;            // consecutive polls with no interactive menu
    let lastAskSig: string | null = null; // signature of the AUQ question last surfaced
    let reviewSubmitted = false;           // pressed Enter on the AUQ review screen
    while (!disposed) {
      await sleep(EXITPLAN_WATCH_POLL_MS);
      if (disposed) break;
      if (!session || !options.onInteractiveTool) continue;
      let tail: string;
      try { tail = session.snapshot().slice(-EXITPLAN_SNAPSHOT_TAIL); } catch { continue; }

      const planMenu = isExitPlanMenu(tail);

      // AskUserQuestion is read from the CLEAN screen grid (its tool_use isn't in
      // the jsonl while the menu blocks). A multi-question call renders ONE tab
      // at a time and ends on a "Review your answers / Submit answers" screen, so
      // we surface each sub-question as its own card (keyed by a content
      // signature) and press Enter on the review screen to submit.
      let screen = '';
      if (!planMenu) { try { screen = session.screen(); } catch { screen = ''; } }
      const sqScreen = screen.toLowerCase().replace(/\s+/g, '');
      const reviewScreen =
        sqScreen.includes('readytosubmityouranswers') || sqScreen.includes('reviewyouranswers');
      const ask = (!planMenu && !reviewScreen)
        ? (parseAskMenuFromScreen(screen) as { questions: Array<Record<string, unknown>> } | null)
        : null;

      // AUQ review screen: all sub-questions answered → submit (default is
      // "1. Submit answers"). Press once per review appearance.
      if (reviewScreen) {
        absent = 0;
        if (!reviewSubmitted) {
          reviewSubmitted = true;
          logger.info('ptyQuery: AskUserQuestion review screen — submitting answers (Enter)');
          try { session.sendKeys('\r'); } catch { /* ignore */ }
        }
        continue;
      }
      reviewSubmitted = false;

      if (!planMenu && !ask) {
        // No interactive menu on screen. Re-arm after 2 clean polls.
        if (++absent >= 2) { armed = true; lastAskSig = null; }
        continue;
      }
      absent = 0;

      if (planMenu) {
        if (!armed) continue;
        armed = false;
        // The ExitPlanMode tool_use line isn't flushed to the jsonl while the
        // menu blocks, so do NOT gate on it. Read the plan body from the on-
        // screen plan file (written before the menu); fall back to the jsonl.
        const fromFile = readPlanFromScreen(tail);
        const fromJsonl = fromFile ? null : readLatestExitPlan(session.jsonlPath);
        const plan = fromFile || fromJsonl?.plan || '';
        const toolUseId = fromJsonl?.toolUseId || `exitplan-screen-${randomUUID()}`;
        logger.info({ toolUseId, planChars: plan.length }, 'ptyQuery: ExitPlanMode menu detected on screen — surfacing approval');
        void handleInteractiveTool({ name: 'ExitPlanMode', toolUseId, input: { plan } });
        continue;
      }

      // AskUserQuestion sub-question. Surface it once; re-surface only when the
      // question CHANGES (the TUI advanced to the next tab after an answer).
      const sig = JSON.stringify(ask!.questions[0] ?? {});
      if (sig === lastAskSig) continue;
      lastAskSig = sig;
      const toolUseId = `askq-screen-${randomUUID()}`;
      logger.info({ toolUseId }, 'ptyQuery: AskUserQuestion menu detected on screen — surfacing question');
      void handleInteractiveTool({ name: 'AskUserQuestion', toolUseId, input: ask });
    }
  }

  /**
   * Pull token usage off an assistant record so synthesizeResult can report it.
   *
   * Context-window occupation = input_tokens + cache_read_input_tokens +
   * cache_creation_input_tokens (matches stream-processor's SDK path). In an
   * interactive session with prompt caching, `input_tokens` alone is just the
   * tiny uncached delta — the conversation history lives in the cache_* fields.
   * Summing only input_tokens produced the bogus "ctx: 33/200k" display.
   * The latest assistant record reflects the most recent API call's full
   * context, so overwriting per-record (not accumulating) is correct.
   */
  function trackUsage(rec: RawJsonlRecord): void {
    if (rec.type !== 'assistant') return;
    const msg = rec.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const totalInput =
      num(usage.input_tokens) +
      num(usage.cache_read_input_tokens) +
      num(usage.cache_creation_input_tokens);
    const outT = usage.output_tokens as number | undefined;
    if (totalInput > 0) lastUsage.inputTokens = totalInput;
    if (typeof outT === 'number') lastUsage.outputTokens = outT;
    const model = msg?.model as string | undefined;
    if (typeof model === 'string' && model) lastUsage.model = model;
  }

  // ── Prompt loop ──────────────────────────────────────────────────────────
  async function runPromptLoop(): Promise<void> {
    try {
      for await (const userMsg of prompt) {
        if (disposed) break;
        const text = extractPromptText(userMsg as PtyUserMessage);
        if (text === null) {
          logger.warn(
            'ptyQuery: skipping non-typeable input message (tool_result/empty) — phase 2',
          );
          continue;
        }
        if (!session) await boot; // ensure session exists
        if (!session || disposed) break;
        turnInFlight = true; // a new turn starts the moment we submit the prompt
        typing = true;
        try { await session.typePrompt(text); }
        finally { typing = false; }
        // Client-side slash commands (/effort, /model, /status, …) change a
        // setting WITHOUT a model turn → no assistant record, no Stop hook, so
        // no `result` would ever be synthesized and the caller's turn hangs.
        // Watch for the TUI returning to idle without running the model and
        // synthesize a `result` ourselves. Custom-skill slash commands that DO
        // invoke the model show the "esc to interrupt" affordance → the watchdog
        // stands down and the normal Stop-hook path completes the turn.
        if (text.trim().startsWith('/')) void watchSlashCommandCompletion();
      }
    } catch (err) {
      logger.warn({ err }, 'ptyQuery: prompt loop ended with error');
    }
    // Prompt source finished → no more turns will be started. Tear down.
    await dispose();
  }

  // ── Slash-command idle watchdog ────────────────────────────────────────────
  /** Grace period for a model turn to START (show "esc to interrupt"). */
  const SLASH_GRACE_MS = 6_000;
  /** Absolute cap before we stop watching (let the Stop/exit watchdogs handle). */
  const SLASH_MAX_MS = 30_000;
  /** "Model is actively running" signal in the (squished) TUI footer. */
  const RUNNING_MARKER = 'esctointerrupt';

  /**
   * After a slash-command prompt, decide whether it ran the model or was a
   * client-side no-turn command. If the model never started (no "esc to
   * interrupt") and the TUI returned to idle, synthesize a terminal `result`
   * so the caller's turn completes instead of hanging.
   */
  async function watchSlashCommandCompletion(): Promise<void> {
    const start = Date.now();
    let sawRunning = false;
    while (!disposed) {
      if (!turnInFlight) return; // Stop hook already completed this turn
      const tail = (session?.snapshot() ?? '').slice(-2000).toLowerCase().replace(/\s+/g, '');
      if (tail.includes(RUNNING_MARKER)) sawRunning = true;
      const elapsed = Date.now() - start;
      if (sawRunning) return; // real model turn — let the Stop-hook path finish it
      if (elapsed > SLASH_GRACE_MS) {
        // No model turn ever started → client-side command. Complete the turn.
        turnInFlight = false;
        logger.info('ptyQuery: slash command ran with no model turn — synthesizing result');
        out.enqueue(
          synthesizeResult({
            sessionId,
            model: lastUsage.model,
            usage: { inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens },
          }),
        );
        return;
      }
      if (elapsed > SLASH_MAX_MS) return; // bail; Stop/exit watchdog is the backstop
      await sleep(300);
    }
  }

  // ── Exit watchdog ──────────────────────────────────────────────────────────
  /**
   * The claude PTY process exited. If we initiated the teardown (`disposed`),
   * this is the normal path and dispose() already finished `out`. Otherwise the
   * process died unexpectedly (crash, killed/cancelled menu, OOM). If a turn was
   * still in flight — e.g. claude blocked on an AskUserQuestion menu and we were
   * awaiting the user's Feishu reply when the process died — no Stop hook will
   * ever fire, so we MUST synthesize a terminal `result` ourselves. Without it
   * the caller's `for await` never sees a turn end and the executor wedges.
   */
  function handleSessionExit(info: { exitCode: number; signal?: number }): void {
    if (disposed) return; // normal teardown via dispose()
    logger.warn({ ...info, turnInFlight }, 'ptyQuery: claude exited unexpectedly');
    if (turnInFlight) {
      turnInFlight = false;
      out.enqueue(
        synthesizeResult({
          sessionId,
          isError: true,
          resultText: 'claude process exited before the turn completed',
          model: lastUsage.model,
          usage: { inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens },
        }),
      );
    }
    // The session is gone; no further turns can run on it. Tear down so the
    // caller's iteration ends cleanly instead of hanging forever.
    void dispose();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  async function interrupt(): Promise<void> {
    if (!session) {
      // Boot may still be in flight; wait briefly then try.
      try {
        await Promise.race([boot, sleep(2000)]);
      } catch {
        /* ignore */
      }
    }
    if (session) await session.interrupt();
    // ESC + Ctrl-C cancels the in-flight model turn but, unlike a clean turn
    // end, fires NO Stop hook — and unlike a crash, the process stays alive, so
    // handleSessionExit never runs either. That means NO terminal `result` would
    // ever be synthesized for an interrupted turn. The persistent executor's
    // abort() awaits a drainPromise that only resolves when consumeLoop sees a
    // `result`; without one, activeTurn is never cleared and the NEXT user
    // message wedges with "turn <id> is in flight" (blank reply in Feishu).
    // Synthesize the terminal result here, guarded by turnInFlight so we never
    // double-emit against the Stop-hook path (mirrors handleSessionExit).
    if (turnInFlight && !disposed) {
      turnInFlight = false;
      logger.info('ptyQuery: turn interrupted — synthesizing terminal result');
      out.enqueue(
        synthesizeResult({
          sessionId,
          isError: true,
          resultText: 'turn interrupted',
          model: lastUsage.model,
          usage: { inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens },
        }),
      );
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      scanner?.stop();
    } catch {
      /* ignore */
    }
    try {
      await hookBridge.dispose();
    } catch {
      /* ignore */
    }
    try {
      await session?.dispose();
    } catch {
      /* ignore */
    }
    out.finish();
  }

  // ── The drop-in PtyQuery ─────────────────────────────────────────────────
  const query: PtyQuery = {
    [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    canSteer: () => turnInFlight && !typing && !disposed && !!session?.steerPrompt,
    async steer(text) {
      if (!query.canSteer?.() || !session?.steerPrompt) return 'no-active-turn';
      typing = true;
      try { await session.steerPrompt(text); return 'steered'; }
      finally { typing = false; }
    },
    interrupt,
    dispose,
  };
  return query;
};
