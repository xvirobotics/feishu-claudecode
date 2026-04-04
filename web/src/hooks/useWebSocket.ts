/* ============================================================
   MetaBot Web — WebSocket Hook
   ============================================================ */

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { WSIncomingMessage, WSOutgoingMessage } from '../types';
import { notifyTaskComplete } from '../utils/notifications';

const HEARTBEAT_INTERVAL = 25_000;
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30_000;

/** Maps server session UUID → local chatId for session_history response mapping. */
const serverSessionIdMap = new Map<string, string>();

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
  const setIncomingVoiceCall = useStore((s) => s.setIncomingVoiceCall);
  const addActivityEvent = useStore((s) => s.addActivityEvent);
  const mergeServerSessions = useStore((s) => s.mergeServerSessions);
  const loadServerHistory = useStore((s) => s.loadServerHistory);
  const setAsrState = useStore((s) => s.setAsrState);
  const setAsrPartialText = useStore((s) => s.setAsrPartialText);

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

      // Subscribe to grouptalk chatIds for existing group sessions
      const store = useStore.getState();
      for (const session of store.sessions.values()) {
        if (session.groupId) {
          ws.send(JSON.stringify({ type: 'subscribe_group', groupId: session.groupId, chatId: session.id }));
        }
      }

      // Start heartbeat
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      // Binary frames are not expected from server (all ASR results come as JSON)
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as WSIncomingMessage;
        switch (msg.type) {
          case 'connected':
            setBots(msg.bots);
            // Request server-side sessions for each bot to restore history
            for (const bot of msg.bots) {
              ws.send(JSON.stringify({ type: 'list_sessions', botName: bot.name }));
            }
            break;

          case 'bots_updated':
            setBots(msg.bots);
            break;

          case 'state':
          case 'complete': {
            if (msg.groupId) {
              // Inter-bot message in a group chat — find the session by groupId
              const store = useStore.getState();
              const groupSession = Array.from(store.sessions.values()).find(
                (s) => s.groupId === msg.groupId,
              );
              if (groupSession) {
                const existingMsg = groupSession.messages.find((m) => m.id === msg.messageId);
                if (!existingMsg) {
                  // Create a new assistant message for this inter-bot response
                  addMessage(groupSession.id, {
                    id: msg.messageId,
                    type: 'assistant',
                    text: '',
                    state: msg.state,
                    timestamp: Date.now(),
                    botName: msg.botName,
                  });
                } else {
                  updateMessageState(groupSession.id, msg.messageId, msg.state, msg.botName);
                }
              }
            } else {
              updateMessageState(msg.chatId, msg.messageId, msg.state, msg.botName);
            }
            // Desktop notification when task completes while tab is unfocused
            if (msg.type === 'complete' && msg.state.status === 'complete') {
              notifyTaskComplete(msg.botName || 'MetaBot', msg.state.responseText?.slice(0, 100));
            }
            break;
          }

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

          case 'sessions_list': {
            mergeServerSessions(msg.sessions);
            // For restored sessions with no local messages, fetch history
            const curSessions = useStore.getState().sessions;
            for (const ss of msg.sessions) {
              const local = curSessions.get(ss.chatId);
              if (local && local.messages.length === 0) {
                ws.send(JSON.stringify({ type: 'get_session_history', sessionId: ss.id }));
                serverSessionIdMap.set(ss.id, ss.chatId);
              }
            }
            break;
          }

          case 'session_history': {
            const histChatId = serverSessionIdMap.get(msg.sessionId) || msg.sessionId;
            loadServerHistory(histChatId, msg.messages);
            serverSessionIdMap.delete(msg.sessionId);
            break;
          }

          case 'voice_call':
            setIncomingVoiceCall({
              sessionId: msg.sessionId,
              roomId: msg.roomId,
              token: msg.token,
              appId: msg.appId,
              userId: msg.userId,
              aiUserId: msg.aiUserId,
              chatId: msg.chatId,
              botName: msg.botName,
              prompt: msg.prompt,
            });
            break;

          case 'activity_event':
            addActivityEvent(msg.event);
            break;

          // ── Streaming ASR events ──
          case 'asr_started':
            setAsrState('active');
            break;

          case 'asr_transcript':
            setAsrPartialText(msg.text);
            break;

          case 'asr_error':
            setAsrState('error');
            console.error('Streaming ASR error:', msg.error);
            break;

          case 'asr_stopped':
            setAsrState('idle');
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
  }, [token, cleanup, setConnected, setBots, updateMessageState, addMessage, addMessageAttachment, markRunningMessagesDisconnected, addGroup, removeGroup, setGroups, setIncomingVoiceCall, addActivityEvent, mergeServerSessions, loadServerHistory, setAsrState, setAsrPartialText]);

  const send = useCallback(
    (msg: WSOutgoingMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    },
    [],
  );

  /** Send raw binary data (e.g. PCM audio for streaming ASR) */
  const sendBinary = useCallback(
    (data: ArrayBuffer | Uint8Array) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
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

  return { send, sendBinary, reconnect };
}
