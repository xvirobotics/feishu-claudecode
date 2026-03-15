import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../store';

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function TeamDashboard() {
  const token = useStore(s => s.token);
  const teamStatus = useStore(s => s.teamStatus);
  const setTeamStatus = useStore(s => s.setTeamStatus);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/team/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTeamStatus(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, setTeamStatus]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loading && !teamStatus) {
    return <div className="team-dashboard"><div className="team-loading">Loading team status...</div></div>;
  }

  if (error && !teamStatus) {
    return <div className="team-dashboard"><div className="team-error">Error: {error}</div></div>;
  }

  const { bots, summary } = teamStatus!;

  return (
    <div className="team-dashboard">
      <div className="team-header">
        <h2>Agent Team</h2>
        <button className="team-refresh" onClick={fetchStatus} title="Refresh">&#x21bb;</button>
      </div>

      <div className="team-summary">
        <div className="summary-card">
          <span className="summary-value">{summary.totalBots}</span>
          <span className="summary-label">Total Agents</span>
        </div>
        <div className="summary-card summary-busy">
          <span className="summary-value">{summary.busyBots}</span>
          <span className="summary-label">Busy</span>
        </div>
        <div className="summary-card summary-idle">
          <span className="summary-value">{summary.idleBots}</span>
          <span className="summary-label">Idle</span>
        </div>
        <div className="summary-card">
          <span className="summary-value">{formatCost(summary.totalCostUsd)}</span>
          <span className="summary-label">Total Cost</span>
        </div>
        <div className="summary-card">
          <span className="summary-value">{summary.totalTasks}</span>
          <span className="summary-label">Total Tasks</span>
        </div>
      </div>

      <div className="team-grid">
        {bots.map(bot => (
          <div
            key={bot.name}
            className={`bot-card bot-${bot.status}`}
            onClick={() => {
              const store = useStore.getState();
              store.setBot(bot.name);
              store.setView('chat');
            }}
          >
            <div className="bot-card-header">
              <span className="bot-icon">{bot.icon || '\u{1F916}'}</span>
              <div className="bot-info">
                <span className="bot-name">{bot.name}</span>
                <span className="bot-platform">{bot.platform}</span>
              </div>
              <span className={`status-dot status-${bot.status}`} />
            </div>

            {bot.description && (
              <p className="bot-description">{bot.description}</p>
            )}

            {bot.specialties && bot.specialties.length > 0 && (
              <div className="bot-specialties">
                {bot.specialties.map(s => (
                  <span key={s} className="specialty-tag">{s}</span>
                ))}
              </div>
            )}

            {bot.currentTask && (
              <div className="bot-current-task">
                <span className="task-indicator" />
                <span className="task-info">
                  Running for {formatDuration(bot.currentTask.durationMs)}
                </span>
              </div>
            )}

            <div className="bot-stats">
              <span>{bot.stats.totalTasks} tasks</span>
              <span>{formatCost(bot.stats.totalCostUsd)}</span>
              {bot.stats.failedTasks > 0 && (
                <span className="failed-count">{bot.stats.failedTasks} failed</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
