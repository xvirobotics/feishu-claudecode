/**
 * Cross-platform session registry — file-backed.
 *
 * Reads directly from two on-disk sources of truth:
 *   - Claude Code Agent SDK JSONL transcripts at
 *     ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
 *   - Per-bot chatId → claudeSessionId map at
 *     ~/.metabot[/<bot>]/sessions-<bot>.json
 *
 * Internally `id === chatId` — no separate UUID indirection.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../utils/logger.js';

export interface SessionRecord {
  id: string;
  botName: string;
  claudeSessionId?: string;
  workingDirectory: string;
  title: string;
  platform: string;
  chatId: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  platform: string;
  costUsd?: number;
  durationMs?: number;
}

export interface SessionLink {
  chatId: string;
  platform: string;
  linkedAt: number;
}

interface MetaEntry {
  botName: string;
  claudeSessionId?: string;
  workingDirectory: string;
  title: string;
  platform: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
  /** Other chatIds linked to this session (cross-platform adoption). */
  linkedChatIds?: SessionLink[];
}

type MetaMap = Record<string, MetaEntry>;

/** Same encoder Claude Code SDK uses to derive ~/.claude/projects/<dir>. */
function encodeWorkdir(workdir: string): string {
  const sanitized = workdir.replace(/[^a-zA-Z0-9]/g, '-');
  // SDK truncates + appends a hash beyond 200 chars; we don't replicate the
  // hash (we'd need the SDK's N16). Workdirs >200 chars are exotic — callers
  // will just see an empty message list, which is acceptable.
  return sanitized.length <= 200 ? sanitized : sanitized.slice(0, 200);
}

/** Project transcript dir for a given workdir. */
function projectTranscriptDir(workdir: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeWorkdir(workdir));
}

/** Same encoder Claude Code SDK uses to derive ~/.claude/projects/<dir>. */
export function encodeWorkdir(workdir: string): string {
  const sanitized = workdir.replace(/[^a-zA-Z0-9]/g, '-');
  // SDK truncates + appends a hash beyond 200 chars; we don't replicate the
  // hash (we'd need the SDK's N16). Workdirs >200 chars are exotic — callers
  // will just see an empty message list, which is acceptable.
  return sanitized.length <= 200 ? sanitized : sanitized.slice(0, 200);
}

/** Project transcript dir for a given workdir. */
export function projectTranscriptDir(workdir: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeWorkdir(workdir));
}

/** Resolve the JSONL transcript file path for a session, if known. */
export function sessionJsonlPath(workdir: string, claudeSessionId: string): string {
  return path.join(projectTranscriptDir(workdir), `${claudeSessionId}.jsonl`);
}

export class SessionRegistry {
  private metaPath: string;
  private meta: MetaMap = {};

  constructor(private logger: Logger) {
    const dataDir = process.env.SESSION_STORE_DIR
      || process.env.METABOT_DATA_DIR
      || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    this.metaPath = path.join(dataDir, 'sessions-meta.json');
    this.loadMeta();
    this.bootstrapFromSessionMaps(dataDir);
    this.logger.info({ metaPath: this.metaPath }, 'Session registry initialized (file-backed)');
  }

  /**
   * Surface existing chat sessions in the web UI by reading every
   * `sessions-<bot>.json` map that SessionManager already persists. We only
   * fill in entries that are not already in our meta map, so re-runs are
   * idempotent.
   */
  private bootstrapFromSessionMaps(dataDir: string): void {
    try {
      const files = fs.readdirSync(dataDir);
      let added = 0;
      for (const file of files) {
        const m = file.match(/^sessions-(.+)\.json$/);
        if (!m) continue;
        const botName = m[1];
        let map: Record<string, { sessionId?: string; workingDirectory?: string; lastUsed?: number }>;
        try {
          map = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
        } catch {
          continue;
        }
        for (const [chatId, persisted] of Object.entries(map)) {
          if (this.meta[chatId]) continue;
          if (!persisted.sessionId || !persisted.workingDirectory) continue;
          const ts = persisted.lastUsed || Date.now();
          this.meta[chatId] = {
            botName,
            claudeSessionId: persisted.sessionId,
            workingDirectory: persisted.workingDirectory,
            title: chatId.slice(0, 12),
            platform: SessionRegistry.detectPlatform(chatId),
            createdAt: ts,
            updatedAt: ts,
          };
          added++;
        }
      }
      if (added > 0) {
        this.saveMeta();
        this.logger.info({ added }, 'Bootstrapped sessions from existing sessions-<bot>.json maps');
      }
    } catch (err) {
      this.logger.warn({ err, dataDir }, 'Bootstrap from session maps failed (non-fatal)');
    }
  }

