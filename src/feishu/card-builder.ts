// Re-export shared types so existing imports from this module continue to work
export type {
  CardStatus,
  ToolCall,
  PendingQuestion,
  CardState,
  BackgroundEvent,
  BackgroundTaskStatus,
} from '../types.js';
import type { CardState, CardStatus } from '../types.js';

const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '🔵' },
  running: { color: 'blue', title: 'Running...', icon: '🔵' },
  complete: { color: 'green', title: 'Complete', icon: '🟢' },
  error: { color: 'red', title: 'Error', icon: '🔴' },
  waiting_for_input: { color: 'yellow', title: 'Waiting for Input', icon: '🟡' },
  // Blue with a distinct title so users can tell a between-turn burst card
  // apart from both a live "running" turn and a finished "complete" reply
  // without reading body text. See message-bridge.flushSpontaneous.
  agent_activity: { color: 'blue', title: 'Agent activity', icon: '🔵' },
};

const BG_ICON: Record<'running' | 'completed' | 'failed' | 'stopped', string> = {
  running: '⏳',
  completed: '✅',
  failed: '❌',
  stopped: '⏹️',
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

const MAX_CONTENT_LENGTH = 28000;

function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  const half = Math.floor(MAX_CONTENT_LENGTH / 2) - 50;
  return (
    text.slice(0, half) +
    '\n\n... (content truncated) ...\n\n' +
    text.slice(-half)
  );
}

// --- Markdown table → Feishu column_set conversion ---

interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/** Parse a markdown table line into cell values. */
function parseTableRow(line: string): string[] {
  return line
    .trim()
    .split('|')
    .slice(1, -1) // drop empty strings from leading/trailing |
    .map((cell) => cell.trim());
}

/** Check if a line is a markdown table separator (|---|---|). */
function isSeparatorLine(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

/** Detect and parse a complete markdown table starting at the given line index.
 *  Returns the table and the next line index, or null if not a valid table. */
function tryParseTable(lines: string[], startIdx: number): { table: MarkdownTable; nextIdx: number } | null {
  const firstLine = lines[startIdx].trim();
  if (!firstLine.startsWith('|') || !firstLine.endsWith('|')) return null;

  const headers = parseTableRow(firstLine);
  if (headers.length === 0) return null;

  let idx = startIdx + 1;

  // Must have a separator line next
  if (idx >= lines.length || !isSeparatorLine(lines[idx])) return null;
  idx++;

  // Collect data rows
  const rows: string[][] = [];
  while (idx < lines.length) {
    const line = lines[idx].trim();
    if (!line.startsWith('|') || !line.endsWith('|')) break;
    if (isSeparatorLine(line)) { idx++; continue; }
    const cells = parseTableRow(line);
    // Pad or trim to match header count
    while (cells.length < headers.length) cells.push('');
    rows.push(cells.slice(0, headers.length));
    idx++;
  }

  // Need at least header + separator to be a valid table
  if (rows.length === 0 && idx === startIdx + 2) {
    // Table with only headers, no data rows — still valid
  }

  return { table: { headers, rows }, nextIdx: idx };
}

/** Maximum columns for column_set rendering; wider tables fall back to markdown. */
const MAX_TABLE_COLS = 6;

/** Convert a parsed MarkdownTable into a Feishu column_set element. */
function tableToColumnSet(table: MarkdownTable): unknown {
  const colCount = table.headers.length;
  const columns = table.headers.map((header, colIdx) => {
    const elements: unknown[] = [
      // Header row — bold
      { tag: 'markdown', content: `**${header}**` },
    ];
    // Data rows
    for (const row of table.rows) {
      elements.push({ tag: 'markdown', content: row[colIdx] || '' });
    }
    return {
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements,
    };
  });

  return { tag: 'column_set', columns };
}

/** Split markdown content into card elements, converting tables to column_set. */
export function splitMarkdownByTables(text: string): unknown[] {
  const lines = text.split('\n');
  const elements: unknown[] = [];
  let markdownBuf: string[] = [];
  let i = 0;

  const flushMarkdown = () => {
    const content = markdownBuf.join('\n');
    if (content) {
      elements.push({ tag: 'markdown', content });
    }
    markdownBuf = [];
  };

  while (i < lines.length) {
    // Check if this line starts a markdown table
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|') && line.length > 1) {
      const result = tryParseTable(lines, i);
      if (result && result.table.headers.length <= MAX_TABLE_COLS) {
        // Valid table within column limit — flush preceding markdown, emit column_set
        flushMarkdown();
        elements.push(tableToColumnSet(result.table));
        i = result.nextIdx;
        continue;
      }
      // Not a valid table or too many columns — treat as regular markdown
    }
    markdownBuf.push(lines[i]);
    i++;
  }

  flushMarkdown();
  return elements;
}

