/* ============================================================
   manager/Dashboard.tsx — bot list with live PM2 status.

   Polls /api/manager/bots every 5s; click a row to drill into detail.
============================================================ */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listBots, ApiError, type BotSummary } from './api';
import { StatusPill } from './ui';
import { useToast } from './toast';
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

export function Dashboard({ onAuthLost }: DashboardProps) {
  const navigate            = useNavigate();
  const toast               = useToast();
  const [bots, setBots]     = useState<BotSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mountedRef          = useRef(true);

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

    tick();
    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.content}>
      <div className={styles.pageHeading}>
        <h1>Bot 队列</h1>
        <span className={styles.meta}>
          {bots.length} 个 bot
          {lastUpdated && ` · 更新于 ${new Date(lastUpdated).toLocaleTimeString()}`}
        </span>
      </div>

      {loading ? (
        <div className={styles.statusBlock}>正在加载…</div>
      ) : bots.length === 0 ? (
        <div className={styles.statusBlock}>当前没有配置任何 bot</div>
      ) : (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
