/**
 * PTY backend — hook bridge.
 *
 * In SDK mode, hooks are JS callbacks invoked in-process. In PTY mode the
 * spawned `claude` runs hooks as shell `command`s defined in --settings json.
 * This bridge:
 *   1. Generates a settings.json with command hooks pointing at small shell
 *      snippets that write sentinel/event files.
 *   2. Watches the Stop sentinel to fire `onTurnComplete`.
 *   3. Tails the team-event file to fire `onTeamEvent`.
 *
 * NOTE: PreToolUse(AskUserQuestion) interactive answering is OUT OF SCOPE for
 * phase 1 — the bridge does not intercept or respond to AskUserQuestion hooks.
 * // phase 2: wire PreToolUse(AskUserQuestion) hook that writes the question
 * // payload to a file, then blocks until an answer file appears. The bridge
 * // would watch for the question file and invoke a callback to get the answer.
 */

import {
  mkdirSync, writeFileSync, rmSync, existsSync, watch,
  openSync, readSync, statSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FSWatcher } from 'node:fs';
import type { PtyHookBridge } from './contract.js';

export interface HookBridgeOptions {
  /**
   * Include TaskCreated/TaskCompleted/TeammateIdle command hooks in the
   * generated settings.json. Default: false.
   *
   * These hook events are REJECTED by the current claude CLI settings
   * validator — including them causes a validation dialog that blocks the
   * TUI from starting. Kept behind this flag for phase 2 when the CLI
   * schema is updated or we find a workaround. The SDK path still receives
   * team events via JS callbacks; PTY team-event observation is deferred.
   */
  teamEvents?: boolean;
}

/**
 * Build the `Stop` hook command that writes the sentinel file.
 *
 * The hook runs through the shell, so the command has to exist on the host OS:
 *
 *   - `cat` is not available on Windows, where hooks are executed by `cmd` —
 *     the command fails, the sentinel is never written, and the PTY watcher
 *     waits forever for a turn that already finished.
 *   - An unquoted path breaks as soon as the temp dir contains a space (the OS
 *     temp dir commonly does). Quoting also keeps shell metacharacters in the
 *     path from being interpreted.
 *
 * The hook receives its JSON payload on stdin; the sentinel only has to change
 * for the watcher to fire, so the payload itself is not needed.
 */
