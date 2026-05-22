/* ============================================================
   hub/HostDetail.tsx — single-host view inside the Hub.

   Read-only: lists every published bot's run-time stats, plus
   a notice block when the host has hidden bots. Sensitive
   fields (feishuAppSecret, env, sometimes workdir) are marked
   as obscured.

   Wired to `useHubHost()` for live data and `useHubBotSessions()`
   for the click-through side-panel — clicking a bot opens its
   sessions list; clicking a session opens the bot's transcript
   page in a new tab (disabled when transcriptBaseUrl is missing).
============================================================ */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Cloud, EyeOff, Monitor, Shield } from 'lucide-react';
import { formatLastSeen, formatUptime, type HubBot } from './mockData';
import {
  redirectToLogin,
  useHubBotSessions,
  useHubHost,
  type HubSessionEntry,
} from './useHub';
import mgr from '../manager/manager.module.css';
import hub from './hub.module.css';

const STATUS_TEXT: Record<HubBot['status'], string> = {
  online:    'ONLINE',
  stopped:   'STOPPED',
  launching: 'LAUNCHING',
  error:     'ERROR',
  unknown:   'UNKNOWN',
};

export function HostDetail() {
  const { hostId = '' } = useParams<{ hostId: string }>();
  const navigate        = useNavigate();
  const state           = useHubHost(hostId);
  const [selectedBot, setSelectedBot] = useState<HubBot | null>(null);

  useEffect(() => {
    if (state.kind === 'login') redirectToLogin(state.loginUrl);
  }, [state]);

  if (state.kind === 'loading') return <HubStatus message="正在加载主机详情…" />;
  if (state.kind === 'login')   return <HubStatus message="正在跳转登录…" />;
  if (state.kind === 'error')   return <HubStatus message={`加载失败：${state.message}`} tone="error" />;

  const host = state.data;
  const initials = (host.hostName || host.hostId).slice(0, 1).toUpperCase();

  return (
    <>
      <div className={hub.hostDetailHead}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className={mgr.topBarBack} onClick={() => navigate('/hub')}>
            <ChevronLeft size={14} strokeWidth={2} />
            <span>返回</span>
          </button>
        </div>

        <div className={hub.hostDetailTitleRow}>
          <div className={hub.hostDetailAvatar}>{initials}</div>
          <div className={hub.hostDetailTitleText}>
            <div className={hub.hostDetailTitle}>
              {host.hostName}
              <span className={`${hub.hostStatusPill} ${host.online ? hub.hostStatusOnline : hub.hostStatusOffline}`} style={{ marginLeft: 10 }}>
                <span className={hub.hostStatusDot} />
                {host.online ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <div className={hub.hostDetailSubtitle}>{host.hostId}</div>
          </div>
        </div>

        <div className={hub.hostDetailMetaRow}>
          <span className={hub.hostMetaItem}><Monitor size={12} strokeWidth={2} />{host.os}</span>
          <span className={hub.hostMetaItem}><Cloud size={12} strokeWidth={2} />{host.agentVersion}</span>
          <span className={hub.hostMetaItem}>{host.online ? '正在连接' : `最后活跃 ${formatLastSeen(host.lastSeen)}`}</span>
        </div>
      </div>

      {host.hiddenBotCount > 0 ? (
        <div className={hub.hiddenNotice}>
          <EyeOff size={13} strokeWidth={2} />
          该主机还有 <strong style={{ color: 'var(--text-0)', margin: '0 4px' }}>{host.hiddenBotCount}</strong> 个 bot 被标记为「仅本地」，Hub 无法看到。
        </div>
      ) : null}

      <div className={hub.sectionHeading}>
        <h2>已发布的 Bot</h2>
        <span className={hub.meta}>{host.visibleBots.length} 个 · 用户主动公开</span>
      </div>

      <div className={hub.botRowList}>
        {host.visibleBots.map((b) => (
          <BotRow
            key={b.name}
            bot={b}
            selected={selectedBot?.name === b.name}
            onSelect={() => setSelectedBot((current) => (current?.name === b.name ? null : b))}
          />
        ))}
        {host.visibleBots.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text-2)', textAlign: 'center', fontSize: 13 }}>
            没有任何对 Hub 可见的 bot。
          </div>
        ) : null}
      </div>

      {selectedBot ? (
        <SessionsPanel bot={selectedBot} onClose={() => setSelectedBot(null)} />
      ) : null}

      <div className={hub.hiddenNotice} style={{ marginBottom: 24 }}>
        <Shield size={13} strokeWidth={2} />
        敏感字段（如 <code>feishuAppSecret</code> / 环境变量 / 工作目录）由用户客户端在上报时已脱敏，Hub 永远不会接收明文。
      </div>
    </>
  );
}

/* ────────────────────────────────────────────────────────── */

interface BotRowProps {
  bot:      HubBot;
  selected: boolean;
  onSelect: () => void;
}

