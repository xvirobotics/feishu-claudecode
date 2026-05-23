/**
 * Transcript reader — parses a Claude Code Agent SDK jsonl transcript into a
 * structured per-turn message list suitable for rendering in the web UI.
 *
 * Why this is separate from SessionRegistry.getMessages():
 *   - getMessages strips everything except text blocks (tool_use, tool_result
 *     and thinking are dropped) so the IM "recent history" view stays small.
 *   - For the transcript page we MUST preserve tool calls + their results +
 *     thinking blocks, otherwise the page is barely more useful than the
 *     final card itself.
 *
 * Turn definition:
 *   - "Turn N" is the N-th `type:'user'` jsonl entry (1-based) together with
 *     every assistant entry that follows, up to but not including the (N+1)th
 *     user entry.
 *   - `turn === 'all'` returns everything.
 *   - tool_result blocks live inside the *next* user entry's `content[]` —
 *     we pair them back into their originating assistant message by
 *     `tool_use_id`. Once paired, the carrier user entry that contained ONLY
 *     tool_results (no text) is hidden from the output so the page reads as
 *     "user → assistant (with tool calls) → user → assistant".
 */
import * as fs from 'node:fs';

export type TranscriptToolCall = {
  id:       string;
  name:     string;
  input:    unknown;
  result?:  { content: unknown; isError?: boolean };
  status:   'done';
};

export type TranscriptMessage = {
  id:           string;            // jsonl line index, stringified for stability
  role:         'user' | 'assistant';
  text?:        string;            // markdown
  toolCalls?:   TranscriptToolCall[];
  thinking?:    string;
  timestamp:    string;            // ISO-8601 if available, else ''
};

export interface ReadTranscriptResult {
  totalTurns: number;
  messages:   TranscriptMessage[];
}

interface RawJsonlEntry {
  type?:      string;
  message?:   {
    role?:    string;
    content?: unknown;
  };
  timestamp?: string | number;
  uuid?:      string;
}

