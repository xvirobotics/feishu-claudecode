import { useMemo } from 'react';
import type { BotStatus, AgentMetadata } from '../../store';
import { useStore } from '../../store';
import { ActivityTimeline } from './ActivityTimeline';
import s from './AgentDetailPanel.module.css';

/* ── Icons ── */

function IconChat() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

/* ── Helpers ── */

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

const COLORS = ['#00d68f', '#00b4d8', '#22c55e', '#14b8a6', '#06b6d4', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899'];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* ── Props ── */

interface AgentDetailPanelProps {
  bot: BotStatus;
  agentKey: string;
  activeTab: 'activity' | 'stats' | 'info';
  onTabChange: (tab: 'activity' | 'stats' | 'info') => void;
  onOpenChat: (botName: string) => void;
}

export function AgentDetailPanel({ bot, agentKey, activeTab, onTabChange, onOpenChat }: AgentDetailPanelProps) {
  // Determine if this is a sub-agent
  const isSubAgent = agentKey.includes('/');
  const subAgentName = isSubAgent ? agentKey.split('/')[1] : null;
  const subAgent: AgentMetadata | undefined = isSubAgent
    ? bot.agents?.find((a) => a.name === subAgentName)
    : undefined;

  const displayName = isSubAgent ? (subAgent?.name || subAgentName || agentKey) : bot.name;
  const description = isSubAgent ? subAgent?.description : bot.description;
  const color = COLORS[hash(displayName) % COLORS.length];

  const successRate = useMemo(() => {
    if (bot.stats.totalTasks === 0) return 0;
    return Math.round((bot.stats.completedTasks / bot.stats.totalTasks) * 100);
  }, [bot.stats]);

  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.avatarLarge} style={{ background: `${color}18`, color }}>
          {displayName.charAt(0).toUpperCase()}
        </div>
        <div className={s.headerInfo}>
          <div className={s.nameRow}>
            <h2 className={s.name}>{displayName}</h2>
            <span className={`${s.statusBadge} ${s[`status-${bot.status}`]}`}>
              {bot.status}
            </span>
          </div>
          {isSubAgent && (
            <div className={s.parentLabel}>
              member of <strong>{bot.name}</strong>
            </div>
          )}
          {!isSubAgent && (
            <div className={s.metaRow}>
              <span className={s.platform}>{bot.platform}</span>
              {bot.specialties && bot.specialties.length > 0 && (
                <div className={s.tags}>
                  {bot.specialties.map((tag) => (
                    <span key={tag} className={s.tag}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
          )}
          {description && <p className={s.description}>{description}</p>}
        </div>
        <button className={s.chatBtn} onClick={() => onOpenChat(bot.name)}>
          <IconChat />
          <span>Chat</span>
        </button>
      </div>

      {/* Tabs */}
      <div className={s.tabs}>
        {(['activity', 'stats', 'info'] as const).map((tab) => (
          <button
            key={tab}
            className={`${s.tab} ${activeTab === tab ? s.tabActive : ''}`}
            onClick={() => onTabChange(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={s.content}>
        {activeTab === 'activity' && (
          <ActivityTab bot={bot} />
        )}

        {activeTab === 'stats' && (
          <div className={s.statsTab}>
            <div className={s.statsGrid}>
              <div className={s.statCard}>
                <span className={s.statValue}>{bot.stats.totalTasks}</span>
                <span className={s.statLabel}>Total Tasks</span>
              </div>
              <div className={s.statCard}>
                <span className={`${s.statValue} ${s.statGreen}`}>{bot.stats.completedTasks}</span>
                <span className={s.statLabel}>Completed</span>
              </div>
              <div className={s.statCard}>
                <span className={`${s.statValue} ${s.statRed}`}>{bot.stats.failedTasks}</span>
                <span className={s.statLabel}>Failed</span>
              </div>
              <div className={s.statCard}>
                <span className={s.statValue}>${bot.stats.totalCostUsd.toFixed(2)}</span>
                <span className={s.statLabel}>Total Cost</span>
              </div>
            </div>

            {bot.stats.totalTasks > 0 && (
              <div className={s.progressSection}>
                <div className={s.progressHeader}>
                  <span className={s.progressLabel}>Success Rate</span>
                  <span className={s.progressValue}>{successRate}%</span>
                </div>
                <div className={s.progressBar}>
                  <div className={s.progressFill} style={{ width: `${successRate}%` }} />
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'info' && (
          <div className={s.infoTab}>
            {!isSubAgent && (
              <>
                <div className={s.infoRow}>
                  <span className={s.infoLabel}>Working Directory</span>
                  <code className={s.infoCode}>{bot.workingDirectory}</code>
                </div>
                <div className={s.infoRow}>
                  <span className={s.infoLabel}>Platform</span>
                  <span className={s.infoValue}>{bot.platform}</span>
                </div>
              </>
            )}

            {isSubAgent && subAgent && (
              <>
                {subAgent.model && (
                  <div className={s.infoRow}>
                    <span className={s.infoLabel}>Model</span>
                    <span className={s.infoValue}>{subAgent.model}</span>
                  </div>
                )}
                {subAgent.tools && (
                  <div className={s.infoRow}>
                    <span className={s.infoLabel}>Tools</span>
                    <div className={s.toolsList}>
                      {subAgent.tools.split(',').map((t) => (
                        <span key={t.trim()} className={s.toolTag}>{t.trim()}</span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {!isSubAgent && bot.agents && bot.agents.length > 0 && (
              <div className={s.subAgentSection}>
                <span className={s.infoLabel}>Sub-Agents ({bot.agents.length})</span>
                <div className={s.subAgentList}>
                  {bot.agents.map((agent) => (
                    <div key={agent.name} className={s.subAgentItem}>
                      <span className={s.subAgentDot} />
                      <div className={s.subAgentInfo}>
                        <span className={s.subAgentName}>{agent.name}</span>
                        {agent.description && (
                          <span className={s.subAgentDesc}>{agent.description}</span>
                        )}
                      </div>
                      {agent.model && <span className={s.subAgentModel}>{agent.model}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Activity Tab with active task + timeline ── */

function ActivityTab({ bot }: { bot: BotStatus }) {
  const activityEvents = useStore((s) => s.activityEvents);

  return (
    <div className={s.activityTab}>
      {bot.status === 'busy' && bot.currentTask && (
        <div className={s.activeTask}>
          <div className={s.taskHeader}>
            <span className={s.taskPulse} />
            <span className={s.taskLabel}>Running Task</span>
          </div>
          <div className={s.taskMeta}>
            <span className={s.taskMetaItem}>
              <IconClock />
              {formatDuration(bot.currentTask.durationMs)}
            </span>
            <span className={s.taskMetaItem}>
              Session: <code>{bot.currentTask.chatId.slice(0, 12)}...</code>
            </span>
          </div>
        </div>
      )}
      <ActivityTimeline events={activityEvents} botFilter={bot.name} />
    </div>
  );
}
