import { useRef, useCallback, useMemo } from 'react';
import { useStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { CardState } from '../../types';
import { MessageList, InputBar, generateId } from '../chat';
import s from './TeamChatPanel.module.css';

interface TeamChatPanelProps {
  botName: string;
  onClose: () => void;
}

export function TeamChatPanel({ botName, onClose }: TeamChatPanelProps) {
  const sessions = useStore((st) => st.sessions);
  const addMessage = useStore((st) => st.addMessage);
  const getOrCreateBotSession = useStore((st) => st.getOrCreateBotSession);
  const connected = useStore((st) => st.connected);
  const updateMessageState = useStore((st) => st.updateMessageState);

  const { send, sendBinary } = useWebSocket();
  const autoScrollRef = useRef(true);

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
      addMessage(sessionId, { id: userMsgId, type: 'user', text, timestamp: Date.now() });

      const assistantMsgId = generateId();
      addMessage(sessionId, {
        id: assistantMsgId,
        type: 'assistant',
        text: '',
        state: { status: 'thinking', userPrompt: text, responseText: '', toolCalls: [] },
        timestamp: Date.now(),
      });

      send({ type: 'chat', botName, chatId: sessionId, text, messageId: assistantMsgId });
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
        const stoppedState: CardState = { ...lastMsg.state, status: 'error', errorMessage: 'Task stopped by user' };
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

  return (
    <div className={s.panel}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <span className={s.headerLabel}>Chat with</span>
          <span className={s.headerBot}>{botName}</span>
        </div>
        <button className={s.closeBtn} onClick={onClose} title="Close chat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className={s.messages}>
        <MessageList
          messages={messages}
          autoScrollRef={autoScrollRef}
          isRunning={isRunning}
          onAnswer={handleAnswer}
        />
      </div>

      <div className={s.inputArea}>
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
