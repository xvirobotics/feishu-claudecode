/**
 * PTY backend — interactive-tool keystroke driver.
 *
 * The SDK delivers AskUserQuestion answers as a `tool_result` on the input
 * stream and auto-approves ExitPlanMode via `canUseTool`. A PTY can only TYPE
 * into the TUI, so for these two tools we instead drive the native blocking
 * menu with KEYSTROKES. Empirically (see memory/pty-backend.md):
 *
 *   - AskUserQuestion menu: `❯ 1. <label>` … `N. Type something` …
 *     Pressing the DIGIT N immediately selects AND submits option N (no Enter).
 *     "Type something" (= options.length+1) opens a free-text box: press its
 *     digit, type the text, press Enter.
 *   - ExitPlanMode menu: a numbered selection menu whose wording varies by
 *     claude build (2.1.158 "Would you like to proceed? 1.Yes,bypass…" vs the
 *     simpler "Exit plan mode? 1.Yes 2.No"). We detect it STRUCTURALLY (see
 *     isExitPlanMenu / parseSelectionMenu) rather than by button text, and pick
 *     the proceed digit by preferring "bypass permissions", avoiding the
 *     "manually approve" / decline options (findBypassPermissionsDigit).
 */

import type { Logger } from '../../../utils/logger.js';
import type {
  PtyClaudeSession,
  PtyInteractiveResponse,
  PtyInteractiveTool,
  PtyParsedQuestion,
} from './contract.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long to wait for a menu to render after the tool_use appears in jsonl. */
const MENU_WAIT_MS = 20_000;
const MENU_POLL_MS = 200;
/** Only inspect the tail of the snapshot — the current screen is at the end. */
const SNAPSHOT_TAIL = 4000;

/** Poll the session snapshot tail until `test` matches or we time out. */
async function waitForScreen(
  session: PtyClaudeSession,
  test: (tail: string) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (test(session.snapshot().slice(-SNAPSHOT_TAIL))) return true;
    await sleep(MENU_POLL_MS);
  }
  return false;
}

/**
 * Drive the TUI menu for one detected interactive tool, per the executor's
 * response. Best-effort: logs and returns on failure (the 6-min hook timeout /
 * turn abort is the backstop). Never throws.
 */
export async function driveInteractiveTool(args: {
  session: PtyClaudeSession;
  tool: PtyInteractiveTool;
  response: PtyInteractiveResponse;
  logger: Logger;
}): Promise<void> {
  const { session, tool, response, logger } = args;
  try {
    if (tool.name === 'ExitPlanMode') {
      if (response.kind === 'cancel') {
        // User chose "Keep planning" (or timed out into it). Esc cancels the
        // approval menu, leaving claude in plan mode awaiting the user's next
        // message — the mirror of approveExitPlanMode's proceed path.
        logger.info({ toolUseId: tool.toolUseId }, 'pty-driver: keeping plan mode (Esc)');
        session.sendKeys('\x1b');
        return;
      }
      await approveExitPlanMode(session, logger);
      return;
    }
    if (tool.name === 'AskUserQuestion') {
      if (response.kind === 'cancel') {
        // User declined / timed out — Esc cancels the menu so claude unblocks.
        logger.info({ toolUseId: tool.toolUseId }, 'pty-driver: cancelling AskUserQuestion menu (Esc)');
        session.sendKeys('\x1b');
        return;
      }
      if (response.kind === 'answers') {
        await answerQuestions(session, response.answers, response.questions, logger);
      }
      return;
    }
    logger.warn({ tool: tool.name }, 'pty-driver: no handler for interactive tool');
  } catch (err) {
    logger.warn({ err, tool: tool.name }, 'pty-driver: drive failed');
  }
}

// ── ExitPlanMode ─────────────────────────────────────────────────────────────

/** Window to wait for the ExitPlanMode approval menu before assuming none. */
const EXITPLAN_MENU_WAIT_MS = 8_000;

