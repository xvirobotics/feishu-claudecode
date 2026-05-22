/* ============================================================
   manager/Dashboard.tsx — bot list with live PM2 status.

   Polls /api/manager/bots every 5s; click a row to drill into detail.
   Inline icon actions per row (start/stop/restart) avoid the need to
   open the detail page just to flip a bot's state.
============================================================ */

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Play, RotateCw, Square } from 'lucide-react';
import {
  ApiError,
  listBots,
  restartBot,
  startBot,
  stopBot,
  type BotStatus,
  type BotSummary,
} from './api';
import { StatusPill } from './ui';
import { useToast } from './toast';
import { CreateBotModal } from './CreateBotModal';
import styles from './manager.module.css';

interface DashboardProps {
  onAuthLost: () => void;
}

const POLL_MS = 5000;

function formatUptime(ms?: number): string {
  if (!ms || ms <= 0) return '-';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)      return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60)      return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24)       return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function formatMem(mb?: number): string {
  if (mb == null) return '-';
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

type ActionKind = 'start' | 'stop' | 'restart';

export function Dashboard({ onAuthLost }: DashboardProps) {
  const navigate                      = useNavigate();
  const toast                         = useToast();
  const [bots, setBots]               = useState<BotSummary[]>([]);
  const [loading, setLoading]         = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [showCreate, setShowCreate]   = useState(false);
  // map of "<name>:<action>" → in-flight; one bot can only run one action at a time
  const [busy, setBusy]               = useState<Record<string, ActionKind | undefined>>({});
  const mountedRef                    = useRef(true);

  const tickRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const { bots } = await listBots();
        if (!mountedRef.current) return;
        setBots(bots);
        setLastUpdated(Date.now());
        setLoading(false);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onAuthLost();
          return;
        }
        if (mountedRef.current) {
          setLoading(false);
          toast.show(err instanceof Error ? err.message : '加载失败', 'error');
        }
      } finally {
        if (mountedRef.current) {
          timer = setTimeout(tick, POLL_MS);
        }
      }
    };

    tickRef.current = tick;
    tick();
    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAction = useCallback(
    async (e: MouseEvent, name: string, kind: ActionKind) => {
      e.stopPropagation();
      e.preventDefault();
      if (busy[name]) return;
      setBusy((m) => ({ ...m, [name]: kind }));
      try {
        let res: { status: BotSummary };
        if (kind === 'start')        res = await startBot(name);
        else if (kind === 'stop')    res = await stopBot(name);
        else                         res = await restartBot(name);
        // Optimistic patch into local list so the pill flips immediately.
        setBots((arr) => arr.map((b) => (b.name === name ? { ...b, ...res.status } : b)));
        toast.show(`${name}: ${kind} 已发起`, 'success');
        tickRef.current?.();  // kick a refresh so uptime/cpu re-sync soon
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onAuthLost();
          return;
        }
        toast.show(err instanceof Error ? err.message : `${kind} 失败`, 'error');
      } finally {
        if (mountedRef.current) {
          setBusy((m) => {
            const next = { ...m };
            delete next[name];
            return next;
          });
        }
      }
    },
    [busy, onAuthLost, toast],
  );

  return (
    <div className={styles.content}>
      <div className={styles.pageHeading}>
        <h1>Bot 队列</h1>
        <span className={styles.meta}>
          {bots.length} 个 bot
          {lastUpdated && ` · 更新于 ${new Date(lastUpdated).toLocaleTimeString()}`}
        </span>
        <button
          type="button"
          className={styles.actionBtn + ' ' + styles.actionBtnPrimary + ' ' + styles.pageHeadingBtn}
          onClick={() => setShowCreate(true)}
        >
          <Plus size={14} strokeWidth={2.25} />
          <span>新建 bot</span>
        </button>
      </div>

      {showCreate && (
        <CreateBotModal
          onClose={() => setShowCreate(false)}
          onCreated={(name) => {
            setShowCreate(false);
            navigate(`/manager/bots/${encodeURIComponent(name)}`);
          }}
          onAuthLost={onAuthLost}
        />
      )}

      {loading ? (
        <div className={styles.statusBlock}>正在加载…</div>
      ) : bots.length === 0 ? (
        <div className={styles.statusBlock}>当前没有配置任何 bot</div>
      ) : (
        <>
          {/* Desktop: full table. Mobile (<=768px): hidden via CSS. */}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>PID</th>
                  <th>运行时长</th>
                  <th>CPU</th>
                  <th>内存</th>
                  <th>重启次数</th>
                  <th>API 端口</th>
                  <th>Memory 端口</th>
                  <th>会话数</th>
                  <th>工作目录</th>
                  <th className={styles.actionsCol}>操作</th>
                </tr>
              </thead>
              <tbody>
                {bots.map((b) => (
                  <tr
                    key={b.name}
                    className={styles.rowClickable}
                    onClick={() => navigate(`/manager/bots/${encodeURIComponent(b.name)}`)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/manager/bots/${encodeURIComponent(b.name)}`);
                      }
                    }}
                  >
                    <td className={styles.botName}>{b.name}</td>
                    <td><StatusPill status={b.status} /></td>
                    <td className={styles.mono}>{b.pid ?? '-'}</td>
                    <td className={styles.mono}>{formatUptime(b.uptimeMs)}</td>
                    <td className={styles.mono}>{b.cpu != null ? `${b.cpu.toFixed(1)}%` : '-'}</td>
                    <td className={styles.mono}>{formatMem(b.memMb)}</td>
                    <td className={styles.mono}>{b.restarts ?? '-'}</td>
                    <td className={styles.mono}>{b.apiPort ?? '-'}</td>
                    <td className={styles.mono}>{b.memoryPort ?? '-'}</td>
                    <td className={styles.mono}>{b.sessionCount ?? '-'}</td>
                    <td className={styles.mono} title={b.workdir ?? ''}>
                      {b.workdir ? (
                        <span>{b.workdir.length > 38 ? '…' + b.workdir.slice(-37) : b.workdir}</span>
                      ) : (
                        <span className={styles.dim}>未设置</span>
                      )}
                    </td>
                    <td className={styles.actionsCol}>
                      <RowActions
                        status={b.status}
                        busy={busy[b.name]}
                        onClick={(e, kind) => handleAction(e, b.name, kind)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: card list. Desktop hides this via CSS. */}
          <div className={styles.botCards}>
            {bots.map((b) => (
              <div
                key={b.name}
                className={styles.botCard}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/manager/bots/${encodeURIComponent(b.name)}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/manager/bots/${encodeURIComponent(b.name)}`);
                  }
                }}
              >
                <div className={styles.botCardHead}>
                  <span className={styles.botCardName}>{b.name}</span>
                  <StatusPill status={b.status} />
                </div>
                <div className={styles.botCardStats}>
                  <div>
                    <div className={styles.botCardStatLabel}>运行时长</div>
                    <div className={styles.botCardStatVal}>{formatUptime(b.uptimeMs)}</div>
                  </div>
                  <div>
                    <div className={styles.botCardStatLabel}>内存</div>
                    <div className={styles.botCardStatVal}>{formatMem(b.memMb)}</div>
                  </div>
                  <div>
                    <div className={styles.botCardStatLabel}>CPU</div>
                    <div className={styles.botCardStatVal}>
                      {b.cpu != null ? `${b.cpu.toFixed(1)}%` : '-'}
                    </div>
                  </div>
                  <div>
                    <div className={styles.botCardStatLabel}>会话</div>
                    <div className={styles.botCardStatVal}>{b.sessionCount ?? '-'}</div>
                  </div>
                  <div>
                    <div className={styles.botCardStatLabel}>API</div>
                    <div className={styles.botCardStatVal}>{b.apiPort ?? '-'}</div>
                  </div>
                  <div>
                    <div className={styles.botCardStatLabel}>Memory</div>
                    <div className={styles.botCardStatVal}>{b.memoryPort ?? '-'}</div>
                  </div>
                </div>
                {b.workdir && (
                  <div className={styles.botCardWorkdir} title={b.workdir}>
                    {b.workdir}
                  </div>
                )}
                <CardActions
                  status={b.status}
                  busy={busy[b.name]}
                  onClick={(e, kind) => handleAction(e, b.name, kind)}
                />
              </div>
            ))}
          </div>
        </>
      )}

    </div>
  );
}

