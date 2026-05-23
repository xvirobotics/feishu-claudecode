/* ============================================================
   TranscriptView — public-facing conversation history page.

   URL: /transcript/:chatId?turn=<N>   (1-based, 默认 anchor 当前 turn)

   - 删了顶部 title 和横向 turn 导航条 —— 飞书内点开就是单 turn。
   - 顶部下拉触发"加载更早 2 个 turn"，底部下拉触发"加载更晚 2 个 turn"。
   - 每个 turn 一个 "#N" 分隔条，user 气泡靠右、assistant 气泡靠左。
   - assistant 气泡内部：
       工具调用 ≤10 条平铺 + "查看全部 N 个" 浮窗 Modal
       下方按时间顺序展示每次文字更新，相邻段落用横线分隔
   - 鉴权走 Feishu OAuth + HttpOnly cookie；非白名单 403。
============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './TranscriptView.module.css';
import { deriveApiBase } from '../utils/transcriptPath';

/* ── 后端形状（src/session/transcript-reader.ts） ── */

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

type ErrorState =
  | { kind: 'forbidden'; message: string }
  | { kind: 'notFound' }
  | { kind: 'server';    message: string };

/* ── 工具调用 input 缩成严格单行 ──
 * 设计：用户只要看到「工具名 + 它在做什么」的一句话提要，
 *      多行参数（command 里的 heredoc 之类）、嵌套字段、大对象都剥掉。
 *      不显示 result —— 历史回放阶段 result 几乎总比 input 长一个量级，
 *      留着会把整个 strip 撑得很乱。
 */