async function approveExitPlanMode(session: PtyClaudeSession, logger: Logger): Promise<void> {
  // NOTE: the ANSI-stripped snapshot glues words together (no spaces), so all
  // screen matching is done on the squished (whitespace-removed) text.
  //
  // Under --dangerously-skip-permissions the interactive TUI usually
  // AUTO-PROCEEDS on ExitPlanMode with NO approval menu, so this is mostly
  // defensive. Match ONLY the real prompt ("Would you like to proceed?") — NOT
  // the persistent footer ("bypass permissions on ..."), which would false-fire.
  const ready = await waitForScreen(
    session,
    (t) => isExitPlanMenu(t),
    EXITPLAN_MENU_WAIT_MS,
  );
  if (!ready) {
    logger.info('pty-driver: no ExitPlanMode approval menu (auto-proceeded under bypass)');
    return;
  }
  // Let the menu settle (avoid catching a half-drawn frame).
  await sleep(300);
  const digit = findBypassPermissionsDigit(session.snapshot().slice(-SNAPSHOT_TAIL));
  if (digit === null) {
    logger.warn('pty-driver: could not locate "Yes, and bypass permissions" option');
    return;
  }
  logger.info({ digit }, 'pty-driver: approving ExitPlanMode (bypass permissions)');
  session.sendKeys(digit);
}

/**
 * Parse the on-screen numbered menu into `{ digit, label, pointer }` entries.
 *
 * claude renders a blocking selection menu as one option per line:
 *   `❯ 1. Yes, and bypass permissions` / `  2. No` …
 * The ANSI-stripped snapshot GLUES intra-line words (no spaces survive) but
 * keeps newlines, so we match each line's squished form `N.<label>` where the
 * label starts with a LETTER — that excludes version strings like "2.1.158".
 * The `❯`/`>` pointer glyph survives the strip, so we record which option is
 * the highlighted default. Last occurrence of each digit wins (most recent
 * redraw, since the PTY ring accumulates re-renders).
 */
export interface MenuOption {
  digit: string;
  label: string;
  pointer: boolean;
}
export function parseMenuOptions(tail: string): MenuOption[] {
  const byDigit = new Map<string, { label: string; pointer: boolean }>();
  for (const line of tail.split('\n')) {
    const pointer = /[❯>›▸▶]/.test(line);
    const sq = squish(line);
    // Leading pointer/bullet glyphs may precede the digit; the label must begin
    // with a letter so "2.1.158" / "10s" don't masquerade as options.
    const m = /(?:^|[^0-9])(\d)\.([a-z].*)$/.exec(sq);
    if (m) byDigit.set(m[1], { label: m[2], pointer });
  }
  return [...byDigit.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([digit, v]) => ({ digit, ...v }));
}

/**
 * A plan-approval (or any blocking) selection menu, recognised STRUCTURALLY:
 * at least two options whose digits are consecutive (1,2 or 2,3 …). This is
 * wording-independent, so it survives claude rebrands of the button text.
 * Returns the parsed options, or null if no menu structure is present.
 */
export function parseSelectionMenu(tail: string): MenuOption[] | null {
  const opts = parseMenuOptions(tail);
  if (opts.length < 2) return null;
  const nums = opts.map((o) => Number(o.digit));
  const consecutive = nums.some((n) => nums.includes(n + 1));
  return consecutive ? opts : null;
}

/**
 * Return the digit of the option that PROCEEDS without re-enabling per-edit
 * permission prompts, across every observed menu shape:
 *   - 2.1.158 "Would you like to proceed?": 1.Yes,bypass / 2.Yes,manual / 3.No,refine / 4.Tell Claude
 *   - simpler "Exit plan mode?": 1.Yes / 2.No
 *   - legacy: 1.Yes / 2.Yes,bypass / 3.No,keep planning
 * Preference: an explicit "bypass permissions" option; else the affirmative
 * "Yes" option that is not "manually approve"; else the highlighted default;
 * else the first option. Returns null only when no numbered options exist.
 */
