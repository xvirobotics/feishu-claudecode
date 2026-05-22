/**
 * Read/write `bots.json` from the manager.
 *
 * - `loadBotsJson()` returns the full parsed object plus the feishuBots array.
 * - `getBot(name)` finds a feishu bot by name.
 * - `patchBot(name, partial)` merges a partial config into the bot entry and
 *   does an atomic write (tmp + rename), keeping a `.bak` next to the file.
 *
 * Frequently-touched secrets are masked before being returned to the API
 * layer; the manager only un-masks them when writing back to disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BotJsonEntry {
  name:                     string;
  feishuAppId?:             string;
  feishuAppSecret?:         string;
  defaultWorkingDirectory?: string;
  description?:             string;
  icon?:                    string;
  publicBaseUrl?:           string;
  transcriptAllowOpenIds?:  string[];
  transcriptDisableAuth?:   boolean;
  env?:                     Record<string, string>;
  engine?:                  string;
  persistentExecutor?:      boolean;
  // Any other fields are pass-through.
  [key: string]: unknown;
}

export interface BotsJsonShape {
  feishuBots?:   BotJsonEntry[];
  telegramBots?: unknown[];
  wechatBots?:   unknown[];
  webBots?:      unknown[];
  peers?:        unknown[];
  [key: string]: unknown;
}

export interface LoadedBotsJson {
  raw:          BotsJsonShape;
  feishuBots:   BotJsonEntry[];
}

const BOTS_CONFIG_PATH = path.resolve(process.cwd(), 'bots.json');

export function botsConfigPath(): string {
  return BOTS_CONFIG_PATH;
}

export function loadBotsJson(): LoadedBotsJson {
  const raw = JSON.parse(fs.readFileSync(BOTS_CONFIG_PATH, 'utf-8')) as BotsJsonShape;
  const feishuBots = Array.isArray(raw.feishuBots) ? raw.feishuBots : [];
  return { raw, feishuBots };
}

export function getBot(name: string): BotJsonEntry | null {
  const { feishuBots } = loadBotsJson();
  return feishuBots.find((b) => b.name === name) || null;
}

/**
 * Apply a partial patch to a bot's config and atomically rewrite bots.json.
 * `env` is shallow-merged. `removeEnvKeys` strips keys before merge.
 * Returns the updated entry.
 */
export function patchBot(
  name:    string,
  patch:   Partial<BotJsonEntry> & { env?: Record<string, string>; removeEnvKeys?: string[] },
): BotJsonEntry {
  const loaded = loadBotsJson();
  const idx    = loaded.feishuBots.findIndex((b) => b.name === name);
  if (idx < 0) throw Object.assign(new Error(`bot not found: ${name}`), { statusCode: 404 });

  const original = loaded.feishuBots[idx];
  const updated: BotJsonEntry = { ...original };

  const { env, removeEnvKeys, ...rest } = patch;

  for (const [key, value] of Object.entries(rest)) {
    if (key === 'name') continue; // immutable
    if (value === undefined || value === null) {
      delete updated[key];
    } else {
      updated[key] = value;
    }
  }

  if (env || removeEnvKeys?.length) {
    const merged: Record<string, string> = { ...(original.env || {}) };
    if (removeEnvKeys) for (const k of removeEnvKeys) delete merged[k];
    if (env) for (const [k, v] of Object.entries(env)) {
      if (v === '' || v == null) delete merged[k];
      else merged[k] = v;
    }
    if (Object.keys(merged).length === 0) {
      delete updated.env;
    } else {
      updated.env = merged;
    }
  }

  loaded.feishuBots[idx] = updated;
  if (!loaded.raw.feishuBots) loaded.raw.feishuBots = [];
  loaded.raw.feishuBots = loaded.feishuBots;

  writeAtomically(loaded.raw);

  return updated;
}

/**
 * Insert a brand-new bot entry. Throws 409 if `entry.name` already exists.
 * `insertAtIndex` is optional — default behavior is append (so existing bots'
 * indices never shift). Pass an explicit index to insert at a specific
 * position; useful when re-creating a bot that previously held a known
 * port slot (port = `API_PORT_BASE + index*3` in ecosystem.config.cjs).
 */
export function appendBot(
  entry:         BotJsonEntry,
  insertAtIndex?: number,
): BotJsonEntry {
  if (!entry.name) throw Object.assign(new Error('bot name required'), { statusCode: 422 });
  const loaded = loadBotsJson();
  if (loaded.feishuBots.some((b) => b.name === entry.name)) {
    throw Object.assign(new Error(`bot already exists: ${entry.name}`), { statusCode: 409 });
  }

  const bots = [...loaded.feishuBots];
  if (typeof insertAtIndex === 'number' && insertAtIndex >= 0 && insertAtIndex <= bots.length) {
    bots.splice(insertAtIndex, 0, entry);
  } else {
    bots.push(entry);
  }

  loaded.raw.feishuBots = bots;
  writeAtomically(loaded.raw);
  return entry;
}

/**
 * Remove a bot from `feishuBots` by name. Throws 404 if not found.
 * Returns the removed entry so the caller can decide what cleanup to do
 * (data dir, sessions, pm2 process, etc.).
 */
export function removeBot(name: string): BotJsonEntry {
  const loaded = loadBotsJson();
  const idx    = loaded.feishuBots.findIndex((b) => b.name === name);
  if (idx < 0) throw Object.assign(new Error(`bot not found: ${name}`), { statusCode: 404 });

  const removed = loaded.feishuBots[idx];
  const bots    = loaded.feishuBots.filter((_, i) => i !== idx);

  loaded.raw.feishuBots = bots;
  writeAtomically(loaded.raw);
  return removed;
}

function writeAtomically(data: BotsJsonShape): void {
  const dir       = path.dirname(BOTS_CONFIG_PATH);
  const tmpPath   = path.join(dir, '.bots.json.mgr.tmp');
  const bakPath   = BOTS_CONFIG_PATH + '.bak';
  const json      = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  // Keep a single-rolling backup so the owner can recover from a bad patch.
  try {
    if (fs.existsSync(BOTS_CONFIG_PATH)) fs.copyFileSync(BOTS_CONFIG_PATH, bakPath);
  } catch { /* best-effort */ }
  fs.renameSync(tmpPath, BOTS_CONFIG_PATH);
}

/**
 * Mask sensitive fields in a bot config before sending to the client.
 * - `feishuAppSecret` → `***<last4>`
 * - `env.ANTHROPIC_AUTH_TOKEN` / `env.ANTHROPIC_API_KEY` → `***<last4>`
 */
const REDACTED_ENV_KEYS = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MOONSHOT_API_KEY',
]);

function maskTail(s: string | undefined): string | undefined {
  if (!s) return s;
  if (s.length <= 4) return '***';
  return `***${s.slice(-4)}`;
}

export function maskBotForClient(b: BotJsonEntry): BotJsonEntry {
  const out: BotJsonEntry = { ...b };
  if (out.feishuAppSecret) out.feishuAppSecret = maskTail(out.feishuAppSecret);
  if (out.env) {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.env)) {
      masked[k] = REDACTED_ENV_KEYS.has(k) ? (maskTail(v) || '***') : v;
    }
    out.env = masked;
  }
  return out;
}