export function buildCard(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // Goal badge — pinned at the top so users see at a glance that the
  // session is in goal-driven mode (Claude /goal). Persists across turns
  // until /goal clear or /reset.
  if (state.goalCondition) {
    elements.push({
      tag: 'markdown',
      content: `🎯 **Goal:** ${truncate(state.goalCondition, 200)}`,
    });
    elements.push({ tag: 'hr' });
  }

  // Agent Teams panel — teammates + shared task list. Driven by Claude
  // Code's TaskCreated / TaskCompleted / TeammateIdle hooks; rendered here
  // so the user sees the team state without having to switch panes.
  if (state.teamState && (state.teamState.teammates.length > 0 || state.teamState.tasks.length > 0)) {
    const ts = state.teamState;
    const lines: string[] = [];
    const header = ts.name ? `🧑‍🤝‍🧑 **Team:** \`${ts.name}\`` : '🧑‍🤝‍🧑 **Team**';
    lines.push(header);
    if (ts.teammates.length > 0) {
      lines.push('');
      lines.push('**Teammates:**');
      for (const m of ts.teammates) {
        const icon = m.status === 'working' ? '⏳' : '💤';
        const subj = m.lastSubject ? ` — _${truncate(m.lastSubject, 60)}_` : '';
        lines.push(`${icon} \`${m.name}\` (${m.status})${subj}`);
      }
    }
    if (ts.tasks.length > 0) {
      // Show in-progress first, then most recent completions
      const inProgress = ts.tasks.filter(t => t.status === 'in_progress');
      const completed = ts.tasks.filter(t => t.status === 'completed').slice(-5);
      lines.push('');
      lines.push(`**Tasks:** ${inProgress.length} in progress · ${ts.tasks.filter(t => t.status === 'completed').length} done`);
      for (const t of inProgress) {
        const owner = t.teammate ? ` → \`${t.teammate}\`` : '';
        lines.push(`⏳ ${truncate(t.subject, 80)}${owner}`);
      }
      for (const t of completed) {
        const owner = t.teammate ? ` (\`${t.teammate}\`)` : '';
        lines.push(`✅ ${truncate(t.subject, 80)}${owner}`);
      }
    }
    elements.push({ tag: 'markdown', content: lines.join('\n') });
    elements.push({ tag: 'hr' });
  }

  // Tool calls indicator — single line, no per-tool list. See the v2 builder
  // for the rationale (users only care about the final answer; the running
  // tool list was noise). One line while in flight so a hung run is visibly
  // hung; section disappears entirely on complete/error.
  if (
    state.toolCalls.length > 0 &&
    state.status !== 'complete' &&
    state.status !== 'error'
  ) {
    const last  = state.toolCalls[state.toolCalls.length - 1];
    const icon  = last.status === 'running' ? '⏳' : '✅';
    const total = state.toolCalls.length;
    elements.push({
      tag: 'markdown',
      content: `${icon} **${last.name}** · ${total} tool${total > 1 ? 's' : ''}`,
    });
    elements.push({ tag: 'hr' });
  }

  // Background tasks (Monitor, etc.) — show live stdout events / final status
  if (state.backgroundEvents && state.backgroundEvents.length > 0) {
    const lines = state.backgroundEvents.map((ev) => {
      const icon = BG_ICON[ev.status];
      const shortId = ev.taskId.slice(0, 6);
      const desc = truncate(ev.description, 60);
      const last = ev.lastEvent ? ` — _${truncate(ev.lastEvent, 140)}_` : '';
      return `${icon} **${desc}** \`${shortId}\`${last}`;
    });
    elements.push({
      tag: 'markdown',
      content: '📡 **Background**\n' + lines.join('\n'),
    });
    elements.push({ tag: 'hr' });
  }

  // Response content
  if (state.responseText) {
    const contentElements = splitMarkdownByTables(truncateContent(state.responseText));
    elements.push(...contentElements);
  } else if (state.status === 'thinking') {
    elements.push({
      tag: 'markdown',
      content: '_Thinking..._',
    });
  }

  // Pending question section — text-only: numbered options + prominent
  // "type the number" instruction. Buttons used to live here, but:
  //   - Card Schema 2.0 mobile silently drops `tag: action` button blocks
  //     (bug-feishu-v2-mobile-action-buttons), so buttons go invisible.
  //   - Card Schema 1.0 buttons DO render on mobile, but clicks return
  //     Feishu code 200340 (the click event never reaches us, suspected
  //     v1 callbacks no longer route through `WSClient` persistent
  //     connection in the v2 era — would require setting up an HTTP
  //     webhook URL in the Feishu Open Platform app config).
  // Decision: drop buttons entirely, default to typed answers. The text
  // path is reliable on every Feishu surface (desktop / mobile / web).
  if (state.pendingQuestion) {
    elements.push({ tag: 'hr' });
    state.pendingQuestion.questions.forEach((q) => {
      const descLines = q.options.map(
        (opt, i) => `**${i + 1}.** ${opt.label} — _${opt.description}_`,
      );
      elements.push({
        tag: 'markdown',
        content: [`**[${q.header}] ${q.question}**`, '', ...descLines].join('\n'),
      });
    });
    elements.push({
      tag: 'markdown',
      content: '**👇 请回复数字（1/2/…）或直接输入文字答案**',
    });
  }

  // Error message
  if (state.errorMessage) {
    elements.push({
      tag: 'markdown',
      content: `**Error:** ${state.errorMessage}`,
    });
  }

  // Stats note — show context usage during all states, full stats on complete/error
  {
    const parts: string[] = [];
    if (state.totalTokens && state.contextWindow) {
      const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
      const tokensK = state.totalTokens >= 1000
        ? `${(state.totalTokens / 1000).toFixed(1)}k`
        : `${state.totalTokens}`;
      const ctxK = `${Math.round(state.contextWindow / 1000)}k`;
      parts.push(`ctx: ${tokensK}/${ctxK} (${pct}%)`);
    }
    if (state.status === 'complete' || state.status === 'error') {
      if (state.sessionCostUsd != null) {
        parts.push(`$${state.sessionCostUsd.toFixed(2)}`);
      }
      if (state.model) {
        // Strip the claude- prefix (claude-opus-4-7 → opus-4-7) but keep the
        // full Kimi model name since e.g. `for-coding` loses too much context.
        parts.push(state.model.replace(/^claude-/, ''));
      }
      if (state.durationMs !== undefined) {
        parts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
      }
    }
    if (parts.length > 0) {
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: parts.join(' | '),
          },
        ],
      });
    }
  }

  const card = {
    // update_multi lets us re-render the same card after an action click
    // without hitting Feishu error 108002 ("card has already been updated").
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: config.color,
      title: {
        content: `${config.icon} ${config.title}`,
        tag: 'plain_text',
      },
    },
    elements,
  };

  return JSON.stringify(card);
}

export function buildHelpCard(): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📖 Help',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**Available Commands:**',
          '`/reset` - Clear session, start fresh',
          '`/stop` - Abort current running task',
          '`/status` - Show current session info',
          '`/memory` - Memory document commands',
          '`/help` - Show this help message',
          '',
          '**Usage:**',
          'Send any text message to start a conversation with Claude Code.',
          'Each chat has an independent session with a fixed working directory.',
          '',
          '**Memory Commands:**',
          '`/memory list` - Show folder tree',
          '`/memory search <query>` - Search documents',
          '`/memory status` - Server health check',
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildStatusCard(
  userId: string,
  workingDirectory: string,
  sessionId: string | undefined,
  isRunning: boolean,
): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📊 Status',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**User:** \`${userId}\``,
          `**Working Directory:** \`${workingDirectory}\``,
          `**Session:** ${sessionId ? `\`${sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildTextCard(title: string, content: string, color: string = 'blue'): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: {
        content: title,
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
  return JSON.stringify(card);
}
