/* ============================================================
   PixelOffice — 2D Pixel art virtual office for the Team tab.
   Replaces TeamDashboard with an interactive pixel office where
   each agent sits at a desk and the user can walk around and chat.
   ============================================================ */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useStore, type BotStatus, type TeamStatus } from '../../store';
import { OfficeCanvas } from './canvas/OfficeCanvas';
import { generateLayout } from './engine/layout-generator';
import { agentColor } from './canvas/sprites';
import { worldToScreen } from './engine/interaction';
import { ChatSidePanel } from './ui/ChatSidePanel';
import { AgentTooltip } from './ui/AgentTooltip';
import type { AgentSprite, Position } from './types';
import { TILE_SIZE } from './types';
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

  // Generate layout from bot names
  const layout = useMemo(() => {
    if (!teamStatus) return null;
    const bots = teamStatus.bots.map((b) => ({
      name: b.name,
      specialties: b.specialties,
      platform: b.platform,
    }));
    return generateLayout(bots);
  }, [teamStatus?.bots.length]); // only regenerate when bot count changes

  // Build agent sprites from team status + layout positions
  const agents = useMemo(() => {
    const map = new Map<string, AgentSprite>();
    if (!teamStatus || !layout) return map;

    for (const bot of teamStatus.bots) {
      const pos = layout.agentPositions.get(bot.name);
      if (!pos) continue;
      map.set(bot.name, {
        botName: bot.name,
        position: pos.seat,
        deskPosition: pos.desk,
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
      });
    }
    return map;
  }, [teamStatus, layout]);

  // Track mouse for tooltip positioning
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

  // Find bot status for selected/hovered agent
  const selectedBotStatus = teamStatus?.bots.find((b) => b.name === selectedAgent);
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
          <span className={styles.statValue}>{summary.totalBots}</span> Agents
        </span>
        <span className={styles.stat}>
          <span className={styles.statBusy}>{summary.busyBots}</span> Busy
        </span>
        <span className={styles.stat}>
          <span className={styles.statIdle}>{summary.idleBots}</span> Idle
        </span>
        <span className={styles.stat}>
          ${summary.totalCostUsd.toFixed(2)} cost
        </span>
        <span className={styles.hint}>Click agent to chat | Click floor to move</span>
      </div>

      {/* Main content: canvas + optional side panel */}
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

        {/* Chat side panel */}
        {selectedAgent && (
          <ChatSidePanel
            botName={selectedAgent}
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