function flattenInput(input: unknown): string {
  if (input == null) return '';
  let raw: string;
  if (typeof input === 'string') {
    raw = input;
  } else {
    try { raw = JSON.stringify(input); } catch { raw = String(input); }
  }
  // 强制单行：所有 \r \n \t 折叠成空格，连续空白压成一个
  const oneLine = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

/* ── 把 TranscriptMessage[] 折成 turn 块结构 ── */

interface AggregatedTurn {
  user?:       TranscriptMessage;
  assistant?:  {
    toolCalls: TranscriptToolCall[];   // 一个 turn 内所有工具调用
    texts:     string[];               // 多次文字更新（按时间顺序）
    thinking?: string;                 // 合并的 thinking
  };
}

function aggregate(messages: TranscriptMessage[]): AggregatedTurn {
  const out: AggregatedTurn = {};
  const toolCalls: TranscriptToolCall[] = [];
  const texts: string[] = [];
  let thinking = '';
  for (const m of messages) {
    if (m.role === 'user') {
      if (!out.user) out.user = m;
      continue;
    }
    if (m.toolCalls) toolCalls.push(...m.toolCalls);
    if (m.text && m.text.trim()) texts.push(m.text);
    if (m.thinking) thinking += (thinking ? '\n' : '') + m.thinking;
  }
  if (toolCalls.length || texts.length || thinking) {
    out.assistant = { toolCalls, texts, ...(thinking ? { thinking } : {}) };
  }
  return out;
}

/* ── Markdown 渲染（轻量配置，无 rehype-highlight，节省体积） ── */

function Markdown({ children }: { children: string }) {
  return (
    <div className={styles.textBlock}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

/* ── 工具调用浮窗 ── */

function ToolModal({
  calls,
  onClose,
}: {
  calls: TranscriptToolCall[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span>工具调用 · 共 {calls.length} 条</span>
          <button className={styles.modalClose} onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className={styles.modalBody}>
          {calls.map((c, i) => (
            <div key={c.id || i} className={styles.modalToolItem}>
              <div className={styles.modalToolName}>#{i + 1} {c.name}</div>
              <div className={styles.modalToolBlock}>{flattenInput(c.input) || '(空)'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── 长内容默认折叠（展开后不再支持收起） ──
 * Why: 历史回放经常有几千行的 assistant 输出，超长 bubble 会把上下文吞掉。
 *      Mount 后测量 scrollHeight；超过阈值 → max-height + 底部渐隐 + "展开" 按钮。
 *      用户明确："展开以后就不支持再收起来了"。
 */
const COLLAPSE_THRESHOLD_PX = 2000; // ≈ 100 行 @ line-height 1.55 / 14px

function CollapsibleContent({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // 测量内容高度（mount + children 变化后）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 给浏览器一个 layout 周期；MutationObserver 也能盯到 markdown 后续注入
    const measure = () => {
      if (!ref.current) return;
      setOverflow(ref.current.scrollHeight > COLLAPSE_THRESHOLD_PX);
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);

  const collapsed = overflow && !expanded;
  return (
    <div className={collapsed ? styles.collapsedWrap : undefined}>
      <div
        ref={ref}
        className={collapsed ? styles.collapsedInner : undefined}
      >
        {children}
      </div>
      {collapsed && (
        <button
          type="button"
          className={styles.expandBtn}
          onClick={() => setExpanded(true)}
        >
          展开剩余内容 ↓
        </button>
      )}
    </div>
  );
}

/* ── 单个 turn 块 ── */

function TurnBlock({
  turn,
  agg,
  dividerRef,
}: {
  turn:       number;
  agg:        AggregatedTurn;
  dividerRef: (el: HTMLDivElement | null) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const toolCalls = agg.assistant?.toolCalls ?? [];
  const visibleCalls = toolCalls.slice(0, 10);
  const hiddenCount = toolCalls.length - visibleCalls.length;

  return (
    <>
      <div className={styles.turnDivider} ref={dividerRef} data-turn={turn}>
        <span className={styles.turnLabel}>#{turn}</span>
      </div>
      {agg.user?.text && (
        <div className={`${styles.row} ${styles.rowUser}`}>
          <div className={`${styles.bubble} ${styles.bubbleUser}`}>{agg.user.text}</div>
        </div>
      )}
      {agg.assistant && (
        <div className={`${styles.row} ${styles.rowAssistant}`}>
          <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
            <CollapsibleContent>
              {toolCalls.length > 0 && (
                <div className={styles.toolStrip}>
                  {visibleCalls.map((c, i) => (
                    <div key={c.id || i} className={styles.toolRow}>
                      <span className={styles.toolName}>{c.name}</span>
                      <span className={styles.toolDetail}>{flattenInput(c.input)}</span>
                    </div>
                  ))}
                  {hiddenCount > 0 && (
                    <button className={styles.toolMoreBtn} onClick={() => setModalOpen(true)}>
                      查看全部 {toolCalls.length} 个
                    </button>
                  )}
                </div>
              )}
              {agg.assistant.thinking && (
                <div className={styles.thinking}>💭 {agg.assistant.thinking}</div>
              )}
              {agg.assistant.texts.map((t, i) => (
                <Markdown key={i}>{t}</Markdown>
              ))}
            </CollapsibleContent>
          </div>
        </div>
      )}
      {modalOpen && <ToolModal calls={toolCalls} onClose={() => setModalOpen(false)} />}
    </>
  );
}

/* ── 已加载 turn 数据状态 ── */

// anchor 居中 ±3,首屏一次性加载 7 条,之后页面纯静态滚动(无 sentinel 动态加载)。
// 真正需要看更远的 turn 时用户重新点链接 / 改 URL turn 参数。
const HALF_WINDOW = 3;

interface LoadedTurn {
  turn:     number;
  messages: TranscriptMessage[];
}

/* ── 主组件 ── */

export function TranscriptView() {
  // 强制 light theme（详情页独立入口，不跟 ChatView 暗主题）。
  // 解除 SPA 默认布局对 window 滚动的限制 —— 三处都要解,缺一不可:
  //   - theme.css   :  body { overflow: hidden }
  //   - index.html  :  #root { height: 100dvh }  ← 这条让 documentElement 不可滚
  //   - html/body   :  默认是 viewport 大小
  // 解开后 window 才能成为 scroll 容器,scrollTo 定位 anchor 才生效。
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    const save = (el: HTMLElement | null) => el ? {
      overflow: el.style.overflow,
      height:   el.style.height,
    } : null;
    const prevHtml = save(html);
    const prevBody = save(body);
    const prevRoot = save(root);
    [html, body, root].forEach((el) => {
      if (!el) return;
      el.style.overflow = 'auto';
      el.style.height   = 'auto';
    });
    return () => {
      if (prevHtml) { html.style.overflow = prevHtml.overflow; html.style.height = prevHtml.height; }
      if (prevBody) { body.style.overflow = prevBody.overflow; body.style.height = prevBody.height; }
      if (root && prevRoot) { root.style.overflow = prevRoot.overflow; root.style.height = prevRoot.height; }
    };
  }, []);

  const { chatId } = useParams<{ chatId: string }>();
  const [searchParams] = useSearchParams();
  const anchorTurn = useMemo(() => {
    const p = searchParams.get('turn');
    if (!p || p === 'all') return null;
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [searchParams]);

  const [loaded, setLoaded] = useState<LoadedTurn[]>([]);
  const [totalTurns, setTotalTurns] = useState(0);
  const [visibleTurn, setVisibleTurn] = useState<number | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);

  const topBarRef   = useRef<HTMLDivElement | null>(null);
  const streamRef   = useRef<HTMLDivElement | null>(null);
  // 每个 turn divider DOM 注册到这个 map，用于 IntersectionObserver 跟踪 + 滚动定位。
  const dividerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // 首屏 anchor 锁:打开链接后 visibleTurn 必须停在 anchor turn 上,
  // IO 不能因为 anchor 上方还有 turn 落入可视区就把 visibleTurn 拉到更早。
  // 用户首次交互 (wheel / touch / keyboard) → 解锁,IO 接管。
  const anchorLockedRef = useRef(true);

  /* ── 滚动定位到 anchor turn 的 divider ──
   * Why: 首屏对称加载 7 条（anchor 居中）后，scrollTop 默认 0，用户看到的是最早的那条，
   *      而不是他点击进来的那条。这里强行把 anchor 的 divider 滚到 top-bar 下方。
   * 防 layout 抖动:CollapsibleContent 的 MutationObserver 会在 mount 后异步 collapse
   *  超长 turn,布局会变。所以多次 schedule —— raf + 多个 setTimeout 兜底。
   *  anchorLockedRef.current=false (用户已交互) 时立即放弃,不打断手动滚动。
   */
  const scrollToAnchorTurn = useCallback((turn: number) => {
    if (!anchorLockedRef.current) return;
    const el = dividerRefs.current.get(turn);
    if (!el) return;
    const offset = (topBarRef.current?.offsetHeight ?? 0) + 8;
    const top    = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }, []);

  // anchor 多次校准:不同 delay 兜底 collapse 引起的 layout 抖动。
  const settleScrollToAnchor = useCallback((turn: number) => {
    const tryScroll = () => scrollToAnchorTurn(turn);
    requestAnimationFrame(() => requestAnimationFrame(tryScroll));
    setTimeout(tryScroll, 150);
    setTimeout(tryScroll, 450);
    setTimeout(tryScroll, 900);
  }, [scrollToAnchorTurn]);

  /* ── 取单个 turn 的 HTTP 调用 ── */

  const fetchTurn = useCallback(async (chatId: string, turn: number): Promise<TranscriptResponse | { error: ErrorState }> => {
    try {
      const apiBase = deriveApiBase(window.location.pathname);
      const res = await fetch(`${apiBase}/api/transcript/${encodeURIComponent(chatId)}?turn=${turn}`, {
        credentials: 'include',
      });
      if (res.status === 401) {
        const body = (await res.json().catch(() => null)) as UnauthorizedResponse | null;
        const loginUrl =
          body?.loginUrl ||
          `/api/auth/feishu/login?return=${encodeURIComponent(window.location.pathname + window.location.search)}`;
        window.location.replace(loginUrl);
        return { error: { kind: 'server', message: 'redirecting…' } };
      }
      if (res.status === 403) {
        return {
          error: {
            kind:    'forbidden',
            message: '您已通过飞书登录，但您的 open_id 不在该 bot 的白名单中。请联系管理员把您的 open_id 加入 `transcriptAllowOpenIds`。',
          },
        };
      }
      if (res.status === 404) {
        return { error: { kind: 'notFound' } };
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')) || `HTTP ${res.status}`;
        return { error: { kind: 'server', message: body } };
      }
      return (await res.json()) as TranscriptResponse;
    } catch (err) {
      const e = err as { message?: string };
      return { error: { kind: 'server', message: e?.message || 'network error' } };
    }
  }, []);

  /* ── 初始加载：SSR inline 或单 turn fetch ── */

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    setInitialLoading(true);
    setErrorState(null);
    setLoaded([]);

    type Inline =
      | { kind: 'ok'; payload: TranscriptResponse }
      | { kind: 'forbidden' }
      | { kind: 'notFound' }
      | { kind: 'unavailable' };
    const inline = (window as unknown as { __TRANSCRIPT_DATA__?: Inline }).__TRANSCRIPT_DATA__;

    const finalise = (resp: TranscriptResponse) => {
      if (cancelled) return;
      const anchor = typeof resp.turn === 'number'
        ? resp.turn
        : resp.chat.totalTurns;
      const total  = resp.chat.totalTurns;
      setTotalTurns(total);
      setLoaded([{ turn: anchor, messages: resp.messages }]);
      setVisibleTurn(anchor);
      setInitialLoading(false);

      // 对称窗口:anchor 居中 ±HALF_WINDOW,共 7 条;某边不够把缺口让给对边。
      // 加载完后 scroll 到 anchor divider —— 这是首屏精准定位的关键。
      if (!chatId) {
        settleScrollToAnchor(anchor);
        return;
      }
      let low  = Math.max(1,     anchor - HALF_WINDOW);
      let high = Math.min(total, anchor + HALF_WINDOW);
      while (high - low + 1 < 2 * HALF_WINDOW + 1) {
        const before = high - low + 1;
        if      (low  > 1)     low--;
        else if (high < total) high++;
        if (high - low + 1 === before) break;  // 总数不够 7,停
      }
      const others: number[] = [];
      for (let t = low; t <= high; t++) if (t !== anchor) others.push(t);
      if (others.length === 0) {
        settleScrollToAnchor(anchor);
        return;
      }
      Promise.all(others.map((t) => fetchTurn(chatId, t))).then((results) => {
        if (cancelled) return;
        const ok = results
          .map((r, i) => ({ r, t: others[i] }))
          .filter((x) => !('error' in x.r))
          .map((x) => ({ turn: x.t, messages: (x.r as TranscriptResponse).messages }));
        if (ok.length > 0) {
          setLoaded((prev) => {
            const merged = [...prev, ...ok].sort((a, b) => a.turn - b.turn);
            return merged.filter((m, i, arr) => i === 0 || arr[i - 1].turn !== m.turn);
          });
        }
        // 两层 raf 等所有 turn divider 真正布局完成再定位
        requestAnimationFrame(() => {
          settleScrollToAnchor(anchor);
        });
      });
    };

    if (inline) {
      if (inline.kind === 'ok') {
        finalise(inline.payload);
      } else if (inline.kind === 'forbidden') {
        setErrorState({
          kind:    'forbidden',
          message: '您已通过飞书登录，但您的 open_id 不在该 bot 的白名单中。请联系管理员把您的 open_id 加入 `transcriptAllowOpenIds`。',
        });
        setInitialLoading(false);
      } else if (inline.kind === 'notFound') {
        setErrorState({ kind: 'notFound' });
        setInitialLoading(false);
      } else {
        setErrorState({ kind: 'server', message: 'session registry unavailable' });
        setInitialLoading(false);
      }
      return () => { cancelled = true; };
    }

    // Fallback: dev mode (Vite) 或 SSR 数据缺失，直接 fetch。
    // 没有指定 anchor 时，传一个很大的数让 backend clamp 到 totalTurns（最新一轮）。
    const turnToFetch = anchorTurn ?? 999999;
    fetchTurn(chatId, turnToFetch).then((r) => {
      if (cancelled) return;
      if ('error' in r) { setErrorState(r.error); setInitialLoading(false); return; }
      finalise(r);
    });

    return () => { cancelled = true; };
  }, [chatId, anchorTurn, fetchTurn]);

  /* ── IntersectionObserver 跟踪 turnDivider，更新顶栏徽章 + URL ──
   * 首屏 anchorLockedRef=true 时跳过更新;用户首次手动交互后解锁。
   */
  useEffect(() => {
    if (initialLoading || loaded.length === 0) return;
    const visible = new Set<number>();
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const t = parseInt((e.target as HTMLElement).dataset.turn ?? '', 10);
        if (!Number.isFinite(t)) continue;
        if (e.isIntersecting) visible.add(t);
        else visible.delete(t);
      }
      if (anchorLockedRef.current) return;
      if (visible.size === 0) return;
      const top = Math.min(...visible);
      setVisibleTurn(top);
    }, { rootMargin: '-40px 0px -60% 0px', threshold: 0 });

    dividerRefs.current.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [initialLoading, loaded]);

  /* ── 用户首次手动交互 → 解锁 anchor,IO 接管 visibleTurn ── */
  useEffect(() => {
    const unlock = () => { anchorLockedRef.current = false; };
    window.addEventListener('wheel',     unlock, { passive: true, once: true });
    window.addEventListener('touchmove', unlock, { passive: true, once: true });
    window.addEventListener('keydown',   unlock, { once: true });
    return () => {
      window.removeEventListener('wheel',     unlock);
      window.removeEventListener('touchmove', unlock);
      window.removeEventListener('keydown',   unlock);
    };
  }, []);

  useEffect(() => {
    if (visibleTurn == null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('turn') === String(visibleTurn)) return;
    url.searchParams.set('turn', String(visibleTurn));
    window.history.replaceState(null, '', url.toString());
  }, [visibleTurn]);

  /* ── 聚合每个 turn ── */

  const aggregatedTurns = useMemo(
    () => loaded.map((lt) => ({ turn: lt.turn, agg: aggregate(lt.messages) })),
    [loaded]
  );

  /* ── render ── */

  if (initialLoading) {
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
  if (aggregatedTurns.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyBlock}>没有可显示的消息。</div>
      </div>
    );
  }

  const minTurn = aggregatedTurns[0].turn;
  const maxTurn = aggregatedTurns[aggregatedTurns.length - 1].turn;
  const hasEarlier = minTurn > 1;
  const hasLater   = maxTurn < totalTurns;

  return (
    <div className={styles.page}>
      <div ref={topBarRef} className={styles.topBar}>
        <span className={styles.topBarBadge}>#{visibleTurn ?? maxTurn}</span>
        <span className={styles.topBarTotal}>/ 共 {totalTurns} 轮</span>
      </div>
      {/* padding-bottom: 100vh —— 保证页面始终可滚到把 anchor turn 顶到 top-bar 下方;
          否则短对话整页高度 < viewport,scrollTo 被浏览器 clamp 到 0,anchor 无法定位。*/}
      <div ref={streamRef} className={styles.stream} style={{ paddingBottom: '100vh' }}>
        {hasEarlier
          ? <div className={styles.endHint}>… 更早的对话需要从原链接重新打开 …</div>
          : <div className={styles.endHint}>— 对话开头 —</div>}

        {aggregatedTurns.map((t) => (
          <TurnBlock
            key={t.turn}
            turn={t.turn}
            agg={t.agg}
            dividerRef={(el) => {
              if (el) dividerRefs.current.set(t.turn, el);
              else dividerRefs.current.delete(t.turn);
            }}
          />
        ))}

        {hasLater
          ? <div className={styles.endHint}>… 更晚的对话需要从原链接重新打开 …</div>
          : <div className={styles.endHint}>— 对话末尾 —</div>}
      </div>
    </div>
  );
}
