/* ============================================================
   PixelOffice — 2D Pixel art virtual office for the Team tab.
   Each bot gets its own room with sub-agents at desks inside.
   Click any agent (lead or sub-agent) to open a chat session.
   ============================================================ */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useStore, type BotStatus, type TeamStatus } from '../../store';
import { OfficeCanvas } from './canvas/OfficeCanvas';
import { generateLayout } from './engine/layout-generator';
import { agentColor } from './canvas/sprites';
import { ChatSidePanel } from './ui/ChatSidePanel';
import { AgentTooltip } from './ui/AgentTooltip';
import type { AgentSprite } from './types';
import styles from './PixelOffice.module.css';

/* ── Team status polling hook ── */

function useTeamPoller(intervalMs = 5000) {
  const token = useStore((s) => s.token);
  const teamStatus = useStore((s) => s.teamStatus);
  const setTeamStatus = useStore((s) => s.setTeamStatus);
  const [loading, setLoading] = useState(!teamStatus);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/team/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: TeamStatus = await res.json();
        if (active) {
          setTeamStatus(data);
          setError(null);
          setLoading(false);
        }
      } catch (err: any) {
        if (active) setError(err.message);
      }
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [token, setTeamStatus, intervalMs]);

  return { teamStatus, loading, error };
}

/* ── Main component ── */

export function PixelOffice() {
  const { teamStatus, loading, error } = useTeamPoller();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // Count total sub-agents for summary
  const totalSubAgents = useMemo(() => {
    if (!teamStatus) return 0;
    return teamStatus.bots.reduce((sum, b) => sum + (b.agents?.length || 0), 0);
  }, [teamStatus]);

  // Generate layout: each bot gets a room with its sub-agents
  const layout = useMemo(() => {
    if (!teamStatus) return null;
    const bots = teamStatus.bots.map((b) => ({
      name: b.name,
      specialties: b.specialties,
      platform: b.platform,
      agents: b.agents?.map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model,
      })),
    }));
    return generateLayout(bots);
  }, [teamStatus?.bots.map((b) => `${b.name}:${b.agents?.length || 0}`).join(',')]);

  // Build agent sprites for leads AND sub-agents
  const agents = useMemo(() => {
    const map = new Map<string, AgentSprite>();
    if (!teamStatus || !layout) return map;

    for (const bot of teamStatus.bots) {
      // Lead bot sprite
      const leadPos = layout.agentPositions.get(bot.name);
      if (leadPos) {
        map.set(bot.name, {
          botName: bot.name,
          position: leadPos.seat,
          deskPosition: leadPos.desk,
          status: bot.status,
          color: agentColor(bot.name),
          description: bot.description,
          specialties: bot.specialties,
          platform: bot.platform,
          currentTask: bot.currentTask
            ? { durationMs: bot.currentTask.durationMs }
            : undefined,
          stats: bot.stats
            ? {
                totalTasks: bot.stats.totalTasks,
                completedTasks: bot.stats.completedTasks,
                totalCostUsd: bot.stats.totalCostUsd,
              }
            : undefined,
          isLead: true,
        });
      }

      // Sub-agent sprites
      if (bot.agents) {
        for (const sub of bot.agents) {
          const key = `${bot.name}/${sub.name}`;
          const subPos = layout.agentPositions.get(key);
          if (!subPos) continue;
          map.set(key, {
            botName: sub.name,
            position: subPos.seat,
            deskPosition: subPos.desk,
            status: 'idle', // sub-agents don't have independent status
            color: agentColor(sub.name),
            description: sub.description,
            platform: sub.model || 'sub-agent',
            isLead: false,
            parentBot: bot.name,
          });
        }
      }
    }
    return map;
  }, [teamStatus, layout]);

  // Track mouse for tooltip
  useEffect(() => {
    const handler = (e: MouseEvent) => setMousePos({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  const handleSelectAgent = useCallback((name: string | null) => {
    setSelectedAgent(name);
  }, []);

  const handleHoverAgent = useCallback((name: string | null) => {
    setHoveredAgent(name);
  }, []);

  const handleCloseChat = useCallback(() => {
    setSelectedAgent(null);
  }, []);

  // For chat panel: resolve the actual bot name to chat with
  // Sub-agents chat through their parent bot
  const chatBotName = useMemo(() => {
    if (!selectedAgent) return null;
    const sprite = agents.get(selectedAgent);
    return sprite?.parentBot || selectedAgent;
  }, [selectedAgent, agents]);

  const selectedBotStatus = teamStatus?.bots.find((b) => b.name === chatBotName);
  const hoveredAgentSprite = hoveredAgent ? agents.get(hoveredAgent) : null;

  if (loading && !teamStatus) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading office...</div>
      </div>
    );
  }

  if (error && !teamStatus) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Error: {error}</div>
      </div>
    );
  }

  if (!layout || !teamStatus) return null;

  const { summary } = teamStatus;

  return (
    <div className={styles.container}>
      {/* Status bar */}
      <div className={styles.statusBar}>
        <span className={styles.stat}>
          <span className={styles.statValue}>{summary.totalBots}</span> Bots
        </span>
        <span className={styles.stat}>
          <span className={styles.statValue}>{totalSubAgents}</span> Sub-agents
        </span>
        <span className={styles.stat}>
          <span className={styles.statBusy}>{summary.busyBots}</span> Busy
        </span>
        <span className={styles.stat}>
          <span className={styles.statIdle}>{summary.idleBots}</span> Idle
        </span>
        <span className={styles.hint}>Click agent to chat | Click floor to move</span>
      </div>

      {/* Main content */}
      <div className={styles.main}>
        <div className={styles.canvasArea}>
          <OfficeCanvas
            tileMap={layout.tileMap}
            rooms={layout.rooms}
            agents={agents}
            playerSpawn={layout.playerSpawn}
            selectedAgent={selectedAgent}
            onSelectAgent={handleSelectAgent}
            onHoverAgent={handleHoverAgent}
            hoveredAgent={hoveredAgent}
          />
        </div>

        {/* Chat side panel — always talks to the parent bot */}
        {chatBotName && (
          <ChatSidePanel
            botName={chatBotName}
            botStatus={selectedBotStatus}
            onClose={handleCloseChat}
          />
        )}
      </div>

      {/* Hover tooltip */}
      {hoveredAgentSprite && hoveredAgent !== selectedAgent && (
        <AgentTooltip
          agent={hoveredAgentSprite}
          screenX={mousePos.x}
          screenY={mousePos.y}
        />
      )}
    </div>
  );
}
