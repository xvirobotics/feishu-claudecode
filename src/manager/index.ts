/**
 * metabot-manager entrypoint.
 *
 * Runs as its own PM2 app on `MANAGER_PORT` (default 11000). Independent of
 * any bot — controls bots only via `pm2` shell-outs. Binds to 127.0.0.1 by
 * design; expose externally via cloudflared / Caddy if needed.
 */
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { ensureCredentialsFile } from './credentials.js';
import { startManagerServer } from './server.js';

async function main(): Promise<void> {
  const port = parseInt(process.env.MANAGER_PORT || '11000', 10);
  const host = '127.0.0.1';

  const logger = createLogger(process.env.LOG_LEVEL || 'info').child({ module: 'manager' });

  // First-run: generate admin creds + session secret, log the password loudly.
  const creds = ensureCredentialsFile();

  const ecosystemPath = path.resolve(process.cwd(), 'ecosystem.config.cjs');

  startManagerServer({
    port,
    host,
    creds,
    logger,
    ecosystemPath,
  });

  logger.info({ port, host, ecosystem: ecosystemPath }, 'metabot-manager started');
}

main().catch((err) => {
  console.error('metabot-manager fatal:', err);
  process.exit(1);
});
