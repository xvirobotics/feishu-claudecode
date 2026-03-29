/* ============================================================
   AgentTooltip — Hover tooltip showing agent details
   ============================================================ */

import type { AgentSprite } from '../types';
import styles from './AgentTooltip.module.css';

interface AgentTooltipProps {
  agent: AgentSprite;
  screenX: number;
  screenY: number;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function AgentTooltip({ agent, screenX, screenY }: AgentTooltipProps) {
  const statusEmoji = agent.status === 'busy' ? '\u{1F7E1}' : agent.status === 'error' ? '\u{1F534}' : '\u{1F7E2}';

  return (
    <div
      className={styles.tooltip}
      style={{
        left: Math.min(screenX + 16, window.innerWidth - 220),
        top: Math.max(screenY - 10, 10),
      }}
    >
      <div className={styles.header}>
        <span className={styles.name}>{agent.botName}</span>
        <span className={styles.status}>{statusEmoji} {agent.status}</span>
      </div>
      {agent.description && <div className={styles.desc}>{agent.description}</div>}
      {agent.specialties && agent.specialties.length > 0 && (
        <div className={styles.tags}>
          {agent.specialties.map((s) => (
            <span key={s} className={styles.tag}>{s}</span>
          ))}
        </div>
      )}
      {agent.currentTask && (
        <div className={styles.task}>
          Working for {formatDuration(agent.currentTask.durationMs)}
        </div>
      )}
      {agent.stats && (
        <div className={styles.stats}>
          {agent.stats.totalTasks} tasks | {formatCost(agent.stats.totalCostUsd)}
        </div>
      )}
      <div className={styles.hint}>Click to chat</div>
    </div>
  );
}