export function findBypassPermissionsDigit(tail: string): string | null {
  const opts = parseMenuOptions(tail);
  if (opts.length === 0) return null;
  // 1) explicit "and bypass permissions" (and not a "clear context" variant).
  for (const o of opts) {
    if (o.label.includes('bypasspermissions') && !o.label.includes('clearcontext')) return o.digit;
  }
  // 2) first affirmative "Yes…" that isn't the manual-approve / clear-context one.
  for (const o of opts) {
    if (o.label.startsWith('yes') && !o.label.includes('manuallyapprove') && !o.label.includes('clearcontext')) {
      return o.digit;
    }
  }
  // 3) the highlighted default, if it isn't an obvious decline.
  const ptr = opts.find((o) => o.pointer);
  if (ptr && !ptr.label.startsWith('no') && !ptr.label.startsWith('tell')) return ptr.digit;
  // 4) last resort: the first option (the default affirmative in every menu seen).
  return opts[0].digit;
}

// ── AskUserQuestion ──────────────────────────────────────────────────────────

/** Window to wait for the final "Review your answers / Submit answers" screen. */
const REVIEW_WAIT_MS = 6_000;

/**
 * Drive a (possibly multi-question) AskUserQuestion. Verified TUI semantics
 * (see pty-backend.md "multi-question" capture):
 *
 *   - Multiple questions render as TABS: `← ☐ Q0 ☐ Q1 ✔ Submit →`. The body
 *     shows ONLY the focused tab's question + options, so we discriminate the
 *     active tab by its first option label (the header sits in the always-on
 *     tab bar and can't tell us which tab is focused).
 *   - A SINGLE-SELECT question: pressing the digit selects AND auto-advances to
 *     the next tab (or, for the last question, to the review screen). For a lone
 *     single-select question it submits outright (no review screen).
 *   - A MULTISELECT question: pressing each digit only TOGGLES its checkbox;
 *     it never advances. A single right-arrow (`\x1b[C`) then advances one tab.
 *   - After the last question the TUI shows `Review your answers … ❯ 1. Submit
 *     answers`. Enter confirms (the default). We do this ONCE, at the end —
 *     never inside a per-question step (which would submit prematurely while
 *     later questions are still unanswered).
 */
async function answerQuestions(
  session: PtyClaudeSession,
  answers: Record<string, string>,
  questions: PtyParsedQuestion[],
  logger: Logger,
): Promise<void> {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = (answers[q.header] ?? answers[q.question] ?? '').trim();

    // Discriminate the active tab by the focused question's first option label.
    // It appears only in the body of THIS question's tab — unlike the header,
    // which is always present in the tab bar — so it tells us the tab actually
    // advanced before we act (avoids typing into a stale/previous frame).
    const marker = q.options[0] || q.header || '';
    const ready = await waitForScreen(
      session,
      (t) => {
        const s = squish(t);
        return s.includes('entertoselect') && (marker === '' || s.includes(squish(marker)));
      },
      MENU_WAIT_MS,
    );
    if (!ready) {
      logger.warn({ qIndex: i, header: q.header }, 'pty-driver: AskUserQuestion menu never rendered');
      await submitAnswersAsPrompt(session, answers, questions, i, logger);
      return;
    }
    await sleep(250);

    if (q.multiSelect) {
      // Toggles each wanted option, then right-arrow to advance ONE tab.
      await answerMultiSelect(session, q, answer, logger);
    } else {
      const idx = matchOptionIndex(q.options, answer);
      if (idx >= 0) {
        const digit = String(idx + 1); // menu is 1-based
        logger.info({ header: q.header, digit, answer }, 'pty-driver: selecting AskUserQuestion option');
        session.sendKeys(digit); // selects AND auto-advances one tab
      } else {
        await answerFreeText(session, q, answer, logger); // type + Enter advances
      }
    }
    // Let the TUI advance to the next tab / the review screen.
    await sleep(700);
  }

  // Final submit. A lone single-select question already submitted on its digit
  // (no review screen), so skip it. Any other shape — 2+ questions, or any
  // multiSelect — lands on the review screen and needs a confirming Enter.
  const needsReviewSubmit = questions.length > 1 || questions.some((q) => q.multiSelect);
  if (!needsReviewSubmit) return;

  const review = await waitForScreen(
    session,
    (t) => {
      const s = squish(t);
      return s.includes('submitanswers') || s.includes('reviewyouranswers') || s.includes('readytosubmit');
    },
    REVIEW_WAIT_MS,
  );
  if (!review) {
    logger.warn('pty-driver: AskUserQuestion review/submit screen never appeared');
    return;
  }
  await sleep(300);
  logger.info('pty-driver: confirming AskUserQuestion (Submit answers)');
  session.sendKeys('\r'); // "Submit answers" is the focused default
}