/* ── Action buttons (shared row-actions / card-actions widgets) ────── */

interface ActionsProps {
  status: BotStatus;
  busy?:  ActionKind;
  onClick: (e: MouseEvent, kind: ActionKind) => void;
}

function RowActions({ status, busy, onClick }: ActionsProps) {
  const isOnline  = status === 'online' || status === 'launching';
  const isBusy    = busy !== undefined;
  return (
    <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
      <IconActionBtn
        kind="start"
        icon={<Play size={14} strokeWidth={2.25} />}
        title="启动"
        onClick={(e) => onClick(e, 'start')}
        disabled={isBusy || isOnline}
        loading={busy === 'start'}
      />
      <IconActionBtn
        kind="restart"
        icon={<RotateCw size={14} strokeWidth={2.25} />}
        title="重启"
        onClick={(e) => onClick(e, 'restart')}
        disabled={isBusy}
        loading={busy === 'restart'}
      />
      <IconActionBtn
        kind="stop"
        icon={<Square size={13} strokeWidth={2.25} fill="currentColor" />}
        title="停止"
        onClick={(e) => onClick(e, 'stop')}
        disabled={isBusy || status === 'stopped'}
        loading={busy === 'stop'}
        danger
      />
    </div>
  );
}

function CardActions({ status, busy, onClick }: ActionsProps) {
  const isOnline = status === 'online' || status === 'launching';
  const isBusy   = busy !== undefined;
  return (
    <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
      <CardActionBtn
        icon={<Play size={15} strokeWidth={2.25} />}
        label="启动"
        onClick={(e) => onClick(e, 'start')}
        disabled={isBusy || isOnline}
        loading={busy === 'start'}
      />
      <CardActionBtn
        icon={<RotateCw size={15} strokeWidth={2.25} />}
        label="重启"
        onClick={(e) => onClick(e, 'restart')}
        disabled={isBusy}
        loading={busy === 'restart'}
      />
      <CardActionBtn
        icon={<Square size={14} strokeWidth={2.25} fill="currentColor" />}
        label="停止"
        onClick={(e) => onClick(e, 'stop')}
        disabled={isBusy || status === 'stopped'}
        loading={busy === 'stop'}
        danger
      />
    </div>
  );
}

interface IconActionBtnProps {
  kind:     ActionKind;
  icon:     ReactNode;
  title:    string;
  onClick:  (e: MouseEvent) => void;
  disabled: boolean;
  loading:  boolean;
  danger?:  boolean;
}

function IconActionBtn({ icon, title, onClick, disabled, loading, danger }: IconActionBtnProps) {
  return (
    <button
      type="button"
      className={styles.iconActionBtn + (danger ? ' ' + styles.iconActionBtnDanger : '')}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      <span className={loading ? styles.iconSpinning : ''}>{icon}</span>
    </button>
  );
}

interface CardActionBtnProps {
  icon:     ReactNode;
  label:    string;
  onClick:  (e: MouseEvent) => void;
  disabled: boolean;
  loading:  boolean;
  danger?:  boolean;
}

function CardActionBtn({ icon, label, onClick, disabled, loading, danger }: CardActionBtnProps) {
  return (
    <button
      type="button"
      className={styles.cardActionBtn + (danger ? ' ' + styles.cardActionBtnDanger : '')}
      onClick={onClick}
      disabled={disabled}
    >
      <span className={loading ? styles.iconSpinning : ''}>{icon}</span>
      <span>{loading ? '执行中…' : label}</span>
    </button>
  );
}
