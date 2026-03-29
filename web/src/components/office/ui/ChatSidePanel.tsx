/* ============================================================
   ChatSidePanel — Right-side chat panel for talking to an agent
   Reuses the existing chat infrastructure (MessageList + InputBar).
   ============================================================ */

import { useRef, useCallback, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useWebSocket } from '../../../hooks/useWebSocket';
import type { CardState } from '../../../types';
import {
  MessageList,
  InputBar,
  generateId,
} from '../../chat';
import type { BotStatus } from '../../../store';
import styles from './ChatSidePanel.module.css';

interface ChatSidePanelProps {
  botName: string;
  botStatus?: BotStatus;
  onClose: () => void;
}

export function ChatSidePanel({ botName, botStatus, onClose }: ChatSidePanelProps) {
  const sessions = useStore((s) => s.sessions);
  const addMessage = useStore((s) => s.addMessage);
  const getOrCreateBotSession = useStore((s) => s.getOrCreateBotSession);
  const connected = useStore((s) => s.connected);
  const updateMessageState = useStore((s) => s.updateMessageState);

  const { send, sendBinary } = useWebSocket();
  const autoScrollRef = useRef(true);

  // Get or create a session for this bot
  const sessionId = useMemo(() => getOrCreateBotSession(botName), [botName, getOrCreateBotSession]);
  const session = sessions.get(sessionId);
  const messages = session?.messages || [];

  const isRunning = useMemo(() => {
    if (!messages.length) return false;
    const last = messages[messages.length - 1];
    return last.type === 'assistant' && (last.state?.status === 'thinking' || last.state?.status === 'running');
  }, [messages]);

  const handleSend = useCallback(
    async (text: string, files: Array<{ file: File; previewUrl?: string }>) => {
      if (!text.trim() && files.length === 0) return;

      const userMsgId = generateId();
      addMessage(sessionId, {
        id: userMsgId,
        type: 'user',
        text,
        timestamp: Date.now(),
      });

      const assistantMsgId = generateId();
      addMessage(sessionId, {
        id: assistantMsgId,
        type: 'assistant',
        text: '',
        state: { status: 'thinking', userPrompt: text, responseText: '', toolCalls: [] },
        timestamp: Date.now(),
      });

      send({
        type: 'chat',
        botName,
        chatId: sessionId,
        text,
        messageId: assistantMsgId,
      });

      autoScrollRef.current = true;
    },
    [sessionId, botName, addMessage, send],
  );

  const handleStop = useCallback(() => {
    send({ type: 'stop', chatId: sessionId });
    const sess = sessions.get(sessionId);
    if (sess) {
      const lastMsg = sess.messages[sess.messages.length - 1];
      if (lastMsg?.type === 'assistant' && (lastMsg.state?.status === 'thinking' || lastMsg.state?.status === 'running')) {
        const stoppedState: CardState = {
          ...lastMsg.state,
          status: 'error',
          errorMessage: 'Task stopped by user',
        };
        updateMessageState(sessionId, lastMsg.id, stoppedState);
      }
    }
  }, [sessionId, send, sessions, updateMessageState]);

  const handleAnswer = useCallback(
    (toolUseId: string, answer: string) => {
      send({ type: 'answer', chatId: sessionId, toolUseId, answer });
    },
    [sessionId, send],
  );

  // Status badge
  const statusColor = botStatus?.status === 'busy' ? '#ff9800' : botStatus?.status === 'error' ? '#f44336' : '#4caf50';
  const statusText = botStatus?.status || 'idle';

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <span className={styles.botIcon}>{botStatus?.icon || '\u{1F916}'}</span>
          <div className={styles.botMeta}>
            <span className={styles.botName}>{botName}</span>
            <span className={styles.statusBadge} style={{ background: statusColor }}>
              {statusText}
            </span>
          </div>
        </div>
        <button className={styles.closeBtn} onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      {botStatus?.description && (
        <div className={styles.description}>{botStatus.description}</div>
      )}

      <div className={styles.messages}>
        <MessageList
          messages={messages}
          autoScrollRef={autoScrollRef}
          isRunning={isRunning}
          onAnswer={handleAnswer}
        />
      </div>

      <div className={styles.inputArea}>
        <InputBar
          connected={connected}
          isRunning={isRunning}
          onSend={handleSend}
          onStop={handleStop}
          onStartCall={() => {}}
          callActive={false}
          send={send}
          sendBinary={sendBinary}
        />
      </div>
    </div>
  );
}