/**
 * Fallback when the AskUserQuestion menu cannot be driven — typically a
 * resumed session replaying a historical question frame that never becomes
 * interactive again. Submit the user's answers as a plain follow-up prompt so
 * the reply still reaches the session instead of wedging the turn.
 */
async function submitAnswersAsPrompt(
  session: PtyClaudeSession,
  answers: Record<string, string>,
  questions: PtyParsedQuestion[],
  fromIndex: number,
  logger: Logger,
): Promise<void> {
  const parts: string[] = [];
  for (let i = fromIndex; i < questions.length; i++) {
    const question = questions[i];
    const answer = (answers[question.header] ?? answers[question.question] ?? '').trim();
    if (!answer) continue;
    parts.push(question.header ? `${question.header}: ${answer}` : answer);
  }
  const text = parts.join('; ');
  if (!text) return;
  logger.info({ text }, 'pty-driver: AskUserQuestion unavailable — submitting answers as prompt');
  await session.typePrompt(text);
}

/** Use the "Type something" free-text option: digit → type text → Enter. */
async function answerFreeText(
  session: PtyClaudeSession,
  q: PtyParsedQuestion,
  text: string,
  logger: Logger,
): Promise<void> {
  // "Type something" sits immediately after the real options → 1-based digit.
  const digit = String(q.options.length + 1);
  logger.info({ header: q.header, digit, text }, 'pty-driver: free-text answer');
  session.sendKeys(digit);
  await sleep(700); // wait for the input box to open
  for (const ch of text) session.sendKeys(ch);
  await sleep(400);
  session.sendKeys('\r');
}

/**
 * Answer ONE multiSelect (checkbox) question, then advance one tab. Verified
 * flow (see pty-backend.md):
 *   - Each option line is `N.[ ] <label>`; pressing the DIGIT N TOGGLES the
 *     checkbox (it does NOT submit OR advance, unlike single-select).
 *   - A single right-arrow (`\x1b[C`) then advances ONE tab — to the next
 *     question, or to the Submit/Review tab if this was the last question.
 *
 * The final Submit-answers confirmation is handled ONCE by answerQuestions
 * after every question is answered — NOT here — so that a multiSelect that is
 * not the last question doesn't submit prematurely.
 *
 * The answer string is the comma-joined selected labels (e.g. "Cats, Birds"),
 * matching how the SDK/Feishu resolver hands back a multiSelect answer and how
 * the tool_result renders it. We split on commas and toggle each matched option.
 * Falls back to free-text if nothing matches (so claude still gets the string).
 */
