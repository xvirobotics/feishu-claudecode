/* ============================================================
   TranscriptView — public-facing conversation history page.

   - Route: /transcript/:chatId            (basename `/web`)
   - Query: ?turn=<N>  (1-based)  or  ?turn=all  (default)
   - Auth:  HttpOnly cookie via Feishu OAuth.
            401 → 跳到 /api/auth/feishu/login?return=...
            403 → 渲染 "无权访问 + 您的 open_id" 提示页
   - 复用：把后端 TranscriptMessage 折成 web/ChatMessage，
           直接喂给 <MessageList>，工具调用/text/思考三种 block
           都会被 <AssistantMessageView> 渲染出来。

   不参与全局 LoginPage / WebSocket / Layout —— 详情页是独立入口。
============================================================ */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { MessageList } from './chat/MessageList';
import type { ChatMessage, ToolCall } from '../types';
import styles from './TranscriptView.module.css';

/* ── 后端返回的形状（与 src/session/transcript-reader.ts 对齐） ── */

interface TranscriptToolCall {
  id:      string;
  name:    string;
  input:   unknown;
  result?: { content: unknown; isError?: boolean };
  status:  'done';
}

interface TranscriptMessage {
  id:         string;
  role:       'user' | 'assistant';
  text?:      string;
  toolCalls?: TranscriptToolCall[];
  thinking?:  string;
  timestamp:  string;
}

interface TranscriptResponse {
  chat: {
    chatId:     string;
    totalTurns: number;
    title?:     string;
    botName?:   string;
    platform?:  string;
  };
  turn:     number | 'all';
  messages: TranscriptMessage[];
}

interface UnauthorizedResponse {
  error:     string;
  loginUrl?: string;
}

/* ── 把工具调用的 input 折成一行 "detail" 给 <AssistantMessageView> ── */

function flattenToolDetail(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    const s = JSON.stringify(input);
    // 单行展示，过长截断 —— 详细内容用户可以在浏览器开发者工具/网络面板里
    // 看到原始 jsonl；详情页不展开 input 全文以免噪声压垮可读性。
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(input);
  }
}

function flattenToolResult(result: TranscriptToolCall['result']): string {
  if (!result) return '';
  const { content, isError } = result;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Anthropic content blocks: [{type:'text', text:'...'}, ...]
    text = content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text ?? '') : ''
      )
      .filter(Boolean)
      .join('\n');
  } else {
    try { text = JSON.stringify(content); } catch { text = String(content); }
  }
  const prefix = isError ? '❌ ' : '✓ ';
  return prefix + (text.length > 240 ? `${text.slice(0, 240)}…` : text);
}

/* ── 后端 TranscriptMessage[] → web ChatMessage[] ── */

function toChatMessages(msgs: TranscriptMessage[]): ChatMessage[] {
  return msgs.map((m): ChatMessage => {
    const tsMs = m.timestamp ? Date.parse(m.timestamp) : NaN;
    const timestamp = Number.isFinite(tsMs) ? tsMs : Date.now();

    if (m.role === 'user') {
      return { id: m.id, type: 'user', text: m.text ?? '', timestamp };
    }

    // assistant
    const toolCalls: ToolCall[] = (m.toolCalls ?? []).map((tc) => {
      const inputDetail  = flattenToolDetail(tc.input);
      const resultDetail = flattenToolResult(tc.result);
      const detail = resultDetail ? `${inputDetail}\n${resultDetail}` : inputDetail;
      return { name: tc.name, detail, status: 'done' };
    });

    const text = m.text ?? '';
    const thinking = m.thinking ? `> 💭 ${m.thinking}\n\n` : '';

    return {
      id:        m.id,
      type:      'assistant',
      text,
      timestamp,
      state: {
        status:       'complete',
        userPrompt:   '',
        responseText: thinking + text,
        toolCalls,
      },
    };
  });
}

/* ── 顶部 turn 切换条 ── */

interface TurnSwitcherProps {
  totalTurns:  number;
  currentTurn: number | 'all';
  onSelect:    (turn: number | 'all') => void;
}

function TurnSwitcher({ totalTurns, currentTurn, onSelect }: TurnSwitcherProps) {
  if (totalTurns <= 1) return null;
  const items: Array<number | 'all'> = ['all', ...Array.from({ length: totalTurns }, (_, i) => i + 1)];
  return (
    <div className={styles.turnSwitcher}>
      <span className={styles.turnSwitcherLabel}>Turn:</span>
      {items.map((t) => (
        <button
          key={String(t)}
          className={`${styles.turnPill} ${currentTurn === t ? styles.turnPillActive : ''}`}
          onClick={() => onSelect(t)}
        >
          {t === 'all' ? '全部' : `#${t}`}
        </button>
      ))}
    </div>
  );
}

/* ── 主组件 ── */

