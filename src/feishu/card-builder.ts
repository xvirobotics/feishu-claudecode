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

  // Tool calls section — each completed tool in a collapsible panel, running tool as plain text
  if (state.toolCalls.length > 0) {
    for (const t of state.toolCalls) {
      const icon = t.status === 'running' ? '⏳' : '✅';
      if (t.status === 'done' && (t.input || t.output)) {
        // Completed tool with details — collapsible panel
        const bodyParts: string[] = [];
        if (t.input) {
          bodyParts.push(`**Input:**\n\`\`\`\n${truncateContent(t.input, 2000)}\n\`\`\``);
        }
        if (t.output) {
          bodyParts.push(`**Output:**\n\`\`\`\n${truncateContent(t.output, 2000)}\n\`\`\``);
        }
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: {
              tag: 'plain_text',
              content: `${icon} ${t.name} ${t.detail}`,
            },
          },
          border: { color: 'grey' },
          body: [
            {
              tag: 'markdown',
              content: bodyParts.join('\n'),
            },
          ],
        });
      } else {
        // Running tool or no details — plain text line
        elements.push({
          tag: 'markdown',
          content: `${icon} **${t.name}** ${t.detail}`,
        });
      }
    }
    elements.push({ tag: 'hr' });
  }

  // Subagent tasks section
  if (state.subagentTasks && state.subagentTasks.length > 0) {
    for (const task of state.subagentTasks) {
      const icon = task.status === 'running' ? '⏳' : task.status === 'completed' ? '✅' : '❌';
      const bodyParts: string[] = [];
      if (task.description) bodyParts.push(task.description);
      if (task.summary) bodyParts.push(`**Summary:** ${task.summary}`);
      if (task.usage) {
        bodyParts.push(`Tokens: ${task.usage.total_tokens} · Tools: ${task.usage.tool_uses} · ${(task.usage.duration_ms / 1000).toFixed(1)}s`);
      }
      // Subagent tool calls
      if (task.toolCalls && task.toolCalls.length > 0) {
        if (bodyParts.length > 0) bodyParts.push('');
        for (const t of task.toolCalls) {
          const tIcon = t.status === 'running' ? '⏳' : '✅';
          bodyParts.push(`${tIcon} **${t.name}** ${t.detail}`);
        }
      }
      // Subagent thinking
      if (task.thinkingText?.trim()) {
        if (bodyParts.length > 0) bodyParts.push('');
        bodyParts.push(`💭 _${truncateContent(task.thinkingText.trim(), 500)}_`);
      }
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'plain_text',
            content: `${icon} Agent: ${truncateContent(task.description, 60)}`,
          },
        },
        border: { color: task.status === 'running' ? 'blue' : 'grey' },
        body: [
          {
            tag: 'markdown',
            content: bodyParts.join('\n'),
          },
        ],
      });
    }
  }

  // Tool use summaries
  if (state.toolSummaries && state.toolSummaries.length > 0) {
    for (const summary of state.toolSummaries) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'plain_text',
            content: '📋 Tool Summary',
          },
        },
        border: { color: 'grey' },
        body: [
          {
            tag: 'markdown',
            content: truncateContent(summary),
          },
        ],
      });
    }
  }

  // Thinking content (collapsible) — only if non-empty
  if (state.thinkingText?.trim()) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: '💭 Thinking',
        },
      },
      border: { color: 'grey' },
      body: [
        {
          tag: 'markdown',
          content: truncateContent(state.thinkingText),
        },
      ],
    });
  }

  // Response content
  if (state.responseText) {
    elements.push({
      tag: 'markdown',
      content: truncateContent(state.responseText),
    });
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