async function answerMultiSelect(
  session: PtyClaudeSession,
  q: PtyParsedQuestion,
  answer: string,
  logger: Logger,
): Promise<void> {
  const wanted = answer
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const toggled: number[] = [];
  for (const w of wanted) {
    const idx = matchOptionIndex(q.options, w);
    if (idx < 0) {
      logger.warn({ header: q.header, label: w }, 'pty-driver: multiSelect option not matched');
      continue;
    }
    if (toggled.includes(idx)) continue; // already on — avoid toggling back off
    const digit = String(idx + 1); // menu is 1-based
    logger.info({ header: q.header, digit, label: q.options[idx] }, 'pty-driver: toggling multiSelect option');
    session.sendKeys(digit);
    toggled.push(idx);
    await sleep(350);
  }
  if (toggled.length === 0) {
    logger.warn({ header: q.header }, 'pty-driver: no multiSelect options matched — free-text fallback');
    await answerFreeText(session, q, answer, logger);
    return;
  }
  // multiSelect never auto-advances — right-arrow moves to the next tab.
  logger.info({ header: q.header, toggled }, 'pty-driver: advancing past multiSelect (→ next tab)');
  session.sendKeys('\x1b[C');
}

/** Case-insensitive, whitespace-insensitive option match. -1 if no match. */
export function matchOptionIndex(options: string[], answer: string): number {
  if (!answer) return -1;
  const a = squish(answer);
  for (let i = 0; i < options.length; i++) {
    if (squish(options[i]) === a) return i;
  }
  // Looser: option label contained in the answer or vice-versa.
  for (let i = 0; i < options.length; i++) {
    const o = squish(options[i]);
    if (o && (a.includes(o) || o.includes(a))) return i;
  }
  return -1;
}

/** Lowercase + strip all whitespace (the ANSI strip glues words together). */
function squish(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

// ── AskUserQuestion screen parsing ───────────────────────────────────────────

/** One parsed AskUserQuestion question, in the AskUserQuestion tool_input shape. */
export interface ParsedAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** Options the TUI always appends that are NOT real answers — excluded. */
function isMetaOption(label: string): boolean {
  const s = squish(label);
  return s.startsWith('typesomething') || s.startsWith('chataboutthis') || s === 'submit';
}

/** A screen line that is a numbered menu option → `{ digit, rest, pointer }`. */
function matchOptionLine(line: string): { digit: number; rest: string; pointer: boolean } | null {
  const m = /^\s*([❯>›▸▶])?\s*(\d+)\.\s+(\S.*)$/.exec(line);
  if (!m) return null;
  return { digit: Number(m[2]), rest: m[3].trim(), pointer: Boolean(m[1]) };
}

/**
 * Parse the AskUserQuestion menu from a CLEAN terminal screen (PtyClaudeSession
 * `screen()`, NOT the append-log snapshot) into the AskUserQuestion tool_input
 * shape `{ questions: [ParsedAskQuestion] }`, or null if the screen isn't an
 * AskUserQuestion menu.
 *
 * Why screen, not jsonl: ground-truth capture shows claude does NOT write the
 * AskUserQuestion tool_use to the session jsonl until the menu RESOLVES — so the
 * scanner can't see it in time (the card would only appear after /stop). The
 * full menu, however, is on screen the instant it blocks. The clean grid
 * (@xterm/headless) renders it as tidy rows (captured from claude 2.1.158):
 *
 *      ☐ Color                          ←  ☐ Fruit  ☐ Toppings  ✔ Submit  →
 *     What is your favorite color?      What is your favorite fruit?
 *     ❯ 1. Red                          ❯ 1. [ ] Cheese      ← `[ ]` ⟹ multiSelect
 *          The color red.                    Add cheese.
 *       2. Green                          2. [ ] Onion
 *       4. Type something.   ← meta        5. [ ] Type something  ← meta
 *       5. Chat about this   ← meta        6. Chat about this     ← meta
 *     Enter to select · ↑/↓ to navigate · Esc to cancel
 *
 * Multi-QUESTION menus render a tab bar and show only the focused question's
 * body, so we surface just that first question (matches the bridge's existing
 * single-sub-question limitation) — but immediately, not after /stop.
 */
export function parseAskMenuFromScreen(screen: string): { questions: ParsedAskQuestion[] } | null {
  const sq = squish(screen);
  // Footer is the reliable, wording-stable AskUserQuestion signal.
  if (!(sq.includes('entertoselect') && sq.includes('esctocancel'))) return null;
  const lines = screen.split('\n');

  // Header: the focused tab/question label. Single-question shows "☐ Color";
  // multi-question shows a tab bar "←  ☐ Fruit  ☐ Toppings  ✔ Submit  →" — take
  // the first non-"Submit" tab label either way.
  let header = '';
  for (const line of lines) {
    if (!/[☐✔☑▢◻]/.test(line)) continue;
    for (const m of line.matchAll(/[☐✔☑▢◻]\s*([^☐✔☑▢◻→←]+)/g)) {
      const lbl = m[1].trim();
      if (lbl && !/^submit\b/i.test(lbl)) { header = lbl; break; }
    }
    if (header) break;
  }

  // Options: numbered lines, in order. Strip a `[ ]`/`[x]` checkbox (⟹ multi-
  // select). Stop at the meta options ("Type something" / "Chat about this").
  const options: Array<{ label: string; description: string }> = [];
  let multiSelect = false;
  let firstOptionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const opt = matchOptionLine(lines[i]);
    if (!opt) continue;
    if (firstOptionIdx < 0) firstOptionIdx = i;
    let label = opt.rest;
    const cb = /^\[([ xX])\]\s*(.*)$/.exec(label);
    if (cb) { multiSelect = true; label = cb[2].trim(); }
    if (isMetaOption(label)) continue; // skip meta — the card re-adds free-text
    // Description: the next non-blank line that isn't another option/separator.
    let description = '';
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (matchOptionLine(lines[j])) break;
      if (/^[─—-]{3,}/.test(t) || squish(t).includes('entertoselect')) break;
      description = t; break;
    }
    options.push({ label, description });
  }
  if (options.length === 0) return null;

  // Question text: nearest non-blank line above the first option that isn't the
  // tab bar or a separator.
  let question = '';
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/[☐✔☑▢◻]/.test(t)) break; // reached the tab bar
    if (/^[─—-]{3,}/.test(t)) continue;
    question = t; break;
  }

  return {
    questions: [{ question, header: header || question.slice(0, 40), options, multiSelect }],
  };
}