interface ContentBlock {
  type?:        string;
  text?:        string;
  thinking?:    string;
  // tool_use
  id?:          string;
  name?:        string;
  input?:       unknown;
  // tool_result
  tool_use_id?: string;
  content?:     unknown;
  is_error?:    boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function toTimestamp(t: unknown): string {
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return new Date(t).toISOString();
  return '';
}

function blocksFromContent(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/**
 * Read a jsonl transcript and project it onto a structured message list for
 * the requested turn (or all turns).
 *
 * Robustness: invalid jsonl lines are skipped silently; missing file returns
 * an empty result rather than throwing — the caller (HTTP route) will treat
 * either as "transcript not available yet".
 */
export function readTranscript(
  sessionJsonlPath: string,
  turn: number | 'all',
): ReadTranscriptResult {
  if (!fs.existsSync(sessionJsonlPath)) {
    return { totalTurns: 0, messages: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionJsonlPath, 'utf-8');
  } catch {
    return { totalTurns: 0, messages: [] };
  }

  // Phase 1 — parse every line, identify user-turn boundaries.
  const lines: Array<RawJsonlEntry & { _idx: number }> = [];
  let userTurnCount = 0;
  // Track which "real" user lines (i.e. with at least one text/string-content
  // block, NOT a pure tool_result carrier) bumped the turn count.
  const userTurnIndexByLine: number[] = [];

  raw.split('\n').forEach((line, idx) => {
    if (!line) return;
    let evt: RawJsonlEntry;
    try {
      evt = JSON.parse(line) as RawJsonlEntry;
    } catch {
      return;
    }
    if (!evt.type) return;
    lines.push({ ...evt, _idx: idx });

    if (evt.type === 'user' && isObject(evt.message) && evt.message.role === 'user') {
      const blocks = blocksFromContent(evt.message.content);
      const hasUserText =
        blocks.some(
          (b) =>
            (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) ||
            (b.type === undefined && typeof (b as unknown as { text?: string }).text === 'string') ||
            (typeof evt.message?.content === 'string'),
        );
      const hasOnlyToolResults =
        blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
      if (hasUserText && !hasOnlyToolResults) {
        userTurnCount += 1;
        userTurnIndexByLine[lines.length - 1] = userTurnCount;
      }
    }
  });

  if (userTurnCount === 0) {
    return { totalTurns: 0, messages: [] };
  }

  // Determine [startIdx, endIdx) in `lines` for the requested turn.
  let startIdx = 0;
  let endIdx   = lines.length;
  if (turn !== 'all') {
    const turnN = Math.max(1, Math.min(userTurnCount, Math.floor(turn)));
    let startBoundary = -1;
    let endBoundary   = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const idxTurn = userTurnIndexByLine[i];
      if (idxTurn === turnN) {
        if (startBoundary === -1) startBoundary = i;
      } else if (idxTurn === turnN + 1) {
        endBoundary = i;
        break;
      }
    }
    if (startBoundary === -1) {
      return { totalTurns: userTurnCount, messages: [] };
    }
    startIdx = startBoundary;
    endIdx   = endBoundary;
  }

  // Phase 2 — build a flat map of tool_use_id → result so the result blocks
  // (which live in the *next* user entry) get folded back into the assistant
  // message that issued the call. Scan the WHOLE file (not just the turn
  // window) — a tool call near the end of one turn might have its result in
  // the very next user line whose `_idx` lies past `endIdx`.
  const toolResultById = new Map<string, { content: unknown; isError?: boolean }>();
  for (const entry of lines) {
    if (entry.type === 'user' && isObject(entry.message) && entry.message.role === 'user') {
      for (const b of blocksFromContent(entry.message.content)) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          toolResultById.set(b.tool_use_id, {
            content: b.content ?? '',
            ...(b.is_error ? { isError: true } : {}),
          });
        }
      }
    }
  }

  // Phase 3 — render the turn window. Skip user entries that are pure
  // tool_result carriers (their data is inlined into the prior assistant).
  const messages: TranscriptMessage[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const evt = lines[i];
    if (!evt.type) continue;
    const ts = toTimestamp(evt.timestamp);

    if (evt.type === 'user' && isObject(evt.message) && evt.message.role === 'user') {
      const blocks = blocksFromContent(evt.message.content);
      const onlyToolResults =
        blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
      if (onlyToolResults) continue;

      let text: string;
      if (typeof evt.message.content === 'string') {
        text = evt.message.content;
      } else {
        text = blocks
          .filter((b) => b.type === 'text' || b.type === undefined)
          .map((b) => (typeof b.text === 'string' ? b.text : ''))
          .join('\n')
          .trim();
      }
      if (text || blocks.length === 0) {
        messages.push({
          id:        evt.uuid || String(evt._idx),
          role:      'user',
          text,
          timestamp: ts,
        });
      }
    } else if (evt.type === 'assistant' && isObject(evt.message) && evt.message.role === 'assistant') {
      const blocks = blocksFromContent(evt.message.content);
      let text     = '';
      let thinking = '';
      const toolCalls: TranscriptToolCall[] = [];

      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') {
          text += (text ? '\n' : '') + b.text;
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          thinking += (thinking ? '\n' : '') + b.thinking;
        } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          const result = toolResultById.get(b.id);
          toolCalls.push({
            id:     b.id,
            name:   b.name,
            input:  b.input ?? {},
            status: 'done',
            ...(result ? { result } : {}),
          });
        }
      }

      const isEmpty = !text && !thinking && toolCalls.length === 0;
      if (isEmpty) continue;
      messages.push({
        id:         evt.uuid || String(evt._idx),
        role:       'assistant',
        ...(text     ? { text }     : {}),
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        timestamp:  ts,
      });
    }
  }

  return { totalTurns: userTurnCount, messages };
}
