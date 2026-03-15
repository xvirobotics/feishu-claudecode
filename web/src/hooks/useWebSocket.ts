/* ============================================================
   MetaBot Web — WebSocket Hook
   ============================================================ */

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { WSIncomingMessage, WSOutgoingMessage } from '../types';

const HEARTBEAT_INTERVAL = 25_000;
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30_000;

export function useWebSocket() {
  const token = useStore((s) => s.token);
  const setConnected = useStore((s) => s.setConnected);
  const setBots = useStore((s) => s.setBots);
  const updateMessageState = useStore((s) => s.updateMessageState);
  const addMessage = useStore((s) => s.addMessage);
  const addMessageAttachment = useStore((s) => s.addMessageAttachment);
  const markRunningMessagesDisconnected = useStore((s) => s.markRunningMessagesDisconnected);
  const addGroup = useStore((s) => s.addGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const setGroups = useStore((s) => s.setGroups);

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);

  const cleanup = useCallback(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!token || !mountedRef.current) return;
    cleanup();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      reconnectAttempt.current = 0;
      setConnected(true);

      // Request group list
      ws.send(JSON.stringify({ type: 'list_groups' }));

      // Start heartbeat
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data) as WSIncomingMessage;
        switch (msg.type) {
          case 'connected':
            setBots(msg.bots);
            break;

          case 'bots_updated':
            setBots(msg.bots);
            break;

          case 'state':
            updateMessageState(msg.chatId, msg.messageId, msg.state, msg.botName);
            break;

          case 'complete':
            updateMessageState(msg.chatId, msg.messageId, msg.state, msg.botName);
            break;

          case 'error': {
            // Find the session for this chatId and update the message
            const store = useStore.getState();
            const session = Array.from(store.sessions.values()).find(
              (s) => s.id === msg.chatId,
            );
            if (session) {
              const assistantMsg = session.messages.find(
                (m) => m.id === msg.messageId,
              );
              if (assistantMsg) {
                updateMessageState(msg.chatId, msg.messageId, {
                  ...(assistantMsg.state || {
                    status: 'error',
                    userPrompt: '',
                    responseText: '',
                    toolCalls: [],
                  }),
                  status: 'error',
                  errorMessage: msg.error,
                });
              }
            }
            break;
          }

          case 'file': {
            // Attach output file to the latest assistant message in this chat
            const store2 = useStore.getState();
            const fileSession = store2.sessions.get(msg.chatId);
            if (fileSession) {
              // Find the last assistant message
              const lastAssistant = [...fileSession.messages].reverse().find((m) => m.type === 'assistant');
              if (lastAssistant) {
                addMessageAttachment(msg.chatId, lastAssistant.id, {
                  name: msg.name,
                  type: msg.mimeType,
                  size: msg.size || 0,
                  url: msg.url,
                  path: '',
                });
              }
            }
            break;
          }

          case 'notice': {
            const store = useStore.getState();
            const targetSession = msg.chatId || store.activeSessionId;
            const noticeText = msg.text || msg.content || msg.title || '';
            if (targetSession && noticeText) {
              addMessage(targetSession, {
                id: `notice-${Date.now()}`,
                type: 'system',
                text: noticeText,
                timestamp: Date.now(),
              });
            }
            break;
          }

          case 'group_created':
            addGroup(msg.group);
            break;

          case 'group_deleted':
            removeGroup(msg.groupId);
            break;

          case 'groups_list':
            setGroups(msg.groups);
            break;

          case 'pong':
            // heartbeat ack — nothing to do
            break;
        }
      } catch {
        // malformed message
      }
    };

    ws.onerror = () => {
      // Will trigger onclose
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      markRunningMessagesDisconnected();
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);

      // Reconnect with exponential backoff
      const delay = Math.min(
        RECONNECT_BASE * Math.pow(2, reconnectAttempt.current),
        RECONNECT_MAX,
      );
      reconnectAttempt.current++;
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };
  }, [token, cleanup, setConnected, setBots, updateMessageState, addMessage, addMessageAttachment, markRunningMessagesDisconnected, addGroup, removeGroup, setGroups]);

  const send = useCallback(
    (msg: WSOutgoingMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    },
    [],
  );

  const reconnect = useCallback(() => {
    reconnectAttempt.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    if (token) connect();
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [token, connect, cleanup]);

  return { send, reconnect };
}
