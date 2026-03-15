import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { useWebSocket } from '../hooks/useWebSocket';
import type { BotInfo, ChatGroup, ChatSession } from '../types';
import { GroupCreateDialog } from './chat';
import s from './Layout.module.css';

/* ═══════════════════════════════════════════════════════════════
   V2 Icons — thin, elegant, 1.5px stroke
   ═══════════════════════════════════════════════════════════════ */

const I = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

function IconPlus() {
  return <I d="M12 5v14M5 12h14" />;
}
function IconX({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
function IconMenu() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
function IconBack() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}
function IconChat() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}
function IconMemory() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}
function IconTeam() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}
function IconPanelLeft() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Gradient Ring Avatar — SVG with gradient stroke ring + initial
   ═══════════════════════════════════════════════════════════════ */

const GRADIENT_PAIRS = [
  ['#10b981', '#34d399'],
  ['#14b8a6', '#2dd4bf'],
  ['#06b6d4', '#22d3ee'],
  ['#0ea5e9', '#38bdf8'],
  ['#84cc16', '#a3e635'],
  ['#22c55e', '#4ade80'],
  ['#f59e0b', '#fbbf24'],
  ['#059669', '#10b981'],
  ['#0d9488', '#14b8a6'],
  ['#65a30d', '#84cc16'],
];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function GradientAvatar({ name, size = 44 }: { name: string; size?: number }) {
  const h = hash(name);
  const pair = GRADIENT_PAIRS[h % GRADIENT_PAIRS.length];
  const id = `ga-${name.replace(/\W/g, '')}`;
  const initial = name.charAt(0).toUpperCase();
  const r = size / 2;
  const strokeW = size > 36 ? 2.5 : 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={pair[0]} />
          <stop offset="100%" stopColor={pair[1]} />
        </linearGradient>
      </defs>
      <circle cx={r} cy={r} r={r - strokeW} fill="none" stroke={`url(#${id})`} strokeWidth={strokeW} />
      <text
        x={r}
        y={r}
        textAnchor="middle"
        dominantBaseline="central"
        fill={pair[0]}
        fontSize={size * 0.38}
        fontWeight="600"
        fontFamily="Inter, -apple-system, sans-serif"
      >
        {initial}
      </text>
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════ */

function relTime(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString();
}

function sessionPreview(session: ChatSession): { text: string; status?: string } {
  if (session.messages.length === 0) return { text: 'Start a conversation' };
  const last = session.messages[session.messages.length - 1];
  if (last.type === 'user') return { text: (last.text || '').slice(0, 60) };
  if (last.state) {
    if (last.state.status === 'thinking') return { text: '', status: 'thinking' };
    if (last.state.status === 'running') return { text: '', status: 'running' };
    if (last.state.status === 'error') return { text: last.state.errorMessage?.slice(0, 50) || 'Error', status: 'error' };
    return { text: (last.text || 'Done').slice(0, 60) };
  }
  return { text: (last.text || '').slice(0, 60) };
}

/* ═══════════════════════════════════════════════════════════════
   BotCard — each bot rendered as a card
   ═══════════════════════════════════════════════════════════════ */

function BotCard({
  bot,
  sessions: botSessions,
  activeSessionId,
  activeBotName,
  activeView,
  onSessionClick,
  onNewSession,
  onDeleteSession,
}: {
  bot: BotInfo;
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeBotName: string | null;
  activeView: string;
  onSessionClick: (id: string, botName: string) => void;
  onNewSession: (botName: string) => void;
  onDeleteSession: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isActive = activeBotName === bot.name && activeView === 'chat';
  const sorted = [...botSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const latest = sorted[0] || null;
  const preview = latest ? sessionPreview(latest) : null;
  const hasMultiple = sorted.length > 1;

  return (
    <div className={s.botCard} data-active={isActive || undefined}>
      {/* Main row */}
      <div
        className={s.botRow}
        onClick={() => {
          if (latest) onSessionClick(latest.id, bot.name);
          else onNewSession(bot.name);
        }}
      >
        <div className={s.avatar}>
          <GradientAvatar name={bot.name} size={44} />
          <span className={`${s.statusDot} ${s.statusOnline}`} />
        </div>

        <div className={s.botInfo}>
          <div className={s.botNameRow}>
            <span className={s.botName}>{bot.name}</span>
            {bot.platform === 'web' && <span className={s.platformBadge}>Web</span>}
            {latest && <span className={s.botTime}>{relTime(latest.updatedAt)}</span>}
          </div>
          <div className={s.botPreview}>
            {preview?.status === 'thinking' && (
              <span className={s.previewThinking}>
                <span className={s.dot} /><span className={s.dot} /><span className={s.dot} />
                Thinking...
              </span>
            )}
            {preview?.status === 'running' && (
              <span className={s.previewRunning}>
                <span className={s.miniSpinner} />
                Running...
              </span>
            )}
            {preview?.status === 'error' && (
              <span className={s.previewError}>{preview.text}</span>
            )}
            {!preview?.status && (
              <span>{preview?.text || bot.description || 'Ready'}</span>
            )}
          </div>
        </div>

        <button
          className={s.addBtn}
          onClick={(e) => { e.stopPropagation(); onNewSession(bot.name); }}
          title="New chat"
        >
          <IconPlus />
        </button>
      </div>

      {/* Expand toggle if multiple sessions */}
      {hasMultiple && (
        <button
          className={s.expandToggle}
          onClick={() => setExpanded(!expanded)}
        >
          <span className={s.expandLabel}>{sorted.length} chats</span>
          <svg
            width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      )}

      {/* Session sub-list */}
      {expanded && hasMultiple && (
        <div className={s.sessionList}>
          {sorted.map((session) => (
            <div
              key={session.id}
              className={s.sessionItem}
              data-active={activeSessionId === session.id || undefined}
              onClick={() => onSessionClick(session.id, bot.name)}
            >
              <span className={s.sessionDash} />
              <span className={s.sessionTitle}>{session.title}</span>
              <span className={s.sessionTime}>{relTime(session.updatedAt)}</span>
              <button
                className={s.sessionDel}
                onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                title="Close"
              >
                <IconX size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   GroupCard — each group rendered as a card
   ═══════════════════════════════════════════════════════════════ */

function GroupCard({
  group,
  sessions: groupSessions,
  activeSessionId,
  activeView,
  onSessionClick,
  onNewSession,
  onDelete,
}: {
  group: ChatGroup;
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeView: string;
  onSessionClick: (id: string) => void;
  onNewSession: (group: ChatGroup) => void;
  onDelete: (groupId: string) => void;
}) {
  const sorted = [...groupSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const latest = sorted[0] || null;
  const isActive = latest && activeSessionId === latest.id && activeView === 'chat';

  return (
    <div className={s.botCard} data-active={isActive || undefined}>
      <div
        className={s.botRow}
        onClick={() => {
          if (latest) onSessionClick(latest.id);
          else onNewSession(group);
        }}
      >
        <div className={s.avatar}>
          <GradientAvatar name={group.name} size={44} />
        </div>
        <div className={s.botInfo}>
          <div className={s.botNameRow}>
            <span className={s.botName}>{group.name}</span>
            <span className={s.platformBadge}>Group</span>
          </div>
          <div className={s.botPreview}>
            <span>{group.members.join(', ')}</span>
          </div>
        </div>
        <button
          className={s.addBtn}
          onClick={(e) => { e.stopPropagation(); onDelete(group.id); }}
          title="Delete group"
          style={{ opacity: 1 }}
        >
          <IconX size={12} />
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Layout — the shell
   Desktop: sidebar + main side-by-side
   Mobile: native stack navigation (list ↔ chat) + bottom tabs
   ═══════════════════════════════════════════════════════════════ */

interface LayoutProps { children: ReactNode; }

export function Layout({ children }: LayoutProps) {
  const navigate = useNavigate();
  const activeView = useStore((s) => s.activeView);
  const setView = useStore((s) => s.setView);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const connected = useStore((s) => s.connected);
  const bots = useStore((s) => s.bots);
  const activeBotName = useStore((s) => s.activeBotName);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const setBot = useStore((s) => s.setBot);
  const createSession = useStore((s) => s.createSession);
  const deleteSession = useStore((s) => s.deleteSession);

  const groups = useStore((s) => s.groups);
  const createGroupSession = useStore((s) => s.createGroupSession);

  const { send } = useWebSocket();

  const [showGroupDialog, setShowGroupDialog] = useState(false);

  /* ── Mobile detection ── */
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ── Mobile: push/pop navigation state ── */
  const [mobileShowChat, setMobileShowChat] = useState(false);

  const sessionsByBot = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    for (const session of sessions.values()) {
      const list = map.get(session.botName) || [];
      list.push(session);
      map.set(session.botName, list);
    }
    return map;
  }, [sessions]);

  const handleSessionClick = useCallback((id: string, botName: string) => {
    setActiveSession(id);
    setBot(botName);
    setView('chat');
    navigate('/');
    setMobileShowChat(true);
  }, [setActiveSession, setBot, setView, navigate]);

  const handleNewSession = useCallback((botName: string) => {
    createSession(botName);
    setView('chat');
    navigate('/');
    setMobileShowChat(true);
  }, [createSession, setView, navigate]);

  const handleDeleteSession = useCallback((id: string) => { deleteSession(id); }, [deleteSession]);

  const handleMobileBack = useCallback(() => { setMobileShowChat(false); }, []);

  const handleNav = useCallback((view: 'chat' | 'memory' | 'settings' | 'team', path: string) => {
    setView(view);
    navigate(path);
    setMobileShowChat(false);
  }, [setView, navigate]);

  const activeBot = bots.find((b) => b.name === activeBotName);

  // Group sessions by groupId
  const sessionsByGroup = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    for (const session of sessions.values()) {
      if (session.groupId) {
        const list = map.get(session.groupId) || [];
        list.push(session);
        map.set(session.groupId, list);
      }
    }
    return map;
  }, [sessions]);

  const handleGroupSessionClick = useCallback((id: string) => {
    setActiveSession(id);
    setView('chat');
    navigate('/');
    setMobileShowChat(true);
  }, [setActiveSession, setView, navigate]);

  const handleNewGroupSession = useCallback((group: ChatGroup) => {
    createGroupSession(group);
    setView('chat');
    navigate('/');
    setMobileShowChat(true);
  }, [createGroupSession, setView, navigate]);

  const handleDeleteGroup = useCallback((groupId: string) => {
    send({ type: 'delete_group', groupId });
  }, [send]);

  /* ── Shared bot list ── */
  const botList = (
    <>
      {bots.length === 0 ? (
        <div className={s.emptyAgents}>
          {connected ? 'No agents configured' : 'Connecting...'}
        </div>
      ) : (
        bots.map((bot) => (
          <BotCard
            key={bot.name}
            bot={bot}
            sessions={sessionsByBot.get(bot.name) || []}
            activeSessionId={activeSessionId}
            activeBotName={activeBotName}
            activeView={activeView}
            onSessionClick={handleSessionClick}
            onNewSession={handleNewSession}
            onDeleteSession={handleDeleteSession}
          />
        ))
      )}

      {/* Groups section */}
      {groups.length > 0 && (
        <>
          <div className={s.agentsHeader} style={{ padding: '14px 10px 6px' }}>
            <span className={s.agentsLabel}>Groups</span>
          </div>
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              sessions={sessionsByGroup.get(group.id) || []}
              activeSessionId={activeSessionId}
              activeView={activeView}
              onSessionClick={handleGroupSessionClick}
              onNewSession={handleNewGroupSession}
              onDelete={handleDeleteGroup}
            />
          ))}
        </>
      )}

      {/* New Group button */}
      {bots.length >= 2 && (
        <button className={s.expandToggle} style={{ padding: '10px 14px' }} onClick={() => setShowGroupDialog(true)}>
          <IconPlus />
          <span>New Group</span>
        </button>
      )}
    </>
  );

  /* ═══════════════════════════════════════════════════════════════
     MOBILE LAYOUT — native stack navigation
     ═══════════════════════════════════════════════════════════════ */

  if (isMobile) {
    const showingChat = activeView === 'chat' && mobileShowChat;

    return (
      <div className={s.mobileShell}>
        {/* ── Chat header (back + avatar + name) ── */}
        {showingChat && (
          <div className={s.mobileHeader}>
            <button className={s.mobileBackBtn} onClick={handleMobileBack}>
              <IconBack />
            </button>
            {activeBot && (
              <div className={s.mobileHeaderBot}>
                <GradientAvatar name={activeBot.name} size={30} />
                <span className={s.mobileHeaderName}>{activeBot.name}</span>
              </div>
            )}
            <span className={`${s.mobileHeaderDot} ${connected ? s.connOn : s.connOff}`} />
          </div>
        )}

        {/* ── List header (Chats / Memory / Settings) ── */}
        {!showingChat && (
          <div className={s.mobileListHeader}>
            <div className={s.mobileListBrand}>
              <div className={s.logoMark}>M</div>
              <span className={s.mobileListTitle}>
                {activeView === 'chat' ? 'Chats' : activeView === 'memory' ? 'Memory' : activeView === 'team' ? 'Team' : 'Settings'}
              </span>
            </div>
            {activeView === 'chat' && (
              <div className={s.connIndicator}>
                <span className={`${s.connDot} ${connected ? s.connOn : s.connOff}`} />
                <span className={s.connText}>{connected ? 'Live' : 'Offline'}</span>
              </div>
            )}
          </div>
        )}

        {/* ── Content area ── */}
        {activeView === 'chat' && !mobileShowChat ? (
          <div className={s.mobileChatList}>{botList}</div>
        ) : (
          <main className={s.mobileMain}>{children}</main>
        )}

        {/* ── Bottom tab bar (hidden when in active chat) ── */}
        {!showingChat && (
          <nav className={s.mobileTabBar}>
            <button
              className={`${s.mobileTab} ${activeView === 'chat' ? s.mobileTabActive : ''}`}
              onClick={() => handleNav('chat', '/')}
            >
              <IconChat />
              <span>Chats</span>
            </button>
            <button
              className={`${s.mobileTab} ${activeView === 'team' ? s.mobileTabActive : ''}`}
              onClick={() => handleNav('team', '/team')}
            >
              <IconTeam />
              <span>Team</span>
            </button>
            <button
              className={`${s.mobileTab} ${activeView === 'memory' ? s.mobileTabActive : ''}`}
              onClick={() => handleNav('memory', '/memory')}
            >
              <IconMemory />
              <span>Memory</span>
            </button>
            <button
              className={`${s.mobileTab} ${activeView === 'settings' ? s.mobileTabActive : ''}`}
              onClick={() => handleNav('settings', '/settings')}
            >
              <IconSettings />
              <span>Settings</span>
            </button>
          </nav>
        )}

        {/* Group create dialog */}
        {showGroupDialog && (
          <GroupCreateDialog onClose={() => setShowGroupDialog(false)} onSend={send} />
        )}
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════
     DESKTOP LAYOUT — sidebar + main
     ═══════════════════════════════════════════════════════════════ */

  return (
    <div className={s.shell}>
      {/* Ambient orbs */}
      <div className={s.orb1} />
      <div className={s.orb2} />

      {/* Hamburger for collapsed sidebar */}
      {!sidebarOpen && (
        <button className={s.hamburger} onClick={toggleSidebar}>
          <IconMenu />
        </button>
      )}

      {/* ═══ Sidebar ═══ */}
      <aside className={`${s.sidebar} ${!sidebarOpen ? s.sidebarHidden : ''}`}>
        {/* Brand */}
        <div className={s.brand}>
          <div className={s.logo}>
            <div className={s.logoMark}>M</div>
            <span className={s.logoType}>MetaBot</span>
          </div>
          <button className={s.panelBtn} onClick={toggleSidebar}>
            <IconPanelLeft />
          </button>
        </div>

        {/* Agents header */}
        <div className={s.agentsHeader}>
          <span className={s.agentsLabel}>Agents</span>
          <div className={s.connIndicator}>
            <span className={`${s.connDot} ${connected ? s.connOn : s.connOff}`} />
            <span className={s.connText}>{connected ? 'Live' : 'Offline'}</span>
          </div>
        </div>

        {/* Bot list */}
        <div className={s.agentsList}>{botList}</div>

        {/* Bottom nav */}
        <nav className={s.bottomBar}>
          <button
            className={`${s.navBtn} ${activeView === 'team' ? s.navActive : ''}`}
            onClick={() => handleNav('team', '/team')}
          >
            <IconTeam />
            <span>Team</span>
          </button>
          <button
            className={`${s.navBtn} ${activeView === 'memory' ? s.navActive : ''}`}
            onClick={() => handleNav('memory', '/memory')}
          >
            <IconMemory />
            <span>Memory</span>
          </button>
          <button
            className={`${s.navBtn} ${activeView === 'settings' ? s.navActive : ''}`}
            onClick={() => handleNav('settings', '/settings')}
          >
            <IconSettings />
            <span>Settings</span>
          </button>
        </nav>
      </aside>

      {/* ═══ Main content ═══ */}
      <main className={s.main}>{children}</main>

      {/* Group create dialog */}
      {showGroupDialog && (
        <GroupCreateDialog onClose={() => setShowGroupDialog(false)} onSend={send} />
      )}
    </div>
  );
}