export function buildStopHookCommand(
  sentinelPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    // PowerShell single-quoted strings escape ' by doubling it.
    const escapedPath = sentinelPath.replace(/'/g, "''");
    return `powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${escapedPath}' -Value stop -Encoding UTF8"`;
  }
  // POSIX: close the single-quoted string, append an escaped quote, reopen.
  const escapedPath = sentinelPath.replace(/'/g, `'"'"'`);
  return `cat > '${escapedPath}'`;
}

/**
 * Create a new PtyHookBridge instance. Each instance owns a temp directory
 * for its sentinel/event files and generated settings.json.
 */
export function createHookBridge(options?: HookBridgeOptions): PtyHookBridge {
  const enableTeamEvents = options?.teamEvents === true;

  const bridgeId = randomUUID().slice(0, 8);
  const bridgeDir = join(tmpdir(), `metabot-pty-${bridgeId}`);
  mkdirSync(bridgeDir, { recursive: true });

  const sentinelPath = join(bridgeDir, 'stop.flag');
  const teamEventPath = join(bridgeDir, 'team-events.jsonl');
  const settingsPath = join(bridgeDir, 'settings.json');

  let turnCb: (() => void) | null = null;
  let teamCb: ((event: { kind: string; payload: unknown }) => void) | null = null;

  let sentinelWatcher: FSWatcher | null = null;
  let teamEventInterval: ReturnType<typeof setInterval> | null = null;
  let teamEventOffset = 0;
  let disposed = false;

  // ── writeSettings ────────────────────────────────────────────────────────

  async function writeSettings(): Promise<string> {
    // Stop hook: Claude pipes hook JSON on stdin to the command, which writes
    // the sentinel file the watcher below polls.
    const stopCommand = buildStopHookCommand(sentinelPath);

    const hooks: Record<string, unknown> = {
      Stop: [
        {
          hooks: [{ type: 'command', command: stopCommand }],
        },
      ],
    };

    // phase 2: team-event hooks are rejected by the current claude CLI
    // settings validator. Only include them when explicitly opted in.
    if (enableTeamEvents) {
      const taskCreatedCommand = `{ printf '{"kind":"TaskCreated","payload":'; cat; printf '}\\n'; } >> ${teamEventPath}`;
      const taskCompletedCommand = `{ printf '{"kind":"TaskCompleted","payload":'; cat; printf '}\\n'; } >> ${teamEventPath}`;
      const teammateIdleCommand = `{ printf '{"kind":"TeammateIdle","payload":'; cat; printf '}\\n'; } >> ${teamEventPath}`;

      hooks.TaskCreated = [
        { hooks: [{ type: 'command', command: taskCreatedCommand }] },
      ];
      hooks.TaskCompleted = [
        { hooks: [{ type: 'command', command: taskCompletedCommand }] },
      ];
      hooks.TeammateIdle = [
        { hooks: [{ type: 'command', command: teammateIdleCommand }] },
      ];
    }

    const settings = { hooks };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return settingsPath;
  }

  // ── onTurnComplete ───────────────────────────────────────────────────────

  function onTurnComplete(cb: () => void): void {
    turnCb = cb;
    startSentinelWatcher();
  }

  function startSentinelWatcher(): void {
    if (sentinelWatcher || disposed) return;

    // fs.watch fires on file creation/modification.
    // We need to handle the case where the file doesn't exist yet.
    const watchDir = bridgeDir;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    sentinelWatcher = watch(watchDir, (eventType, filename) => {
      if (filename !== 'stop.flag') return;
      // Debounce — fs.watch can fire multiple events for a single write.
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (turnCb && !disposed) {
          turnCb();
        }
      }, 50);
    });

    sentinelWatcher.on('error', () => {
      // Silently ignore watch errors (e.g. dir removed).
    });
  }

  // ── onTeamEvent ──────────────────────────────────────────────────────────

  function onTeamEvent(
    cb: (event: { kind: string; payload: unknown }) => void,
  ): void {
    teamCb = cb;
    startTeamEventTailer();
  }

  function startTeamEventTailer(): void {
    if (teamEventInterval || disposed) return;

    // Poll the team-events JSONL file for new lines (reuse the same
    // byte-offset approach as jsonl-scanner, but simpler inline version).
    teamEventInterval = setInterval(() => {
      if (disposed || !teamCb) return;
      if (!existsSync(teamEventPath)) return;

      let size: number;
      try {
        size = statSync(teamEventPath).size;
      } catch {
        return;
      }
      if (size <= teamEventOffset) return;

      const bytesToRead = size - teamEventOffset;
      const buf = Buffer.alloc(bytesToRead);
      let fd: number | undefined;
      try {
        fd = openSync(teamEventPath, 'r');
        readSync(fd, buf, 0, bytesToRead, teamEventOffset);
      } catch {
        return;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      teamEventOffset = size;

      const lines = buf.toString('utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed) as { kind: string; payload: unknown };
          if (evt.kind && teamCb) {
            teamCb(evt);
          }
        } catch {
          // Malformed line — skip.
        }
      }
    }, 200);
  }

  // ── dispose ──────────────────────────────────────────────────────────────

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;

    if (sentinelWatcher) {
      sentinelWatcher.close();
      sentinelWatcher = null;
    }
    if (teamEventInterval) {
      clearInterval(teamEventInterval);
      teamEventInterval = null;
    }

    // Clean up temp directory.
    try {
      rmSync(bridgeDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  return {
    writeSettings,
    onTurnComplete,
    onTeamEvent,
    dispose,
  };
}
