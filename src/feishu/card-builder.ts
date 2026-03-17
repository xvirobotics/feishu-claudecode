// Re-export shared types so existing imports from this module continue to work
export type { CardStatus, ToolCall, PendingQuestion, CardState, SubagentTask } from '../types.js';
import type { CardState, CardStatus } from '../types.js';

const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '🔵' },
  running: { color: 'blue', title: 'Running...', icon: '🔵' },
  complete: { color: 'green', title: 'Complete', icon: '🟢' },
  error: { color: 'red', title: 'Error', icon: '🔴' },
  waiting_for_input: { color: 'yellow', title: 'Waiting for Input', icon: '🟡' },
};

const MAX_CONTENT_LENGTH = 28000;

/**
 * Parse a Markdown table block into headers and rows.
 * Returns null if the text is not a valid Markdown table.
 */
function parseMarkdownTable(block: string): { headers: string[]; rows: string[][] } | null {
  const lines = block.trim().split('\n');
  if (lines.length < 2) return null;

  // Header row must contain pipes
  const headerLine = lines[0].trim();
  if (!headerLine.includes('|')) return null;

  // Second line must be the separator (dashes and pipes)
  const sepLine = lines[1].trim();
  if (!/^[\s|:-]+$/.test(sepLine)) return null;

  const parseCells = (line: string): string[] =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  const headers = parseCells(headerLine);
  if (headers.length === 0) return null;

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.includes('|')) continue;
    rows.push(parseCells(line));
  }

  return { headers, rows };
}

/**
 * Strip Markdown formatting from text, leaving plain content.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * Convert a parsed Markdown table into a Feishu card table element.
 * Uses the Feishu card v2 table component with column_list and rows.
 */
