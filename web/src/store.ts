/* ============================================================
   MetaBot Web — Global State (Zustand)
   ============================================================ */

import { create } from 'zustand';
import type {
  ActiveView,
  BotInfo,
  CardState,
  ChatMessage,
  ChatSession,
  Theme,
} from './types';

/* ---- helpers ---- */

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function persistSessions(sessions: Map<string, ChatSession>) {
  try {
    const obj: Record<string, ChatSession> = {};
    sessions.forEach((v, k) => {
      obj[k] = v;
    });
    localStorage.setItem('metabot:sessions', JSON.stringify(obj));
  } catch {
    // storage full — silently ignore
  }
}

function loadSessions(): Map<string, ChatSession> {
  try {
    const raw = localStorage.getItem('metabot:sessions');
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, ChatSession>;
    const map = new Map<string, ChatSession>();
    for (const [k, v] of Object.entries(obj)) {
      map.set(k, v);
    }
    return map;
  } catch {
    return new Map();
  }
}

/* ---- store interface ---- */

export interface AppStore {
  // Auth
  token: string | null;
  login: (token: string) => void;
  logout: () => void;

  // Connection
  connected: boolean;
  setConnected: (c: boolean) => void;

  // Bots
  bots: BotInfo[];
  setBots: (bots: BotInfo[]) => void;
  activeBotName: string | null;
  setBot: (name: string) => void;

  // Sessions
  sessions: Map<string, ChatSession>;
  activeSessionId: string | null;
  createSession: (botName?: string) => string;
  deleteSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  addMessage: (sessionId: string, msg: ChatMessage) => void;
  updateMessageState: (
    sessionId: string,
    messageId: string,
    state: CardState,
  ) => void;
  updateMessageText: (
    sessionId: string,
    messageId: string,
    text: string,
  ) => void;
  addMessageAttachment: (
    sessionId: string,
    messageId: string,
    attachment: import('./types').FileAttachment,
  ) => void;
  clearSessions: () => void;
  getOrCreateBotSession: (botName: string) => string;

  // Navigation
  activeView: ActiveView;
  setView: (v: ActiveView) => void;

  // Theme
  theme: Theme;
  toggleTheme: () => void;

  // Sidebar
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

export const useStore = create<AppStore>((set, get) => ({
  /* ---- Auth ---- */
  token: localStorage.getItem('metabot:token'),

  login(token: string) {
    localStorage.setItem('metabot:token', token);
    set({ token });
  },

  logout() {
    localStorage.removeItem('metabot:token');
    set({ token: null, connected: false, bots: [], activeBotName: null });
  },

  /* ---- Connection ---- */
  connected: false,
  setConnected(c: boolean) {
    set({ connected: c });
  },

  /* ---- Bots ---- */
  bots: [],
  setBots(bots: BotInfo[]) {
    const state = get();
    const updates: Partial<AppStore> = { bots };
    // Auto-select first bot if none selected
    if (!state.activeBotName && bots.length > 0) {
      updates.activeBotName = bots[0].name;
    }
    set(updates);
  },
  activeBotName: null,
  setBot(name: string) {
    set({ activeBotName: name });
  },

  /* ---- Sessions ---- */
  sessions: loadSessions(),
  activeSessionId: null,

  createSession(botName?: string) {
    const state = get();
    const bot = botName || state.activeBotName || 'default';
    const id = generateId();
    const session: ChatSession = {
      id,
      botName: bot,
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const sessions = new Map(state.sessions);
    sessions.set(id, session);
    persistSessions(sessions);
    set({ sessions, activeSessionId: id });
    return id;
  },

  deleteSession(id: string) {
    const sessions = new Map(get().sessions);
    sessions.delete(id);
    persistSessions(sessions);
    const updates: Partial<AppStore> = { sessions };
    if (get().activeSessionId === id) {
      // Select the most recent remaining session, or null
      const sorted = Array.from(sessions.values()).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      updates.activeSessionId = sorted.length > 0 ? sorted[0].id : null;
    }
    set(updates);
  },

  setActiveSession(id: string | null) {
    set({ activeSessionId: id });
  },

  addMessage(sessionId: string, msg: ChatMessage) {
    const sessions = new Map(get().sessions);
    const session = sessions.get(sessionId);
    if (!session) return;

    const updated: ChatSession = {
      ...session,
      messages: [...session.messages, msg],
      updatedAt: Date.now(),
      // Update title from first user message
      title:
        session.messages.length === 0 && msg.type === 'user'
          ? msg.text.slice(0, 60) || 'New Chat'
          : session.title,
    };
    sessions.set(sessionId, updated);
    persistSessions(sessions);
    set({ sessions });
  },

  updateMessageState(sessionId: string, messageId: string, state: CardState) {
    const sessions = new Map(get().sessions);
    const session = sessions.get(sessionId);
    if (!session) return;

    const messages = session.messages.map((m) =>
      m.id === messageId
        ? { ...m, state, text: state.responseText || m.text }
        : m,
    );
    sessions.set(sessionId, { ...session, messages, updatedAt: Date.now() });
    persistSessions(sessions);
    set({ sessions });
  },

  updateMessageText(sessionId: string, messageId: string, text: string) {
    const sessions = new Map(get().sessions);
    const session = sessions.get(sessionId);
    if (!session) return;

    const messages = session.messages.map((m) =>
      m.id === messageId ? { ...m, text } : m,
    );
    sessions.set(sessionId, { ...session, messages, updatedAt: Date.now() });
    persistSessions(sessions);
    set({ sessions });
  },

  addMessageAttachment(sessionId: string, messageId: string, attachment: import('./types').FileAttachment) {
    const sessions = new Map(get().sessions);
    const session = sessions.get(sessionId);
    if (!session) return;

    const messages = session.messages.map((m) => {
      if (m.id === messageId) {
        return { ...m, attachments: [...(m.attachments || []), attachment] };
      }
      return m;
    });
    sessions.set(sessionId, { ...session, messages, updatedAt: Date.now() });
    persistSessions(sessions);
    set({ sessions });
  },

  clearSessions() {
    localStorage.removeItem('metabot:sessions');
    set({ sessions: new Map(), activeSessionId: null });
  },

  getOrCreateBotSession(botName: string) {
    const state = get();
    // Find existing session for this bot
    for (const [id, session] of state.sessions) {
      if (session.botName === botName) {
        set({ activeSessionId: id, activeBotName: botName });
        return id;
      }
    }
    // Create new session for this bot
    const id = generateId();
    const session: ChatSession = {
      id,
      botName,
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const sessions = new Map(state.sessions);
    sessions.set(id, session);
    persistSessions(sessions);
    set({ sessions, activeSessionId: id, activeBotName: botName });
    return id;
  },

  /* ---- Navigation ---- */
  activeView: 'chat',
  setView(v: ActiveView) {
    set({ activeView: v });
  },

  /* ---- Theme ---- */
  theme: (localStorage.getItem('metabot:theme') as Theme) || 'dark',
  toggleTheme() {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('metabot:theme', next);
    document.documentElement.setAttribute('data-theme', next);
    set({ theme: next });
  },

  /* ---- Sidebar ---- */
  sidebarOpen: window.innerWidth > 768,
  toggleSidebar() {
    set({ sidebarOpen: !get().sidebarOpen });
  },
  setSidebarOpen(open: boolean) {
    set({ sidebarOpen: open });
  },
}));
