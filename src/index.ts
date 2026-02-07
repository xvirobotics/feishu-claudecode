import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { MessageSender } from './feishu/message-sender.js';
import { MessageBridge } from './bridge/message-bridge.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.log.level);

  logger.info('Starting feishu-claudecode bridge...');

  // Create Feishu API client
  const client = new lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    disableTokenCache: false,
  });

  // Create sender and bridge
  const sender = new MessageSender(client, logger);
  const bridge = new MessageBridge(config, logger, sender);

  // Create event dispatcher wired to the bridge
  const dispatcher = createEventDispatcher(config, logger, (msg) => {
    bridge.handleMessage(msg).catch((err) => {
      logger.error({ err, msg }, 'Unhandled error in message bridge');
    });
  });

  // Create WebSocket client
  const wsClient = new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  // Start WebSocket connection with event dispatcher
  await wsClient.start({ eventDispatcher: dispatcher });

  logger.info('feishu-claudecode bridge is running');
  logger.info({
    defaultWorkingDirectory: config.claude.defaultWorkingDirectory || '(not set)',
    allowedTools: config.claude.allowedTools,
    maxTurns: config.claude.maxTurns,
    maxBudgetUsd: config.claude.maxBudgetUsd,
  }, 'Configuration');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    bridge.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
