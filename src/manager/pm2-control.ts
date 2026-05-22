/**
 * Shell out to `pm2` to inspect and control bots.
 *
 * Defensive env stripping: when manager spawns pm2, we strip API_PORT,
 * MEMORY_PORT, BOT_NAME, METABOT_DATA_DIR from the child env so we never
 * pollute a target bot's env (see memory/bug_pm2_start_update_env_pollution).
 *
 * Use `pm2 startOrReload ecosystem.config.cjs --only <name>` for start AND
 * restart — it's idempotent and re-reads ecosystem so config changes (workdir,
 * env) take effect. NEVER `pm2 start <name> --update-env`.
 */
import { execFile } from 'node:child_process';

const POLLUTING_KEYS = ['API_PORT', 'MEMORY_PORT', 'BOT_NAME', 'METABOT_DATA_DIR'];

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of POLLUTING_KEYS) delete env[k];
  return env;
}

function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      env:         cleanEnv(),
      timeout:     opts.timeoutMs ?? 30_000,
      maxBuffer:   8 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${cmd} ${args.join(' ')} failed: ${err.message}\nstderr: ${stderr}`;
        reject(new Error(msg));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export interface Pm2ProcInfo {
  name:               string;
  pid?:               number;
  status:             string;
  pmId?:              number;
  cpu?:               number;
  memoryBytes?:       number;
  uptimeMs?:          number;
  restarts?:          number;
  pmOutLogPath?:      string;
  pmErrLogPath?:      string;
  env: {
    API_PORT?:        string;
    MEMORY_PORT?:     string;
    BOT_NAME?:        string;
    METABOT_DATA_DIR?: string;
  };
}

interface RawPm2Entry {
  name?:     string;
  pid?:      number;
  pm_id?:    number;
  monit?:    { cpu?: number; memory?: number };
  pm2_env?:  {
    status?:           string;
    pm_uptime?:        number;
    restart_time?:     number;
    pm_out_log_path?:  string;
    pm_err_log_path?:  string;
    API_PORT?:         string;
    MEMORY_PORT?:      string;
    BOT_NAME?:         string;
    METABOT_DATA_DIR?: string;
  };
}

/** Parse `pm2 jlist` output into a normalized array. */
export async function listPm2(): Promise<Pm2ProcInfo[]> {
  const { stdout } = await run('pm2', ['jlist']);
  // pm2 jlist sometimes prints a leading line of [PM2] log spam before the JSON
  // (especially on first call). Find the first [ that starts a JSON array.
  const idx = stdout.indexOf('[');
  if (idx < 0) return [];
  const tail = stdout.slice(idx);
  let parsed: RawPm2Entry[];
  try {
    parsed = JSON.parse(tail) as RawPm2Entry[];
  } catch {
    return [];
  }
  const now = Date.now();
  return parsed.map((entry) => {
    const env = entry.pm2_env || {};
    const uptimeMs = env.pm_uptime && env.status === 'online'
      ? Math.max(0, now - env.pm_uptime)
      : undefined;
    return {
      name:          entry.name || '<unknown>',
      pid:           entry.pid && entry.pid > 0 ? entry.pid : undefined,
      pmId:          entry.pm_id,
      status:        env.status || 'unknown',
      cpu:           entry.monit?.cpu,
      memoryBytes:   entry.monit?.memory,
      uptimeMs,
      restarts:      env.restart_time,
      pmOutLogPath:  env.pm_out_log_path,
      pmErrLogPath:  env.pm_err_log_path,
      env: {
        API_PORT:         env.API_PORT,
        MEMORY_PORT:      env.MEMORY_PORT,
        BOT_NAME:         env.BOT_NAME,
        METABOT_DATA_DIR: env.METABOT_DATA_DIR,
      },
    };
  });
}

export async function findPm2(name: string): Promise<Pm2ProcInfo | null> {
  const all = await listPm2();
  return all.find((p) => p.name === name) || null;
}

/** `pm2 startOrReload ecosystem.config.cjs --only <name>`. */
export async function startOrReloadBot(name: string, ecosystemPath: string): Promise<void> {
  await run('pm2', ['startOrReload', ecosystemPath, '--only', name, '--update-env'], { timeoutMs: 60_000 });
  // NOTE: --update-env here is OK because we are running `startOrReload` with
  // an explicit ecosystem file — pm2 re-reads the ecosystem and uses ITS env
  // block, not the caller's env. The known footgun is `pm2 start <name>
  // --update-env` (no ecosystem path) which copies the caller's env into the
  // target. cleanEnv() above is the belt-and-suspenders backup.
}

export async function stopBot(name: string): Promise<void> {
  await run('pm2', ['stop', name], { timeoutMs: 30_000 });
}

/**
 * Remove the bot from PM2 entirely (`pm2 delete <name>`). Tolerates
 * "process not found" — if the bot was never started or already deleted,
 * we treat this as success so the caller can sequence stop + delete +
 * bots.json removal idempotently.
 */
export async function deletePm2(name: string): Promise<void> {
  try {
    await run('pm2', ['delete', name], { timeoutMs: 30_000 });
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/process or namespace .* not found/i.test(msg) || /doesn't exist/i.test(msg)) return;
    throw err;
  }
}
