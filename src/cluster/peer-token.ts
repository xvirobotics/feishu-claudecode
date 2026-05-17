import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PeerToken {
  token: string;
  path: string;
}

export interface LoadPeerTokenOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function expandUserPath(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function isValidToken(value: string): boolean {
  return /^[a-f0-9]{32,128}$/i.test(value.trim());
}

/**
 * Load or generate a stable reader token for inbound peer handshakes.
 *
 * The token lives at `~/.metabot/peer-token` (override via
 * `METABOT_PEER_TOKEN_PATH`) and is idempotent across restarts: generated
 * once with `randomBytes(32)` and reused thereafter. Tokens are intentionally
 * unauthenticated reader credentials — they grant read-only access to folders
 * whose visibility is non-private (Pragmatic v1, see plan doc Phase 2 / 7).
 */
export function loadPeerToken(options: LoadPeerTokenOptions = {}): PeerToken {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const metabotHome = expandUserPath(env.METABOT_HOME || '~/.metabot', homeDir);
  const tokenPath = expandUserPath(
    env.METABOT_PEER_TOKEN_PATH || path.join(metabotHome, 'peer-token'),
    homeDir,
  );

  try {
    const existing = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (isValidToken(existing)) {
      return { token: existing, path: tokenPath };
    }
  } catch {
    // Missing or invalid file falls through to generation.
  }

  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, path: tokenPath };
}
