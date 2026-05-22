/* ============================================================
   hub/useHub.ts — fetch hooks for the Hub UI.

   Talks to the manager process's /api/hub/* endpoints. The
   401 path returns a structured { kind: 'login', loginUrl }
   state so the caller can render a "redirecting to login…"
   transition (mirrors TranscriptView's UX).
============================================================ */

import { useEffect, useState } from 'react';
import type { HubHost } from './mockData';

export interface HubSessionEntry {
  chatId:           string;
  sessionId?:       string;
  claudeSessionId?: string;
  title?:           string;
  workdir?:         string;
  lastUsed?:        number;
  platform?:        string;
}

export type FetchState<T> =
  | { kind: 'loading' }
  | { kind: 'login';  loginUrl: string }
  | { kind: 'ok';     data: T }
  | { kind: 'error';  message: string };

interface LoginBody  { loginUrl?: string }
interface HostsBody  { hosts: HubHost[] }
interface HostBody   { host: HubHost }
interface SessionsBody { sessions: HubSessionEntry[] }

/** Shared GET helper. Returns either ok data or a discriminated failure. */
async function hubFetch<T>(url: string, fallbackLoginUrl: string): Promise<FetchState<T>> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch (err) {
    return { kind: 'error', message: (err as Error).message || 'network error' };
  }
  if (res.status === 401) {
    let body: LoginBody = {};
    try { body = (await res.json()) as LoginBody; } catch { /* ignore */ }
    return { kind: 'login', loginUrl: body.loginUrl || fallbackLoginUrl };
  }
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    return { kind: 'error', message: `HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
  }
  try {
    const body = (await res.json()) as T;
    return { kind: 'ok', data: body };
  } catch (err) {
    return { kind: 'error', message: (err as Error).message || 'invalid response' };
  }
}

export function useHubHosts(): FetchState<HubHost[]> {
  const [state, setState] = useState<FetchState<HubHost[]>>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await hubFetch<HostsBody>('/api/hub/hosts', '/api/auth/feishu/login?return=%2Fweb%2Fhub%2Fdashboard');
      if (cancelled) return;
      if (r.kind === 'ok') setState({ kind: 'ok', data: r.data.hosts });
      else                 setState(r);
    })();
    return () => { cancelled = true; };
  }, []);
  return state;
}

export function useHubHost(hostId: string): FetchState<HubHost> {
  const [state, setState] = useState<FetchState<HubHost>>({ kind: 'loading' });
  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    (async () => {
      const fallback = `/api/auth/feishu/login?return=${encodeURIComponent(`/web/hub/hosts/${hostId}`)}`;
      const r = await hubFetch<HostBody>(`/api/hub/hosts/${encodeURIComponent(hostId)}`, fallback);
      if (cancelled) return;
      if (r.kind === 'ok') setState({ kind: 'ok', data: r.data.host });
      else                 setState(r);
    })();
    return () => { cancelled = true; };
  }, [hostId]);
  return state;
}

/**
 * Lazy session fetcher — only triggered when the user clicks a BotChip.
 * Exposes a `refresh` so the side-panel can be re-fetched cheaply.
 */
export function useHubBotSessions(botName: string | null): FetchState<HubSessionEntry[]> & { refresh: () => void } {
  const [state, setState] = useState<FetchState<HubSessionEntry[]>>({ kind: 'loading' });
  const [tick, setTick]   = useState(0);
  useEffect(() => {
    if (!botName) {
      setState({ kind: 'loading' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      const fallback = `/api/auth/feishu/login?return=${encodeURIComponent(`/web/hub/bots/${botName}/sessions`)}`;
      const r = await hubFetch<SessionsBody>(`/api/hub/bots/${encodeURIComponent(botName)}/sessions`, fallback);
      if (cancelled) return;
      if (r.kind === 'ok') setState({ kind: 'ok', data: r.data.sessions });
      else                 setState(r);
    })();
    return () => { cancelled = true; };
  }, [botName, tick]);
  return { ...state, refresh: () => setTick((n) => n + 1) };
}

/**
 * Side-effect helper — kicks off the OAuth redirect after a brief pause so the
 * "正在登录…" message has time to render.
 */
export function redirectToLogin(loginUrl: string): void {
  setTimeout(() => { window.location.href = loginUrl; }, 200);
}

/** Compute aggregate stats over the live hosts array, mirrors mockData.totals. */
export interface HubTotals {
  totalHosts:   number;
  onlineHosts:  number;
  visibleBots:  number;
  hiddenBots:   number;
  online:       number;
  stopped:      number;
  error:        number;
  launching:    number;
}

export function computeTotals(hosts: HubHost[]): HubTotals {
  let online      = 0;
  let stopped     = 0;
  let errored     = 0;
  let launching   = 0;
  let hiddenBots  = 0;
  let onlineHosts = 0;
  for (const h of hosts) {
    if (h.online) onlineHosts += 1;
    hiddenBots += h.hiddenBotCount;
    for (const b of h.visibleBots) {
      if (b.status === 'online')    online    += 1;
      if (b.status === 'stopped')   stopped   += 1;
      if (b.status === 'launching') launching += 1;
      if (b.status === 'error')     errored   += 1;
    }
  }
  const visibleBots = hosts.reduce((n, h) => n + h.visibleBots.length, 0);
  return {
    totalHosts:  hosts.length,
    onlineHosts,
    visibleBots,
    hiddenBots,
    online,
    stopped,
    error:       errored,
    launching,
  };
}
