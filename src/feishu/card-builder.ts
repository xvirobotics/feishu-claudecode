// Re-export shared types so existing imports from this module continue to work
export type { CardStatus, ToolCall, PendingQuestion, CardState } from '../types.js';
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
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining}s`;
}

export function buildCard(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // Calculate elapsed time for header
  let headerTitle = `${config.icon} ${config.title}`;
  if (state.startTime && (state.status === 'thinking' || state.status === 'running')) {
    const elapsed = formatElapsed(Date.now() - state.startTime);
    headerTitle = `${config.icon} ${config.title} (${elapsed})`;
  }

  // Build detail content (tool calls, subagent tasks, summaries, thinking)
  const detailLines: string[] = [];

  // Tool calls
  for (const t of state.toolCalls) {
    const icon = t.status === 'running' ? '⏳' : '✅';
    let line = `${icon} **${t.name}** ${t.detail}`;
    if (t.status === 'done') {
      if (t.input?.trim()) {
        line += `\n> Input: \`${truncateContent(t.input, 200)}\``;
      }
      if (t.output?.trim()) {
        line += `\n> Output: \`${truncateContent(t.output, 200)}\``;
      }
    }
    detailLines.push(line);
  }

  // Subagent tasks
  if (state.subagentTasks && state.subagentTasks.length > 0) {
    if (detailLines.length > 0) detailLines.push('---');
    for (const task of state.subagentTasks) {
      const icon = task.status === 'running' ? '⏳' : task.status === 'completed' ? '✅' : '❌';
      let line = `${icon} **Agent:** ${task.description}`;
      if (task.summary) {
        line += `\n> ${truncateContent(task.summary, 300)}`;
      }
      if (task.usage) {
        const usageParts: string[] = [];
        if (task.usage.total_tokens) usageParts.push(`${task.usage.total_tokens} tokens`);
        if (task.usage.tool_uses) usageParts.push(`${task.usage.tool_uses} tools`);
        if (task.usage.duration_ms) usageParts.push(`${(task.usage.duration_ms / 1000).toFixed(1)}s`);
        if (usageParts.length) line += `\n> ${usageParts.join(' · ')}`;
      }
      if (task.toolCalls && task.toolCalls.length > 0) {
        const toolNames = task.toolCalls.map(t => t.name).join(', ');
        line += `\n> Tools: ${toolNames}`;
      }
      if (task.thinkingText?.trim()) {
        line += `\n> 💭 _${truncateContent(task.thinkingText, 200)}_`;
      }
      detailLines.push(line);
    }
  }

  // Tool summaries
  if (state.toolSummaries && state.toolSummaries.length > 0) {
    if (detailLines.length > 0) detailLines.push('---');
    for (const summary of state.toolSummaries) {
      detailLines.push(`📋 ${summary}`);
    }
  }

  // Thinking content
  if (state.thinkingText?.trim()) {
    if (detailLines.length > 0) detailLines.push('---');
    detailLines.push(`💭 _${truncateContent(state.thinkingText, 500)}_`);
  }

  // Wrap all details in a single collapsible panel
  if (detailLines.length > 0) {
    // Smart header: show unique tool names
    const uniqueTools = [...new Set(state.toolCalls.map(t => t.name))];
    const agentCount = state.subagentTasks?.length ?? 0;
    const headerParts: string[] = [];
    if (uniqueTools.length > 0) {
      if (uniqueTools.length <= 5) {
        headerParts.push(uniqueTools.join(' · '));
      } else {
        headerParts.push(uniqueTools.slice(0, 5).join(' · ') + ` +${uniqueTools.length - 5}`);
      }
    }
    if (agentCount > 0) {
      headerParts.push(`${agentCount} agent${agentCount > 1 ? 's' : ''}`);
    }
    if (headerParts.length === 0) {
      if (state.thinkingText?.trim()) headerParts.push('thinking');
      else headerParts.push('details');
    }
    const panelHeader = `🔧 ${headerParts.join(' · ')}`;

    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: panelHeader,
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: truncateContent(detailLines.join('\n\n')),
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
    let thinkingMsg = '_Claude is thinking..._';
    if (state.startTime) {
      const elapsed = formatElapsed(Date.now() - state.startTime);
      thinkingMsg = `_Claude is thinking... (${elapsed})_`;
    }
    elements.push({
      tag: 'markdown',
      content: thinkingMsg,
    });
  }

  // Pending question section
  if (state.pendingQuestion) {
    elements.push({ tag: 'hr' });
    const questionLines: string[] = [];
    for (const q of state.pendingQuestion.questions) {
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
      const dir = state.workingDirectory.length > 40
        ? '.../' + state.workingDirectory.split('/').slice(-2).join('/')
        : state.workingDirectory;
      parts.push(`📁 ${dir}`);
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
            content: parts.join(' · '),
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
        content: headerTitle,
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
