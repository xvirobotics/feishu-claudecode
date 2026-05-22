/* ============================================================
   manager/api.ts — typed fetch wrappers for /api/manager/*

   All calls use `credentials: 'include'` so the HttpOnly cookie
   `mb_mgr_session` is sent. Server errors normalize to ApiError.
============================================================ */

export type BotStatus = 'online' | 'stopped' | 'errored' | 'launching' | 'unknown';

export interface BotSummary {
  name:           string;
  status:         BotStatus;
  pid?:           number;
  uptimeMs?:      number;
  cpu?:           number;
  memMb?:         number;
  restarts?:      number;
  apiPort?:       number;
  memoryPort?:    number;
  workdir?:       string;
  feishuAppId?:   string;
  sessionCount?:  number;
  lastError?:     string;
}

export interface BotConfig {
  name:                      string;
  feishuAppId:               string;
  feishuAppSecret:           string;
  defaultWorkingDirectory?:  string;
  env?:                      Record<string, string>;
  publicBaseUrl?:            string;
  persistentExecutor?:       boolean;
  transcriptDisableAuth?:    boolean;
  transcriptAllowOpenIds?:   string[];
  accessAllowOpenIds?:       string[];
  hubVisible?:               boolean;
}

export interface SessionMapping {
  chatId:              string;
  sessionId:           string;
  title?:              string;
  workdir?:            string;
  lastUsed?:           number;
  cumulativeTokens?:   number;
  cumulativeCostUsd?:  number;
}

export interface BotDetailResponse {
  config:    BotConfig;
  status:    BotSummary;
  sessions:  SessionMapping[];
  logPath?:  string;
}

export interface JsonlInfo {
  sessionId:          string;
  sizeBytes:          number;
  mtimeMs:            number;
  firstUserMessage?:  string;
  lastUserMessage?:   string;
}

export interface AuthMeResponse {
  username:     string;
  disableAuth?: boolean;
}

export class ApiError extends Error {
  status:    number;
  payload?:  unknown;

  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name    = 'ApiError';
    this.status  = status;
    this.payload = payload;
  }
}

const BASE = '/api/manager';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!res.ok) {
    let payload: unknown = undefined;
    let message: string  = res.statusText || `HTTP ${res.status}`;
    try {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        payload = await res.json();
        const obj = payload as { error?: string; message?: string };
        if (obj?.message) message = obj.message;
        else if (obj?.error) message = obj.error;
      } else {
        const text = await res.text();
        if (text) message = text;
      }
    } catch {
      // ignore parse error, fall through to default message
    }
    throw new ApiError(res.status, message, payload);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return undefined as T;
  return (await res.json()) as T;
}

// ── Auth ─────────────────────────────────────────────────────
export function authLogin(username: string, password: string) {
  return request<{ ok: true; username: string }>('/auth/login', {
    method: 'POST',
    body:   JSON.stringify({ username, password }),
  });
}

export function authLogout() {
  return request<void>('/auth/logout', { method: 'POST' });
}

export function authMe() {
  return request<AuthMeResponse>('/auth/me');
}

// ── Bots ─────────────────────────────────────────────────────
export function listBots() {
  return request<{ bots: BotSummary[] }>('/bots');
}

export function getBot(name: string) {
  return request<BotDetailResponse>(`/bots/${encodeURIComponent(name)}`);
}

export interface CreateBotInput {
  name:                     string;
  feishuAppId:              string;
  feishuAppSecret:          string;
  defaultWorkingDirectory:  string;
  description?:             string;
  publicBaseUrl?:           string;
  transcriptDisableAuth?:   boolean;
  transcriptAllowOpenIds?:  string[];
  env?:                     Record<string, string>;
  insertAtIndex?:           number;
}

export function createBot(input: CreateBotInput) {
  return request<{ bot: BotConfig; status: BotSummary }>('/bots', {
    method: 'POST',
    body:   JSON.stringify(input),
  });
}

export function deleteBot(name: string, opts?: { clearSessions?: boolean }) {
  return request<{ ok: true; removed: string; sessionsCleared: boolean; dbDeleted: boolean }>(
    `/bots/${encodeURIComponent(name)}`,
    {
      method: 'DELETE',
      body:   JSON.stringify(opts || {}),
    },
  );
}

export function startBot(name: string) {
  return request<{ status: BotSummary }>(`/bots/${encodeURIComponent(name)}/start`, { method: 'POST' });
}

export function stopBot(name: string) {
  return request<{ status: BotSummary }>(`/bots/${encodeURIComponent(name)}/stop`, { method: 'POST' });
}

export function restartBot(name: string) {
  return request<{ status: BotSummary }>(`/bots/${encodeURIComponent(name)}/restart`, { method: 'POST' });
}

export function patchWorkdir(name: string, workdir: string) {
  return request<{ status: BotSummary; sessionsCleared: true }>(
    `/bots/${encodeURIComponent(name)}/workdir`,
    { method: 'PATCH', body: JSON.stringify({ workdir }) },
  );
}

export function patchEnv(name: string, env: Record<string, string>, removeKeys?: string[]) {
  return request<{ status: BotSummary }>(
    `/bots/${encodeURIComponent(name)}/env`,
    { method: 'PATCH', body: JSON.stringify({ env, removeKeys }) },
  );
}

export function patchHubVisible(name: string, visible: boolean) {
  return request<{ config: BotConfig; status: BotSummary }>(
    `/bots/${encodeURIComponent(name)}/hub-visible`,
    { method: 'PATCH', body: JSON.stringify({ visible }) },
  );
}

export function patchSession(name: string, chatId: string, sessionId: string) {
  return request<{ ok: true }>(
    `/bots/${encodeURIComponent(name)}/session`,
    { method: 'PATCH', body: JSON.stringify({ chatId, sessionId }) },
  );
}

export function resetSession(name: string, chatId?: string) {
  return request<{ ok: true }>(
    `/bots/${encodeURIComponent(name)}/session/reset`,
    { method: 'POST', body: JSON.stringify(chatId ? { chatId } : {}) },
  );
}

export function listJsonls(name: string) {
  return request<{ jsonls: JsonlInfo[] }>(`/bots/${encodeURIComponent(name)}/sessions/jsonls`);
}

// ── WebSocket helper ─────────────────────────────────────────
export function buildLogWsUrl(name: string, stream: 'out' | 'error', tail = 200) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs    = new URLSearchParams({ stream, tail: String(tail) });
  return `${proto}//${window.location.host}${BASE}/bots/${encodeURIComponent(name)}/logs?${qs.toString()}`;
}
