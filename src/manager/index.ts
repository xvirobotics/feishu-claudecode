/**
 * metabot-manager entrypoint.
 *
 * Runs as its own PM2 app on `MANAGER_PORT` (default 11000). Independent of
 * any bot — controls bots only via `pm2` shell-outs. Binds to 127.0.0.1 by
 * default. Set `MANAGER_BIND_HOST=0.0.0.0` to expose on LAN (e.g. so a phone
 * on the same Wi-Fi can hit it); we log a loud banner when both
 * `MANAGER_BIND_HOST=0.0.0.0` and `MANAGER_DISABLE_AUTH=true` are set so the
 * operator is aware everyone on the LAN gets unauthenticated access.
 */
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { ensureCredentialsFile, loadManagerEnv } from './credentials.js';
import { startManagerServer } from './server.js';

async function main(): Promise<void> {
  // Hydrate process.env from ~/.metabot/manager.env (only if not set by PM2/shell).
  loadManagerEnv();

  const port = parseInt(process.env.MANAGER_PORT || '11000', 10);
  const host = process.env.MANAGER_BIND_HOST || '127.0.0.1';

  const logger = createLogger(process.env.LOG_LEVEL || 'info').child({ module: 'manager' });

  // First-run: generate admin creds + session secret, log the password loudly.
  const creds = ensureCredentialsFile();

  const ecosystemPath = path.resolve(process.cwd(), 'ecosystem.config.cjs');

  const disableAuth = process.env.MANAGER_DISABLE_AUTH === 'true';

  if (host !== '127.0.0.1' && host !== 'localhost' && disableAuth) {
    const sep = '!'.repeat(72);
    for (const l of [
      sep,
      `  metabot-manager bound to ${host}:${port} with MANAGER_DISABLE_AUTH=true`,
      `  → every device on the network can administer your bots without a password.`,
      `  Only do this on a trusted LAN.`,
      sep,
    ]) process.stderr.write(l + '\n');
  }

  startManagerServer({
    port,
    host,
    creds,
    logger,
    ecosystemPath,
    disableAuth,
  });

  logger.info({ port, host, ecosystem: ecosystemPath, disableAuth }, 'metabot-manager started');
}

main().catch((err) => {
  console.error('metabot-manager fatal:', err);
  process.exit(1);
});
