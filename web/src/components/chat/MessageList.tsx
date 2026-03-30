/* ---- Message List ---- */

import { useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, FileAttachment } from '../../types';
import { AssistantMessageView } from './AssistantMessage';
import { FileAttachmentCard } from './FileAttachmentCard';
import styles from '../ChatView.module.css';

interface MessageListProps {
  messages: ChatMessage[];
  onAnswer: (toolUseId: string, answer: string) => void;
  onPreview: (f: FileAttachment) => void;
  autoScrollRef: React.MutableRefObject<boolean>;
}

export function MessageList({ messages, onAnswer, onPreview, autoScrollRef }: MessageListProps) {
  const messageListRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (!autoScrollRef.current || !messageListRef.current) return;
    const el = messageListRef.current;
    el.scrollTop = el.scrollHeight;
  }, [messages, autoScrollRef]);

  // Detect manual scroll
  const handleScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    autoScrollRef.current = isAtBottom;
  }, [autoScrollRef]);

  return (
    <div
      className={styles.messageList}
      ref={messageListRef}
      onScroll={handleScroll}
    >
      <div className={styles.messageListInner}>
        {messages.map((msg, i) => (
          <div
            key={msg.id}
            className={`${styles.messageRow} ${
              msg.type === 'user'
                ? styles.messageRowUser
                : msg.type === 'system'
                  ? styles.messageRowSystem
                  : styles.messageRowAssistant
            }`}
            style={{ animationDelay: `${Math.min(i * 50, 300)}ms` }}
          >
            {msg.type === 'user' && (
              <div className={styles.userBubbleWrap}>
                {msg.senderName && (
                  <div className={styles.senderLabel} style={msg.senderColor ? { color: msg.senderColor } : undefined}>
                    {msg.senderName}
                  </div>
                )}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className={styles.attachGrid}>
                    {msg.attachments.map((file, fi) => (
                      <FileAttachmentCard key={fi} file={file} onPreview={onPreview} />
                    ))}
                  </div>
                )}
                {msg.text && <div className={styles.userBubble}>{msg.text}</div>}
              </div>
            )}
            {msg.type === 'system' && (
              <div className={styles.systemBubble}>{msg.text}</div>
            )}
            {msg.type === 'assistant' && (
              <AssistantMessageView msg={msg} onAnswer={onAnswer} onPreview={onPreview} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
