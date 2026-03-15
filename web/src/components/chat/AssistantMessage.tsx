/* ---- Assistant Message View ---- */

import { useState, useCallback, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { CardState, ChatMessage, FileAttachment, ToolCall } from '../../types';
import { IconCheck, IconChevronDown, IconXCircle, IconTool } from './icons';
import { FileAttachmentCard } from './FileAttachmentCard';
import { CodeBlock } from './CodeBlock';
import styles from '../ChatView.module.css';

/* ---- Tool Calls display ---- */

function ToolCallsSection({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);
  const running = toolCalls.filter((t) => t.status === 'running').length;
  const done = toolCalls.filter((t) => t.status === 'done').length;

  if (toolCalls.length === 0) return null;

  return (
    <div className={styles.toolCalls}>
      <div className={styles.toolCallsHeader} onClick={() => setExpanded(!expanded)}>
        <span className={styles.toolCallIcon}><IconTool /></span>
        <span>
          {running > 0
            ? `Running ${toolCalls[toolCalls.length - 1]?.name}...`
            : `${done} tool${done !== 1 ? 's' : ''} used`}
        </span>
        <span className={`${styles.toolCallsChevron} ${expanded ? styles.toolCallsChevronOpen : ''}`}>
          <IconChevronDown />
        </span>
      </div>
      {expanded && (
        <div className={styles.toolCallsList}>
          {toolCalls.map((tool, i) => (
            <div key={i} className={styles.toolCallItem}>
              <span className={styles.toolCallIcon}>
                {tool.status === 'running' ? (
                  <span className={styles.toolCallSpinner} />
                ) : (
                  <span className={styles.toolCallCheck}><IconCheck /></span>
                )}
              </span>
              <span className={styles.toolCallName}>{tool.name}</span>
              <span className={styles.toolCallDetail}>{tool.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Status bar ---- */

function StatusIndicator({ status }: { status: CardState['status'] }) {
  if (status === 'thinking' || status === 'running') {
    return (
      <div className={styles.statusAnim}>
        <div className={styles.statusDots}>
          <span className={styles.statusDot} />
          <span className={styles.statusDot} />
          <span className={styles.statusDot} />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.statusBar}>
        <span className={`${styles.statusIcon} ${styles.statusError}`}><IconXCircle /></span>
        <span className={`${styles.statusLabel} ${styles.statusError}`}>ERROR</span>
      </div>
    );
  }

  return null;
}

/* ---- Pending Question ---- */

function PendingQuestionUI({
  question,
  onAnswer,
}: {
  question: NonNullable<CardState['pendingQuestion']>;
  onAnswer: (toolUseId: string, answer: string) => void;
}) {
  return (
    <div className={styles.pendingQuestion}>
      {question.questions.map((q, qi) => (
        <div key={qi}>
          <div className={styles.pendingQuestionHeader}>{q.header}</div>
          <div className={styles.pendingQuestionText}>{q.question}</div>
          <div className={styles.pendingOptions}>
            {q.options.map((opt, oi) => (
              <button
                key={oi}
                className={styles.optionBtn}
                onClick={() => onAnswer(question.toolUseId, opt.label)}
              >
                {opt.label}
                {opt.description && <span className={styles.optionBtnDesc}>{opt.description}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Main assistant message component ---- */

interface AssistantMessageProps {
  msg: ChatMessage;
  onAnswer: (toolUseId: string, answer: string) => void;
  onPreview?: (f: FileAttachment) => void;
}

export function AssistantMessageView({ msg, onAnswer, onPreview }: AssistantMessageProps) {
  const state = msg.state;
  if (!state) return <div className={styles.assistantMessage}>{msg.text}</div>;

  const markdownComponents = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code(props: any) {
      const { children, className, node: _node, ...rest } = props;
      const match = /language-(\w+)/.exec(className || '');
      const isBlock =
        typeof children === 'string' && children.includes('\n');
      if (isBlock || match) {
        return (
          <CodeBlock language={match?.[1] || ''}>
            {String(children).replace(/\n$/, '')}
          </CodeBlock>
        );
      }
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    },
  };

  return (
    <div className={styles.assistantMessage}>
      {msg.botName && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-text)', marginBottom: 6, letterSpacing: '0.3px' }}>
          @{msg.botName}
        </div>
      )}
      <StatusIndicator status={state.status} />
      <ToolCallsSection toolCalls={state.toolCalls} />
      {state.responseText && (
        <div className={styles.responseContent}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents as unknown as Record<string, () => ReactNode>}
          >
            {state.responseText}
          </ReactMarkdown>
        </div>
      )}
      {state.errorMessage && (
        <div className={styles.errorBlock}>{state.errorMessage}</div>
      )}
      {state.pendingQuestion && (
        <PendingQuestionUI question={state.pendingQuestion} onAnswer={onAnswer} />
      )}
      {state.status === 'complete' && (state.costUsd || state.durationMs) && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 10, fontFamily: 'var(--font-mono)' }}>
          {state.costUsd ? `$${state.costUsd.toFixed(4)}` : ''}
          {state.costUsd && state.durationMs ? ' · ' : ''}
          {state.durationMs ? `${(state.durationMs / 1000).toFixed(1)}s` : ''}
        </div>
      )}
      {/* Output file attachments */}
      {msg.attachments && msg.attachments.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {msg.attachments.map((file, fi) => (
            <FileAttachmentCard key={fi} file={file} compact onPreview={onPreview} />
          ))}
        </div>
      )}
    </div>
  );
}
