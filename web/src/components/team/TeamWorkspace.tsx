import { useEffect, useCallback, useMemo, useState } from 'react';
import { useStore } from '../../store';
import type { BotStatus } from '../../store';
import { TeamTreePanel } from './TeamTreePanel';
import { AgentDetailPanel } from './AgentDetailPanel';
import { TeamChatPanel } from './TeamChatPanel';
import s from './TeamWorkspace.module.css';

/* ── Team status polling hook ── */

function useTeamPoller(intervalMs = 5000) {
  const token = useStore((st) => st.token);
  const setTeamStatus = useStore((st) => st.setTeamStatus);
  const setActivityEvents = useStore((st) => st.setActivityEvents);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch('/api/team/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (active) {
          setTeamStatus(data);
          setError('');
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load team status');
          setLoading(false);
        }
      }
    };

    // Fetch initial activity events (once)
    fetch('/api/activity/events?limit=50', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => { if (active) setActivityEvents(data.events || []); })
      .catch(() => {});

    poll();
    const id = setInterval(poll, intervalMs);
    return () => { active = false; clearInterval(id); };
  }, [token, intervalMs, setTeamStatus, setActivityEvents]);

  return { loading, error };
}

/* ── TeamWorkspace ── */

export function TeamWorkspace() {
  const teamStatus = useStore((st) => st.teamStatus);
  const selectedAgentKey = useStore((st) => st.selectedAgentKey);
  const setSelectedAgentKey = useStore((st) => st.setSelectedAgentKey);
  const teamChatBotName = useStore((st) => st.teamChatBotName);
  const setTeamChatBotName = useStore((st) => st.setTeamChatBotName);
  const teamDetailTab = useStore((st) => st.teamDetailTab);
  const setTeamDetailTab = useStore((st) => st.setTeamDetailTab);

  const { loading, error } = useTeamPoller();

  const bots = teamStatus?.bots || [];
  const summary = teamStatus?.summary;

  // Auto-select first bot if none selected
  useEffect(() => {
    if (!selectedAgentKey && bots.length > 0) {
      setSelectedAgentKey(bots[0].name);
    }
  }, [selectedAgentKey, bots, setSelectedAgentKey]);

  // Resolve selected bot
  const selectedBot: BotStatus | undefined = useMemo(() => {
    if (!selectedAgentKey) return undefined;
    const botName = selectedAgentKey.includes('/') ? selectedAgentKey.split('/')[0] : selectedAgentKey;
    return bots.find((b) => b.name === botName);
  }, [selectedAgentKey, bots]);

  const totalAgents = useMemo(() => bots.reduce((sum, b) => sum + (b.agents?.length || 0), 0), [bots]);

  const handleOpenChat = useCallback((botName: string) => {
    setTeamChatBotName(botName);
  }, [setTeamChatBotName]);

  const handleCloseChat = useCallback(() => {
    setTeamChatBotName(null);
  }, [setTeamChatBotName]);

  // Mobile state
  const [mobileView, setMobileView] = useState<'tree' | 'detail' | 'chat'>('tree');

  const handleMobileSelect = useCallback((key: string) => {
    setSelectedAgentKey(key);
    setMobileView('detail');
  }, [setSelectedAgentKey]);

  const handleMobileChat = useCallback((botName: string) => {
    setTeamChatBotName(botName);
    setMobileView('chat');
  }, [setTeamChatBotName]);

  const handleMobileBack = useCallback(() => {
    if (mobileView === 'chat') { setMobileView('detail'); setTeamChatBotName(null); }
    else if (mobileView === 'detail') setMobileView('tree');
  }, [mobileView, setTeamChatBotName]);

  /* ── Loading / Error ── */

  if (loading && !teamStatus) {
    return (
      <div className={s.loadingState}>
        <div className={s.spinner} />
        <span>Loading team...</span>
      </div>
    );
  }

  if (error && !teamStatus) {
    return (
      <div className={s.errorState}>
        <span className={s.errorIcon}>!</span>
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className={s.container}>
      {/* Status bar */}
      <div className={s.statusBar}>
        <div className={s.statusStats}>
          <span className={s.statChip}>
            <span className={s.statNum}>{summary?.totalBots || 0}</span> Bots
          </span>
          <span className={s.statDivider} />
          <span className={s.statChip}>
            <span className={s.statNum}>{totalAgents}</span> Sub-agents
          </span>
          <span className={s.statDivider} />
          {(summary?.busyBots || 0) > 0 && (
            <>
              <span className={`${s.statChip} ${s.statBusy}`}>
                <span className={s.busyPulse} />
                <span className={s.statNum}>{summary?.busyBots}</span> Busy
              </span>
              <span className={s.statDivider} />
            </>
          )}
          <span className={s.statChip}>
            ${(summary?.totalCostUsd || 0).toFixed(2)}
          </span>
        </div>

        {/* Mobile back button */}
        {mobileView !== 'tree' && (
          <button className={s.mobileBackBtn} onClick={handleMobileBack}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Desktop: three panels */}
      <div className={s.panels}>
        {/* Tree panel - hide on mobile unless 'tree' view */}
        <div className={`${s.treeWrap} ${mobileView !== 'tree' ? s.hideMobile : ''}`}>
          <TeamTreePanel
            bots={bots}
            selectedKey={selectedAgentKey}
            onSelect={(key) => {
              setSelectedAgentKey(key);
              // On mobile, navigate to detail
              setMobileView('detail');
            }}
          />
        </div>

        {/* Detail panel */}
        {selectedBot && selectedAgentKey && (
          <div className={`${s.detailWrap} ${mobileView !== 'detail' ? s.hideMobile : ''}`}>
            <AgentDetailPanel
              bot={selectedBot}
              agentKey={selectedAgentKey}
              activeTab={teamDetailTab}
              onTabChange={setTeamDetailTab}
              onOpenChat={(botName) => {
                handleOpenChat(botName);
                setMobileView('chat');
              }}
            />
          </div>
        )}

        {/* Empty state when no bot selected */}
        {!selectedBot && (
          <div className={`${s.emptyDetail} ${mobileView !== 'detail' ? s.hideMobile : ''}`}>
            <div className={s.emptyIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
              </svg>
            </div>
            <span>Select an agent to view details</span>
          </div>
        )}

        {/* Chat panel */}
        {teamChatBotName && (
          <div className={`${s.chatWrap} ${mobileView !== 'chat' ? s.hideMobile : ''}`}>
            <TeamChatPanel
              botName={teamChatBotName}
              onClose={handleCloseChat}
            />
          </div>
        )}
      </div>
    </div>
  );
}
