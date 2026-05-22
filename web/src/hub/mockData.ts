/* ============================================================
   hub/mockData.ts — shared types + format helpers.

   Historically this file also contained MOCK_HOSTS for the
   visual-only mockup branch. The real data now arrives from
   `useHubHosts` / `useHubHost` in `useHub.ts`; only the type
   exports and the two pure formatters survived the port.
============================================================ */

export type HubBotStatus = 'online' | 'stopped' | 'launching' | 'error' | 'unknown';

export interface HubBot {
  name:               string;
  status:             HubBotStatus;
  uptimeMs?:          number;
  cpu?:               number;
  memMb?:             number;
  restarts?:          number;
  sessions?:          number;
  workdir?:           string;
  hiddenFields:       string[];
  transcriptBaseUrl?: string;
}

export interface HubHost {
  hostId:          string;
  hostName:        string;
  online:          boolean;
  lastSeen:        string;
  agentVersion:    string;
  os:              string;
  visibleBots:     HubBot[];
  hiddenBotCount:  number;
}

export function formatUptime(ms?: number): string {
  if (!ms) return '-';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)         return `${sec}s`;
  if (sec < 3600)       return `${Math.floor(sec / 60)}m`;
  if (sec < 86400)      return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export function formatLastSeen(iso: string): string {
  const then = new Date(iso).getTime();
  const now  = Date.now();
  const diff = Math.max(0, now - then);
  const sec  = Math.floor(diff / 1000);
  if (sec < 60)         return '刚刚';
  if (sec < 3600)       return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400)      return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}
