/**
 * Per-bot session inspection and mutation for the manager.
 *
 * Sources of truth (flat JSON files, no DB):
 *   ~/.metabot/<bot>/sessions-<bot>.json       — engine sessions (claude IDs + cost)
 *   ~/.metabot/<bot>/sessions-meta.json        — cross-engine metadata (title, workdir, …)
 *   ~/.metabot/<bot>/sessions.db               — legacy SQLite, present on some bots
 *   ~/.claude/projects/<encoded-workdir>/<id>.jsonl — Claude Code transcripts
 *
 * Workdir-change footgun (memory/feedback_workdir_change.md): clearing
 * `sessions-<bot>.json` alone leaves the SDK chasing a stale entry in
 * `sessions.db`, producing a confusing "native binary not found" error. So
 * any reset MUST nuke both the engine map AND `sessions.db` (if present).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeWorkdir } from '../session/session-registry.js';

export interface SessionMapping {
  chatId:               string;
  sessionId?:           string;
  claudeSessionId?:     string;
  title?:               string;
  workdir?:             string;
  lastUsed?:            number;
  cumulativeTokens?:    number;
  cumulativeCostUsd?:   number;
  platform?:            string;
}

interface EngineSession {
  sessionId?:           string;
  sessionIdEngine?:     string;
  workingDirectory?:    string;
  lastUsed?:            number;
  cumulativeTokens?:    number;
  cumulativeCostUsd?:   number;
}

interface MetaSession {
  botName?:             string;
  claudeSessionId?:     string;
  workingDirectory?:    string;
  title?:               string;
  platform?:            string;
  createdAt?:           number;
  updatedAt?:           number;
}

function dataDirFor(botName: string): string {
  return path.join(os.homedir(), '.metabot', botName);
}

function engineFilePath(botName: string): string {
  return path.join(dataDirFor(botName), `sessions-${botName}.json`);
}

function metaFilePath(botName: string): string {
  return path.join(dataDirFor(botName), 'sessions-meta.json');
}

function sessionsDbPath(botName: string): string {
  return path.join(dataDirFor(botName), 'sessions.db');
}

function readJsonMap<T>(filePath: string): Record<string, T> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, T>;
  } catch {
    return {};
  }
}

function writeJsonMap(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function listSessions(botName: string): SessionMapping[] {
  const engine = readJsonMap<EngineSession>(engineFilePath(botName));
  const meta   = readJsonMap<MetaSession>(metaFilePath(botName));
  const chatIds = new Set([...Object.keys(engine), ...Object.keys(meta)]);
  const out: SessionMapping[] = [];
  for (const chatId of chatIds) {
    const e = engine[chatId] || {};
    const m = meta[chatId]   || {};
    out.push({
      chatId,
      sessionId:          e.sessionId,
      claudeSessionId:    m.claudeSessionId || e.sessionId,
      title:              m.title,
      workdir:            m.workingDirectory || e.workingDirectory,
      lastUsed:           e.lastUsed || m.updatedAt,
      cumulativeTokens:   e.cumulativeTokens,
      cumulativeCostUsd:  e.cumulativeCostUsd,
      platform:           m.platform,
    });
  }
  out.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  return out;
}

/** Validate a candidate sessionId by checking that its JSONL exists. */
export function sessionJsonlExists(workdir: string, sessionId: string): boolean {
  const candidate = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodeWorkdir(workdir),
    `${sessionId}.jsonl`,
  );
  return fs.existsSync(candidate);
}

/** Set a single chat's bound session in both engine + meta files. */
export function setSession(botName: string, chatId: string, sessionId: string, workdir: string): void {
  const engine = readJsonMap<EngineSession>(engineFilePath(botName));
  const meta   = readJsonMap<MetaSession>(metaFilePath(botName));
  const now    = Date.now();

  engine[chatId] = {
    ...(engine[chatId] || {}),
    sessionId,
    sessionIdEngine:    'claude',
    workingDirectory:   workdir,
    lastUsed:           now,
  };
  meta[chatId] = {
    ...(meta[chatId] || {}),
    botName,
    claudeSessionId:    sessionId,
    workingDirectory:   workdir,
    updatedAt:          now,
    createdAt:          meta[chatId]?.createdAt || now,
  };

  writeJsonMap(engineFilePath(botName), engine);
  writeJsonMap(metaFilePath(botName),   meta);
}

/**
 * Reset session(s) for a bot.
 *  - chatId given: drop that single chatId from both files.
 *  - chatId omitted: nuke both files (replace with `{}`) AND delete sessions.db.
 */
export function resetSessions(botName: string, chatId?: string): { cleared: boolean; dbDeleted: boolean } {
  if (chatId) {
    const engine = readJsonMap<EngineSession>(engineFilePath(botName));
    const meta   = readJsonMap<MetaSession>(metaFilePath(botName));
    delete engine[chatId];
    delete meta[chatId];
    writeJsonMap(engineFilePath(botName), engine);
    writeJsonMap(metaFilePath(botName),   meta);
    return { cleared: true, dbDeleted: false };
  }
  // Full nuke. Touch the files to {} so the SDK starts clean, then drop the
  // legacy SQLite if it's there.
  writeJsonMap(engineFilePath(botName), {});
  writeJsonMap(metaFilePath(botName),   {});
  let dbDeleted = false;
  try {
    if (fs.existsSync(sessionsDbPath(botName))) {
      fs.unlinkSync(sessionsDbPath(botName));
      dbDeleted = true;
    }
  } catch { /* best effort */ }
  return { cleared: true, dbDeleted };
}

export interface JsonlSummary {
  sessionId:         string;
  sizeBytes:         number;
  mtimeMs:           number;
  firstUserMessage?: string;
  lastUserMessage?:  string;
}

/** Pull text out of a `message.content` field that may be a string or content blocks. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('');
  }
  return '';
}

const PREVIEW_CHARS = 200;

function clip(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_CHARS ? oneLine.slice(0, PREVIEW_CHARS) + '…' : oneLine;
}

/**
 * Scan the first ~5 lines for the first user message; scan the last ~200
 * lines for the last user message. Tolerant of malformed JSON lines.
 *
 * "User message" = `type:'user'` jsonl row whose extracted text is non-empty.
 */
function scanFirstAndLastUserMessages(filePath: string): { first?: string; last?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  const lines = raw.split('\n');
  let first: string | undefined;
  let last:  string | undefined;

  for (let i = 0; i < Math.min(lines.length, 200); i += 1) {
    if (first) break;
    const line = lines[i];
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.type === 'user') {
        const text = extractText(row.message?.content);
        if (text) first = clip(text);
      }
    } catch { /* tolerate */ }
  }

  const tailStart = Math.max(0, lines.length - 400);
  for (let i = lines.length - 1; i >= tailStart; i -= 1) {
    if (last) break;
    const line = lines[i];
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.type === 'user') {
        const text = extractText(row.message?.content);
        if (text) last = clip(text);
      }
    } catch { /* tolerate */ }
  }
  return { first, last };
}

/** List all jsonl transcripts for a bot's defaultWorkingDirectory. */
export function listJsonls(workdir: string): JsonlSummary[] {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeWorkdir(workdir));
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: JsonlSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    const { first, last } = scanFirstAndLastUserMessages(full);
    out.push({
      sessionId,
      sizeBytes:         stat.size,
      mtimeMs:           stat.mtimeMs,
      firstUserMessage:  first,
      lastUserMessage:   last,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
