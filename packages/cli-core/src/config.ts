import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Personal edition default: a metabot-core server running locally. Override
// with METABOT_CORE_URL to point at a remote/self-hosted host.
export const DEFAULT_URL = 'http://localhost:9200';

export interface Config {
  url: string;
  token: string;
}

function readFirstLine(p: string): string | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const line = raw.split(/\r?\n/)[0]?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

export function tokenFilePath(): string {
  return path.join(os.homedir(), '.metabot-core', 'token');
}

export function adminBootstrapTokenFilePath(): string {
  return path.join(os.homedir(), '.metabot-core', 'data', 'admin-bootstrap-token.txt');
}

/**
 * Resolve URL + token.
 *
 * URL precedence:   METABOT_CORE_URL → DEFAULT_URL.
 * Token precedence: METABOT_CORE_TOKEN → ~/.metabot-core/token (first line)
 *                  → metabot-core bootstrap token (first line).
 *
 * Throws when no token is configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = (env.METABOT_CORE_URL || DEFAULT_URL).replace(/\/+$/, '');
  let token = (env.METABOT_CORE_TOKEN || '').trim();
  if (!token) {
    const fromFile = readFirstLine(tokenFilePath());
    if (fromFile) token = fromFile;
  }
  if (!token) {
    const fromBootstrapFile = readFirstLine(adminBootstrapTokenFilePath());
    if (fromBootstrapFile) token = fromBootstrapFile;
  }
  if (!token) {
    throw new Error(
      `no token configured — set METABOT_CORE_TOKEN env var, write the token to ${tokenFilePath()}, or start metabot-core once to generate ${adminBootstrapTokenFilePath()}`,
    );
  }
  return { url, token };
}