function buildFeishuTableElement(table: { headers: string[]; rows: string[][] }): unknown {
  const columns = table.headers.map((h, i) => ({
    name: `col_${i}`,
    display_name: stripMarkdown(h),
    data_type: 'text' as const,
    width: 'auto' as const,
  }));

  const rows = table.rows.map((row) => {
    const obj: Record<string, string> = {};
    table.headers.forEach((_, i) => {
      obj[`col_${i}`] = stripMarkdown(row[i] ?? '');
    });
    return obj;
  });

  return {
    tag: 'table',
    page_size: rows.length,
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

/**
 * Split Markdown text into segments: plain markdown and table elements.
 * Tables are detected and converted to Feishu card table components.
 * Returns an array of card elements (markdown or table).
 */
function splitMarkdownWithTables(text: string): unknown[] {
  const elements: unknown[] = [];

  // Match table blocks: lines starting with | that include a separator row
  const tableRegex = /(?:^|\n)((?:\|[^\n]+\|?\n)(?:\|[\s:|-]+\|?\n)(?:(?:\|[^\n]+\|?\n?)*))/g;
  let lastIndex = 0;

  for (const match of text.matchAll(tableRegex)) {
    const tableBlock = match[1];
    const matchStart = match.index! + (match[0].startsWith('\n') ? 1 : 0);

    // Add preceding text as markdown
    const before = text.slice(lastIndex, matchStart).trim();
    if (before) {
      elements.push({ tag: 'markdown', content: truncateContent(before) });
    }

    // Try to parse and convert the table
    const parsed = parseMarkdownTable(tableBlock);
    if (parsed && parsed.headers.length > 0 && parsed.rows.length > 0) {
      elements.push(buildFeishuTableElement(parsed));
    } else {
      // Fallback: keep as markdown (code block)
      elements.push({ tag: 'markdown', content: '```\n' + tableBlock.trim() + '\n```' });
    }

    lastIndex = matchStart + tableBlock.length;
  }

  // Add remaining text
  const remaining = text.slice(lastIndex).trim();
  if (remaining) {
    elements.push({ tag: 'markdown', content: truncateContent(remaining) });
  }

  return elements;
}

function truncateContent(text: string, maxLen: number = MAX_CONTENT_LENGTH): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2) - 50;
  return (
    text.slice(0, half) +
    '\n\n... (content truncated) ...\n\n' +
    text.slice(-half)
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

export function buildCard(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // Calculate elapsed time for header
  const elapsed = state.startTime ? formatElapsed(Date.now() - state.startTime) : undefined;

  // Collect all detail elements into a separate array to wrap in one top-level collapsible panel
  const detailLines: string[] = [];

  // Tool calls section — listed as plain text lines inside the detail panel
  if (state.toolCalls.length > 0) {
    for (const t of state.toolCalls) {
      const icon = t.status === 'running' ? '⏳' : '✅';
      let line = `${icon} **${t.name}** ${t.detail}`;
      if (t.status === 'done' && t.input) {
        line += `\n> Input: \`${truncateContent(t.input, 300)}\``;
      }
      if (t.status === 'done' && t.output) {
        line += `\n> Output: \`${truncateContent(t.output, 300)}\``;
      }
      detailLines.push(line);
    }
  }

  // Subagent tasks section
  if (state.subagentTasks && state.subagentTasks.length > 0) {
    if (detailLines.length > 0) detailLines.push('---');
    for (const task of state.subagentTasks) {
      const icon = task.status === 'running' ? '⏳' : task.status === 'completed' ? '✅' : '❌';
      let line = `${icon} **Agent:** ${truncateContent(task.description, 80)}`;
      if (task.summary) line += `\n> ${task.summary}`;
      if (task.usage) {
        line += `\n> Tokens: ${task.usage.total_tokens} · Tools: ${task.usage.tool_uses} · ${(task.usage.duration_ms / 1000).toFixed(1)}s`;
      }
      if (task.toolCalls && task.toolCalls.length > 0) {
        for (const t of task.toolCalls) {
          const tIcon = t.status === 'running' ? '⏳' : '✅';
          line += `\n> ${tIcon} ${t.name} ${t.detail}`;
        }
      }
      if (task.thinkingText?.trim()) {
        line += `\n> 💭 _${truncateContent(task.thinkingText.trim(), 200)}_`;
      }
      detailLines.push(line);
    }
  }

  // Tool use summaries
  if (state.toolSummaries && state.toolSummaries.length > 0) {
    if (detailLines.length > 0) detailLines.push('---');
    for (const summary of state.toolSummaries) {
      detailLines.push(`📋 ${truncateContent(summary, 500)}`);
    }
  }

  // Thinking content — only if non-empty
  if (state.thinkingText?.trim()) {
    if (detailLines.length > 0) detailLines.push('---');
    detailLines.push(`💭 _${truncateContent(state.thinkingText.trim(), 1000)}_`);
  }

  // Wrap all detail content in a single top-level collapsible panel
  if (detailLines.length > 0) {
    // Build a summary label for the panel header showing tool names
    const agentCount = state.subagentTasks?.length ?? 0;
    const labelParts: string[] = [];
    if (state.toolCalls.length > 0) {
      const uniqueNames = [...new Set(state.toolCalls.map((t) => t.name))];
      const nameStr =
        uniqueNames.length <= 5
          ? uniqueNames.join(' · ')
          : uniqueNames.slice(0, 4).join(' · ') + ` +${uniqueNames.length - 4}`;
      labelParts.push(nameStr);
    }
    if (agentCount > 0) labelParts.push(`${agentCount} agent${agentCount > 1 ? 's' : ''}`);
    if (state.thinkingText?.trim() && labelParts.length === 0) labelParts.push('thinking');
    const label = labelParts.length > 0 ? labelParts.join(' · ') : 'details';

    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: `🔧 ${label}`,
        },
      },
      border: { color: 'grey' },
      elements: [
        {
          tag: 'markdown',
          content: detailLines.join('\n\n'),
        },
      ],
    });
  }

  // Response content — convert Markdown tables to Feishu table components
  if (state.responseText) {
    elements.push(...splitMarkdownWithTables(state.responseText));
  } else if (state.status === 'thinking') {
    elements.push({
      tag: 'markdown',
      content: elapsed ? `_Claude is thinking... (${elapsed})_` : '_Claude is thinking..._',
    });
  }

  // Pending question section
  if (state.pendingQuestion) {
    elements.push({ tag: 'hr' });
    // Only display the first question — the bridge only collects one answer
    // at a time. If Claude batches multiple questions, they will be asked
    // sequentially as Claude re-asks unanswered ones.
    const questionLines: string[] = [];
    const q = state.pendingQuestion.questions[0];
    if (q) {
      questionLines.push(`**[${q.header}] ${q.question}**`);
      questionLines.push('');
      q.options.forEach((opt, i) => {
        questionLines.push(`**${i + 1}.** ${opt.label} — _${opt.description}_`);
      });
      questionLines.push(`**${q.options.length + 1}.** Other（输入自定义回答）`);
      questionLines.push('');
    }
    questionLines.push('_回复数字选择，或直接输入自定义答案_');
    elements.push({
      tag: 'markdown',
      content: questionLines.join('\n'),
    });
  }

  // Error message
  if (state.errorMessage) {
    elements.push({
      tag: 'markdown',
      content: `**Error:** ${state.errorMessage}`,
    });
  }

  // Stats note
  if (state.status === 'complete' || state.status === 'error') {
    const parts: string[] = [];
    if (state.model) {
      parts.push(state.model);
    }
    if (state.thinking) {
      parts.push(`thinking:${state.thinking}`);
    }
    if (state.effort) {
      parts.push(`effort:${state.effort}`);
    }
    if (state.durationMs !== undefined) {
      parts.push(`⏱ ${(state.durationMs / 1000).toFixed(1)}s`);
    }
    if (state.numTurns !== undefined) {
      parts.push(`🔄 ${state.numTurns} turns`);
    }
    if (state.costUsd !== undefined) {
      parts.push(`💰 $${state.costUsd.toFixed(4)}`);
    }
    if (state.workingDirectory) {
      const dir = state.workingDirectory;
      const short = dir.length > 40 ? '.../' + dir.split('/').slice(-2).join('/') : dir;
      parts.push(`📁 ${short}`);
    }
    if (state.sessionId) {
      parts.push(`🔑 ${state.sessionId.slice(0, 8)}`);

    }
    if (parts.length > 0) {
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: parts.join('  ·  '),
          },
        ],
      });
    }
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: config.color,
      title: {
        content: elapsed && (state.status === 'thinking' || state.status === 'running')
          ? `${config.icon} ${config.title} (${elapsed})`
          : `${config.icon} ${config.title}`,
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
