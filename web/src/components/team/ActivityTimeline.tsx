import { useMemo } from 'react';
import type { ActivityEvent } from '../../types';
import s from './ActivityTimeline.module.css';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return isToday ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

function EventIcon({ type }: { type: ActivityEvent['type'] }) {
  if (type === 'task_completed') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (type === 'task_failed') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-error, #ef4444)" strokeWidth="2.5" strokeLinecap="round">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

interface Props {
  events: ActivityEvent[];
  botFilter?: string;
}

export function ActivityTimeline({ events, botFilter }: Props) {
  const safeEvents = Array.isArray(events) ? events : [];
  const filtered = useMemo(() => {
    if (!botFilter) return safeEvents;
    return safeEvents.filter((e) => e.botName === botFilter);
  }, [safeEvents, botFilter]);

  if (filtered.length === 0) {
    return (
      <div className={s.empty}>
        <span className={s.emptyText}>No activity yet</span>
      </div>
    );
  }

  return (
    <div className={s.timeline}>
      {filtered.map((event) => (
        <div key={event.id} className={`${s.event} ${s[event.type]}`}>
          <div className={s.iconCol}>
            <EventIcon type={event.type} />
            <div className={s.line} />
          </div>
          <div className={s.content}>
            <div className={s.header}>
              <span className={s.botName}>{event.botName}</span>
              <span className={s.time}>{formatTime(event.timestamp)}</span>
            </div>
            {event.prompt && (
              <div className={s.prompt}>{event.prompt.slice(0, 100)}</div>
            )}
            <div className={s.meta}>
              {event.durationMs != null && (
                <span className={s.metaItem}>{formatDuration(event.durationMs)}</span>
              )}
              {event.costUsd != null && (
                <span className={s.metaItem}>${event.costUsd.toFixed(3)}</span>
              )}
              {event.errorMessage && (
                <span className={`${s.metaItem} ${s.errorMsg}`}>
                  {event.errorMessage.slice(0, 60)}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
