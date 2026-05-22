/* ============================================================
   manager/LogPanel.tsx — WS log tail with auto-scroll.

   - Connects to /api/manager/bots/:name/logs?stream=out|error&tail=200
   - Appends each message as a line.
   - Auto-scrolls to bottom unless user has scrolled up — in that case
     a sticky "Pause: click to resume" banner shows; clicking resumes.
   - Reconnects on close with 2s backoff.
============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildLogWsUrl } from './api';
import styles from './manager.module.css';

interface LogPanelProps {
  botName: string;
}

type Stream = 'out' | 'error';
type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

const MAX_LINES = 2000;

export function LogPanel({ botName }: LogPanelProps) {
  const [stream, setStream] = useState<Stream>('out');
  const [lines,  setLines]  = useState<string[]>([]);
  const [state,  setState]  = useState<ConnState>('connecting');
  const [paused, setPaused] = useState(false);

  const bodyRef       = useRef<HTMLPreElement | null>(null);
  const wsRef         = useRef<WebSocket | null>(null);
  const reconnectRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef    = useRef(true);
  const pausedRef     = useRef(paused);
  pausedRef.current   = paused;

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    // 40px buffer: tiny rubber-band scrolls don't count as "scrolled up"
    const nearBottom = distance < 40;
    setPaused(!nearBottom);
  }, []);

  // (Re)connect when stream changes or bot changes
  useEffect(() => {
    mountedRef.current = true;
    setLines([]);
    setPaused(false);

    const url = buildLogWsUrl(botName, stream, 200);
    let attempts = 0;

    const connect = () => {
      if (!mountedRef.current) return;
      setState((s) => (attempts === 0 ? 'connecting' : s));
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        attempts = 0;
        setState('connected');
      };

      ws.onmessage = (evt) => {
        if (!mountedRef.current) return;
        const text =
          typeof evt.data === 'string'
            ? evt.data
            : evt.data instanceof Blob
            ? '' // ignored; server is text-only
            : String(evt.data);
        if (!text) return;
        // Server should send one logical line per message — but be defensive
        const incoming = text.split('\n');
        setLines((prev) => {
          const next = prev.concat(incoming);
          if (next.length > MAX_LINES) {
            return next.slice(next.length - MAX_LINES);
          }
          return next;
        });
      };

      ws.onerror = () => {
        // onclose will trigger reconnect — keep this silent to avoid double work
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        wsRef.current = null;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (!mountedRef.current) return;
      attempts += 1;
      setState('reconnecting');
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(connect, 2000);
    };

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
        wsRef.current = null;
      }
      setState('closed');
    };
  }, [botName, stream]);

  // Auto-scroll on new lines (unless user paused)
  useEffect(() => {
    if (!pausedRef.current) scrollToBottom();
  }, [lines, scrollToBottom]);

  return (
    <div className={styles.logPanel}>
      <div className={styles.logHeader}>
        <span>日志</span>
        <div className={styles.logStreamToggle}>
          <button
            type="button"
            className={styles.logToggleBtn + ' ' + (stream === 'out' ? styles.logToggleActive : '')}
            onClick={() => setStream('out')}
          >
            stdout
          </button>
          <button
            type="button"
            className={styles.logToggleBtn + ' ' + (stream === 'error' ? styles.logToggleActive : '')}
            onClick={() => setStream('error')}
          >
            stderr
          </button>
        </div>
        <span className={
          styles.logStatus + ' ' + (
            state === 'connected'      ? styles.logStatusConnected :
            state === 'reconnecting'   ? styles.logStatusReconnecting :
            styles.logStatusClosed
          )
        }>
          {state === 'connecting' && '正在连接…'}
          {state === 'connected' && '● 已连接'}
          {state === 'reconnecting' && '○ 重连中…'}
          {state === 'closed' && '已断开'}
        </span>
      </div>

      <pre
        ref={bodyRef}
        className={styles.logBody}
        onScroll={handleScroll}
        aria-live="polite"
      >
        {lines.length === 0 ? '（暂无日志）' : lines.join('\n')}
        {paused && (
          <button
            type="button"
            className={styles.logPauseBanner}
            onClick={() => {
              setPaused(false);
              scrollToBottom();
            }}
          >
            已暂停自动滚动 · 点击恢复
          </button>
        )}
      </pre>
    </div>
  );
}