function BotRow({ bot, selected, onSelect }: BotRowProps) {
  const statusClass =
    bot.status === 'online'    ? hub.botChipOnline    :
    bot.status === 'launching' ? hub.botChipLaunching :
    bot.status === 'error'     ? hub.botChipError     :
                                  hub.botChipStopped;

  const rowClass = `${hub.botRow} ${hub.botRowClickable} ${selected ? hub.botRowSelected : ''}`;

  return (
    <div
      className={rowClass}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      title="点击查看该 bot 的会话列表"
    >
      <div className={hub.botRowName}>
        {bot.name}
        <span className={`${hub.botChip} ${statusClass}`} style={{ marginLeft: 8, fontSize: 10, padding: '2px 7px 2px 6px' }}>
          <span className={hub.botChipDot} />
          {STATUS_TEXT[bot.status]}
        </span>
      </div>
      <div className={hub.botRowStats}>
        <Stat label="UPTIME"   value={formatUptime(bot.uptimeMs)} />
        <Stat label="CPU"      value={bot.cpu == null ? '-' : `${bot.cpu.toFixed(1)}%`} />
        <Stat label="MEM"      value={bot.memMb == null ? '-' : `${bot.memMb} MB`} />
        <Stat label="SESSIONS" value={bot.sessions == null ? '-' : String(bot.sessions)} />
      </div>
      <div className={hub.botRowWorkdir} title={bot.workdir}>
        {bot.hiddenFields.includes('workdir')
          ? <span className={hub.privacyBadge}><EyeOff size={10} strokeWidth={2} />workdir 已脱敏</span>
          : <>📁 {bot.workdir || '-'}</>}
        {bot.hiddenFields.filter((f) => f !== 'workdir').map((f) => (
          <span key={f} className={hub.privacyBadge}>
            <EyeOff size={10} strokeWidth={2} />
            {f} 已脱敏
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={hub.botRowStat}>
      <span className={hub.botRowStatLabel}>{label}</span>
      <span className={hub.botRowStatValue}>{value}</span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */

interface SessionsPanelProps {
  bot:     HubBot;
  onClose: () => void;
}

function SessionsPanel({ bot, onClose }: SessionsPanelProps) {
  const state = useHubBotSessions(bot.name);
  const canJump = typeof bot.transcriptBaseUrl === 'string' && bot.transcriptBaseUrl.length > 0;

  return (
    <div className={hub.sessionPanel}>
      <div className={hub.sessionPanelHead}>
        <span className={hub.sessionPanelTitle}>{bot.name}</span>
        <span>会话列表</span>
        {!canJump ? (
          <span className={hub.sessionPanelHint}>bot 未配置 publicBaseUrl — 无法打开 transcript</span>
        ) : null}
        <button className={hub.sessionPanelClose} onClick={onClose} type="button">关闭</button>
      </div>

      {state.kind === 'loading' ? <div className={hub.sessionStatus}>正在加载会话…</div> : null}
      {state.kind === 'login'   ? <div className={hub.sessionStatus}>需要登录后才能查看会话。</div> : null}
      {state.kind === 'error'   ? <div className={hub.sessionStatus}>加载失败：{state.message}</div> : null}
      {state.kind === 'ok' && state.data.length === 0 ? (
        <div className={hub.sessionStatus}>该 bot 还没有任何会话。</div>
      ) : null}
      {state.kind === 'ok' && state.data.length > 0 ? (
        <div className={hub.sessionList}>
          {state.data.map((s) => (
            <SessionRow
              key={s.chatId}
              session={s}
              transcriptBaseUrl={bot.transcriptBaseUrl}
              enabled={canJump}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface SessionRowProps {
  session:           HubSessionEntry;
  transcriptBaseUrl: string | undefined;
  enabled:           boolean;
}

function SessionRow({ session, transcriptBaseUrl, enabled }: SessionRowProps) {
  const onOpen = () => {
    if (!enabled || !transcriptBaseUrl) return;
    const url = `${transcriptBaseUrl}/web/transcript/${encodeURIComponent(session.chatId)}?turn=all`;
    window.open(url, '_blank', 'noopener');
  };
  const title = session.title || '(未命名会话)';
  const titleClipped = title.length > 60 ? `${title.slice(0, 60)}…` : title;
  return (
    <div
      className={`${hub.sessionRow} ${enabled ? '' : hub.sessionRowDisabled}`}
      onClick={onOpen}
      role="button"
      tabIndex={enabled ? 0 : -1}
      title={enabled ? '在新标签页打开 transcript' : '该 bot 未配置 publicBaseUrl'}
    >
      <div className={hub.sessionTitle}>{titleClipped}</div>
      <div className={hub.sessionMeta}>
        <span>{session.chatId}</span>
        {session.lastUsed ? <span>{formatLastSeen(new Date(session.lastUsed).toISOString())}</span> : null}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */

function HubStatus({ message, tone }: { message: string; tone?: 'error' }) {
  return (
    <div style={{
      padding:    '60px 24px',
      textAlign:  'center',
      color:      tone === 'error' ? '#fca5a5' : 'var(--text-2)',
      fontSize:   14,
    }}>
      {message}
    </div>
  );
}
