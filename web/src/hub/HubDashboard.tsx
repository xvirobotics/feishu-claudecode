/* ============================================================
   hub/HubDashboard.tsx — central server overview.

   Lists every host that has opted into the Hub plus the bots
   each host has explicitly published. Bots flagged as
   "private (local-only)" never reach this surface.

   Backed by `useHubHosts()` — talks to `/api/hub/hosts` on
   the manager process; renders loading + login + error states
   distinct from the data state.
============================================================ */

import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cloud, EyeOff, Monitor, Shield } from 'lucide-react';
import { formatLastSeen, type HubHost, type HubBot } from './mockData';
import { computeTotals, redirectToLogin, useHubHosts } from './useHub';
import hub from './hub.module.css';

export function HubDashboard() {
  const navigate = useNavigate();
  const state    = useHubHosts();
  const hosts    = state.kind === 'ok' ? state.data : EMPTY_HOSTS;
  const stats    = useMemo(() => computeTotals(hosts), [hosts]);

  useEffect(() => {
    if (state.kind === 'login') redirectToLogin(state.loginUrl);
  }, [state]);

  if (state.kind === 'loading') return <HubStatus message="正在加载 Hub…" />;
  if (state.kind === 'login')   return <HubStatus message="正在跳转登录…" />;
  if (state.kind === 'error')   return <HubStatus message={`加载失败：${state.message}`} tone="error" />;

  return (
    <>
      {/* Privacy banner — always visible at the top */}
      <div className={hub.privacyBanner}>
        <Shield size={16} strokeWidth={2} />
        <span>
          <span className={hub.privacyBannerStrong}>隐私保护：</span>
          只显示用户主动发布到 Hub 的 bot 与字段。标记为「仅本地」的 bot 永远不会出现在这里。
        </span>
      </div>

      {/* Top-level stats */}
      <div className={hub.statsStrip}>
        <StatBox label="在线主机"      value={stats.onlineHosts} suffix={`/${stats.totalHosts}`} accent />
        <StatBox label="可见 Bot 在线" value={stats.online}      suffix={`/${stats.visibleBots}`} accent />
        <StatBox label="已发布 Bot"    value={stats.visibleBots} />
        <StatBox label="未公开 Bot"    value={stats.hiddenBots}  hint="对 Hub 不可见" muted />
      </div>

      {/* Hosts */}
      <div className={hub.sectionHeading}>
        <h2>注册主机</h2>
        <span className={hub.meta}>{hosts.length} 台 · 共 {stats.visibleBots} 个公开 bot</span>
      </div>

      <div className={hub.hostGrid}>
        {hosts.map((host) => (
          <HostCard key={host.hostId} host={host} onOpen={() => navigate(`/hub/hosts/${host.hostId}`)} />
        ))}
        {hosts.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--text-2)', textAlign: 'center' }}>
            当前主机没有任何 bot。
          </div>
        ) : null}
      </div>

      <div style={{ height: 24 }} />
    </>
  );
}

const EMPTY_HOSTS: HubHost[] = [];

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

interface StatBoxProps {
  label:   string;
  value:   number;
  suffix?: string;
  hint?:   string;
  accent?: boolean;
  muted?:  boolean;
}

function StatBox({ label, value, suffix, hint, accent, muted }: StatBoxProps) {
  return (
    <div className={hub.statBox}>
      <div className={hub.statLabel}>{label}</div>
      <div className={hub.statValue}>
        <span className={accent ? hub.statValueAccent : muted ? hub.statValueMuted : ''}>{value}</span>
        {suffix ? <span className={hub.statValueMuted}>{suffix}</span> : null}
      </div>
      {hint ? <div className={hub.statHint}>{hint}</div> : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */

interface HostCardProps {
  host:   HubHost;
  onOpen: () => void;
}

function HostCard({ host, onOpen }: HostCardProps) {
  const initials = (host.hostName || host.hostId).slice(0, 1).toUpperCase();
  return (
    <div className={hub.hostCard} onClick={onOpen} role="button" tabIndex={0}>
      <div className={hub.hostHead}>
        <div className={hub.hostAvatar}>{initials}</div>
        <div className={hub.hostNameBlock}>
          <div className={hub.hostMachine}>{host.hostName}</div>
          <div className={hub.hostOwner}>
            <Monitor size={11} strokeWidth={2} style={{ marginRight: 4, verticalAlign: -1 }} />
            {host.hostId}
          </div>
        </div>
        <span className={`${hub.hostStatusPill} ${host.online ? hub.hostStatusOnline : hub.hostStatusOffline}`}>
          <span className={hub.hostStatusDot} />
          {host.online ? 'ONLINE' : 'OFFLINE'}
        </span>
      </div>

      <div className={hub.hostBotChips}>
        {host.visibleBots.map((b) => (
          <BotChip key={b.name} bot={b} />
        ))}
        {host.hiddenBotCount > 0 ? (
          <span className={hub.hiddenChip} title="主机所有者标记为「仅本地」的 bot 数量">
            <EyeOff size={11} strokeWidth={2} />
            +{host.hiddenBotCount} 隐藏
          </span>
        ) : null}
      </div>

      <div className={hub.hostMeta}>
        <span className={hub.hostMetaItem}>
          <Monitor size={11} strokeWidth={2} />
          {host.os}
        </span>
        <span className={hub.hostMetaItem}>
          <Cloud size={11} strokeWidth={2} />
          {host.agentVersion}
        </span>
        <span className={hub.hostMetaItem} style={{ marginLeft: 'auto' }}>
          {host.online ? '在线' : `最后活跃 ${formatLastSeen(host.lastSeen)}`}
        </span>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */

function BotChip({ bot }: { bot: HubBot }) {
  const map: Record<HubBot['status'], string> = {
    online:    hub.botChipOnline,
    stopped:   hub.botChipStopped,
    launching: hub.botChipLaunching,
    error:     hub.botChipError,
    unknown:   hub.botChipStopped,
  };
  return (
    <span className={`${hub.botChip} ${map[bot.status]}`}>
      <span className={hub.botChipDot} />
      {bot.name}
    </span>
  );
}