  private loadMeta(): void {
    try {
      if (!fs.existsSync(this.metaPath)) return;
      const raw = fs.readFileSync(this.metaPath, 'utf-8');
      this.meta = JSON.parse(raw) as MetaMap;
    } catch (err) {
      this.logger.warn({ err, metaPath: this.metaPath }, 'Failed to load session metadata, starting fresh');
      this.meta = {};
    }
  }

  private saveMeta(): void {
    try {
      const tmp = `${this.metaPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2), 'utf-8');
      fs.renameSync(tmp, this.metaPath);
    } catch (err) {
      this.logger.warn({ err, metaPath: this.metaPath }, 'Failed to persist session metadata');
    }
  }

  /** Detect platform from chatId pattern. */
  static detectPlatform(chatId: string): string {
    if (chatId.startsWith('oc_') || chatId.startsWith('ou_')) return 'feishu';
    if (/^\d+$/.test(chatId)) return 'telegram';
    if (chatId.startsWith('ios_')) return 'ios';
    return 'web';
  }

  /** Resolve a chatId to its primary record (following links). */
  private resolvePrimary(chatId: string): { primaryChatId: string; entry: MetaEntry } | null {
    const direct = this.meta[chatId];
    if (direct) return { primaryChatId: chatId, entry: direct };
    for (const [pid, entry] of Object.entries(this.meta)) {
      if (entry.linkedChatIds?.some((l) => l.chatId === chatId)) {
        return { primaryChatId: pid, entry };
      }
    }
    return null;
  }

  /** Build a SessionRecord from a meta entry. */
  private toRecord(chatId: string, entry: MetaEntry): SessionRecord {
    return {
      id: chatId,
      botName: entry.botName,
      claudeSessionId: entry.claudeSessionId,
      workingDirectory: entry.workingDirectory,
      title: entry.title,
      platform: entry.platform,
      chatId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastMessagePreview: entry.lastMessagePreview,
    };
  }

  /**
   * Create or update a session record after execution completes.
   * Called by MessageBridge after each task.
   */
  createOrUpdate(opts: {
    chatId: string;
    botName: string;
    claudeSessionId?: string;
    workingDirectory: string;
    prompt: string;
    responseText?: string;
    costUsd?: number;
    durationMs?: number;
  }): string {
    const { chatId, botName, claudeSessionId, workingDirectory, prompt, responseText } = opts;
    const platform = SessionRegistry.detectPlatform(chatId);
    const now = Date.now();

    const resolved = this.resolvePrimary(chatId);
    const primaryChatId = resolved?.primaryChatId ?? chatId;
    const existing = resolved?.entry;

    const preview = (responseText || prompt || '').slice(0, 200).replace(/\n/g, ' ');

    const entry: MetaEntry = existing
      ? {
          ...existing,
          claudeSessionId: claudeSessionId || existing.claudeSessionId,
          workingDirectory: existing.workingDirectory || workingDirectory,
          updatedAt: now,
          lastMessagePreview: preview || existing.lastMessagePreview,
        }
      : {
          botName,
          claudeSessionId,
          workingDirectory,
          title: prompt.slice(0, 60).replace(/\n/g, ' '),
          platform,
          createdAt: now,
          updatedAt: now,
          lastMessagePreview: preview,
        };

    this.meta[primaryChatId] = entry;
    this.saveMeta();
    return primaryChatId;
  }

  /** List sessions for a bot, ordered by most recent first. */
  listSessions(botName: string): SessionRecord[] {
    return Object.entries(this.meta)
      .filter(([, e]) => e.botName === botName)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 100)
      .map(([cid, e]) => this.toRecord(cid, e));
  }

  /** Get a single session by its registry ID (== chatId). */
  getSession(id: string): SessionRecord | null {
    const resolved = this.resolvePrimary(id);
    return resolved ? this.toRecord(resolved.primaryChatId, resolved.entry) : null;
  }

  /** Find a session by its chatId (primary or linked) — alias of getSession. */
  findByChatId(chatId: string): SessionRecord | null {
    return this.getSession(chatId);
  }

  /**
   * Get message history for a session by reading the SDK's JSONL transcript.
   *
   * Reads ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl line by line
   * and extracts user/assistant text. `since` is treated as a timestamp filter
   * applied to the JSONL line's `timestamp` field if present.
   */
  getMessages(sessionId: string, since?: number): SessionMessage[] {
    const session = this.getSession(sessionId);
    if (!session?.claudeSessionId) return [];
    const jsonlPath = path.join(
      projectTranscriptDir(session.workingDirectory),
      `${session.claudeSessionId}.jsonl`,
    );
    if (!fs.existsSync(jsonlPath)) return [];

    const messages: SessionMessage[] = [];
    let raw: string;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } catch (err) {
      this.logger.warn({ err, jsonlPath }, 'Failed to read JSONL transcript');
      return [];
    }

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = typeof evt.timestamp === 'string'
        ? Date.parse(evt.timestamp)
        : (typeof evt.timestamp === 'number' ? evt.timestamp : undefined);
      if (since && ts && ts <= since) continue;

      if (evt.type === 'user' && evt.message?.role === 'user') {
        const text = typeof evt.message.content === 'string'
          ? evt.message.content
          : extractText(evt.message.content);
        if (text) {
          messages.push({
            role: 'user',
            text,
            timestamp: ts || Date.now(),
            platform: session.platform,
          });
        }
      } else if (evt.type === 'assistant' && evt.message?.role === 'assistant') {
        const text = extractText(evt.message.content);
        if (text) {
          messages.push({
            role: 'assistant',
            text,
            timestamp: ts || Date.now(),
            platform: session.platform,
          });
        }
      }
    }

    return messages.slice(-200);
  }

  /** Get all linked chatIds for a session. */
  getLinks(sessionId: string): SessionLink[] {
    const resolved = this.resolvePrimary(sessionId);
    return resolved?.entry.linkedChatIds ?? [];
  }

  /**
   * Link a new chatId to an existing session.
   * Returns the Claude session ID so the caller can set it in SessionManager.
   */
  linkChatId(sessionId: string, chatId: string, platform?: string): string | undefined {
    const resolved = this.resolvePrimary(sessionId);
    if (!resolved) return undefined;
    const { primaryChatId, entry } = resolved;
    if (chatId === primaryChatId) return entry.claudeSessionId;

    const resolvedPlatform = platform || SessionRegistry.detectPlatform(chatId);
    entry.linkedChatIds ??= [];
    if (!entry.linkedChatIds.some((l) => l.chatId === chatId)) {
      entry.linkedChatIds.push({ chatId, platform: resolvedPlatform, linkedAt: Date.now() });
    }
    entry.updatedAt = Date.now();
    this.meta[primaryChatId] = entry;
    this.saveMeta();
    this.logger.info({ sessionId: primaryChatId, chatId, platform: resolvedPlatform }, 'Session linked to new chatId');
    return entry.claudeSessionId;
  }

  /** Rename a session. */
  renameSession(id: string, newTitle: string): boolean {
    const resolved = this.resolvePrimary(id);
    if (!resolved) return false;
    resolved.entry.title = newTitle;
    resolved.entry.updatedAt = Date.now();
    this.meta[resolved.primaryChatId] = resolved.entry;
    this.saveMeta();
    return true;
  }

  /** Delete a session record. The JSONL transcript on disk is left untouched. */
  deleteSession(id: string): void {
    const resolved = this.resolvePrimary(id);
    if (!resolved) return;
    delete this.meta[resolved.primaryChatId];
    this.saveMeta();
  }

  close(): void {
    this.saveMeta();
    this.logger.info('Session registry closed');
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      if ((block as any).type === 'text' && typeof (block as any).text === 'string') {
        parts.push((block as any).text);
      }
    }
  }
  return parts.join('\n').trim();
}