/**
 * Detect the ExitPlanMode approval menu on a (raw) screen tail.
 *
 * Two ground-truth menu shapes exist (both captured via node-pty):
 *   A. claude 2.1.158 interactive / tool-call:
 *      "…Would you like to proceed?  1.Yes,bypass  2.Yes,manual  3.No,refine…  4.Tell Claude"
 *   B. simpler tool-call confirmation:
 *      "Exit plan mode?  Claude wants to exit plan mode  1.Yes  2.No"
 * Earlier guesses keyed off exact button wording ("No, keep planning",
 * "bypass permissions") and broke whenever claude rebranded the buttons. So we
 * detect STRUCTURALLY instead — a numbered selection menu (≥2 consecutive
 * options) — and confirm it's the PLAN menu via a wording-free context signal:
 * the on-screen `~/.claude/plans/<slug>.md` path claude always shows for a
 * plan-approval menu, with the (still version-dependent, but only secondary)
 * title phrases as a fallback for builds that omit the path. Exported + reused
 * by both the driver and the pty-query screen watcher so they agree on one
 * signal.
 */
export function isExitPlanMenu(tail: string): boolean {
  if (!parseSelectionMenu(tail)) return false; // no numbered menu on screen
  // Primary signal: the plan file path claude renders on a plan-approval menu.
  if (/\.claude\/plans\//.test(tail)) return true;
  // Fallback: title phrasing (version-dependent, but we no longer rely on the
  // exact OPTION wording — the menu structure above is the load-bearing check).
  const s = squish(tail);
  return (
    s.includes('wouldyouliketoproceed') ||
    s.includes('readytocode') ||
    s.includes('exitplanmode') ||
    s.includes('claudewantstoexitplanmode') ||
    s.includes("hereisclaude'splan") ||
    s.includes('hereisclaudesplan') ||
    s.includes("claude'splan") ||
    s.includes('keepplanning')
  );
}