export function TranscriptView() {
  const { chatId } = useParams<{ chatId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const turnParam = searchParams.get('turn');
  const currentTurn: number | 'all' = useMemo(() => {
    if (!turnParam || turnParam === 'all') return 'all';
    const n = parseInt(turnParam, 10);
    return Number.isFinite(n) && n > 0 ? n : 'all';
  }, [turnParam]);

  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<
    | { kind: 'forbidden';   message: string; openId?: string }
    | { kind: 'notFound' }
    | { kind: 'server';      message: string }
    | null
  >(null);

  const autoScrollRef = useRef(false);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    setLoading(true);
    setErrorState(null);
    setData(null);

    const turnQs = currentTurn === 'all' ? 'all' : String(currentTurn);
    fetch(`/api/transcript/${encodeURIComponent(chatId)}?turn=${turnQs}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          // Not logged in — 跳 OAuth。loginUrl 来自后端，已经把 returnUrl 编进去。
          const body = (await res.json().catch(() => null)) as UnauthorizedResponse | null;
          const loginUrl =
            body?.loginUrl ||
            `/api/auth/feishu/login?return=${encodeURIComponent(window.location.pathname + window.location.search)}`;
          window.location.replace(loginUrl);
          return;
        }
        if (res.status === 403) {
          // 鉴权通过但 open_id 不在白名单。
          // 后端目前只返回 `{ error: 'forbidden' }`；open_id 用户从 cookie 看不到，
          // 后续版本要在 403 里带上 open_id 让用户复制给管理员（见 plan: 白名单 bootstrap）。
          setErrorState({
            kind:    'forbidden',
            message: '您已通过飞书登录，但您的 open_id 不在该 bot 的白名单中。请联系管理员把您的 open_id 加入 `transcriptAllowOpenIds`。',
          });
          setLoading(false);
          return;
        }
        if (res.status === 404) {
          setErrorState({ kind: 'notFound' });
          setLoading(false);
          return;
        }
        if (!res.ok) {
          const body = (await res.text().catch(() => '')) || `HTTP ${res.status}`;
          setErrorState({ kind: 'server', message: body });
          setLoading(false);
          return;
        }
        const json = (await res.json()) as TranscriptResponse;
        if (cancelled) return;
        setData(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorState({ kind: 'server', message: (err as Error).message || 'network error' });
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [chatId, currentTurn]);

  const messages: ChatMessage[] = useMemo(
    () => (data ? toChatMessages(data.messages) : []),
    [data]
  );

  const handleSelectTurn = (turn: number | 'all') => {
    const next = new URLSearchParams(searchParams);
    if (turn === 'all') next.delete('turn'); else next.set('turn', String(turn));
    setSearchParams(next, { replace: false });
  };

  /* ── render ── */

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.statusBlock}>正在加载对话历史…</div>
      </div>
    );
  }

  if (errorState?.kind === 'forbidden') {
    return (
      <div className={styles.page}>
        <div className={styles.errorBlock}>
          <h2>🔒 无权访问</h2>
          <p>{errorState.message}</p>
          <p className={styles.dim}>
            如果你是管理员：在 <code>bots.json</code> 对应 bot 下加 <code>"transcriptAllowOpenIds": ["ou_..."]</code>，
            然后 <code>pm2 startOrReload ecosystem.config.cjs --only &lt;BotName&gt;</code>。
          </p>
        </div>
      </div>
    );
  }
  if (errorState?.kind === 'notFound') {
    return (
      <div className={styles.page}>
        <div className={styles.errorBlock}>
          <h2>对话不存在</h2>
          <p>找不到 <code>{chatId}</code> 对应的会话记录 —— 可能未开始过，或会话已被清理。</p>
        </div>
      </div>
    );
  }
  if (errorState?.kind === 'server') {
    return (
      <div className={styles.page}>
        <div className={styles.errorBlock}>
          <h2>加载失败</h2>
          <pre className={styles.errorDetail}>{errorState.message}</pre>
        </div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          {data.chat.title || data.chat.chatId}
        </div>
        <div className={styles.headerMeta}>
          {data.chat.botName && <span className={styles.headerBot}>@{data.chat.botName}</span>}
          <span className={styles.dim}>共 {data.chat.totalTurns} turn</span>
        </div>
      </header>

      <TurnSwitcher
        totalTurns={data.chat.totalTurns}
        currentTurn={currentTurn}
        onSelect={handleSelectTurn}
      />

      <div className={styles.body}>
        {messages.length === 0 ? (
          <div className={styles.emptyBlock}>该 turn 没有可显示的消息。</div>
        ) : (
          <MessageList
            messages={messages}
            onAnswer={() => { /* 详情页只读 */ }}
            onPreview={() => { /* 详情页不展开预览 */ }}
            autoScrollRef={autoScrollRef}
          />
        )}
      </div>
    </div>
  );
}
