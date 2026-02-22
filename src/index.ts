import * as lark from '@larksuiteoapi/node-sdk';
import { loadAppConfig, type BotConfig } from './config.js';
import { createLogger, type Logger } from './utils/logger.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { MessageSender } from './feishu/message-sender.js';
import { MessageBridge } from './bridge/message-bridge.js';

interface BotHandle {
  name: string;
  bridge: MessageBridge;
  wsClient: lark.WSClient;
}

async function startBot(botConfig: BotConfig, logger: Logger, memoryServerUrl: string): Promise<BotHandle> {
  const botLogger = logger.child({ bot: botConfig.name });

  botLogger.info('Starting bot...');

  // Create Feishu API client
  const client = new lark.Client({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    disableTokenCache: false,
  });

  // Fetch bot info to get bot's open_id for accurate @mention detection
  let botOpenId: string | undefined;
  try {
    const botInfo: any = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = botInfo?.bot?.open_id;
    if (botOpenId) {
      botLogger.info({ botOpenId }, 'Bot info fetched');
    } else {
      botLogger.warn('Could not get bot open_id, group @mention filtering may be less accurate');
    }
  } catch (err) {
    botLogger.warn({ err }, 'Failed to fetch bot info, group @mention filtering may be less accurate');
  }

  // Create sender and bridge
  const sender = new MessageSender(client, botLogger);
  const bridge = new MessageBridge(botConfig, botLogger, sender, memoryServerUrl);

  // Create event dispatcher wired to the bridge
  const dispatcher = createEventDispatcher(botConfig, botLogger, (msg) => {
    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, msg }, 'Unhandled error in message bridge');
    });
  }, botOpenId);

  // Create WebSocket client
  const wsClient = new lark.WSClient({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  // Start WebSocket connection with event dispatcher
  await wsClient.start({ eventDispatcher: dispatcher });

  botLogger.info('Bot is running');
  botLogger.info({
    defaultWorkingDirectory: botConfig.claude.defaultWorkingDirectory,
    allowedTools: botConfig.claude.allowedTools,
    maxTurns: botConfig.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: botConfig.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return { name: botConfig.name, bridge, wsClient };
}

async function main() {
  const appConfig = loadAppConfig();
  const logger = createLogger(appConfig.log.level);

  logger.info({ botCount: appConfig.bots.length, memoryServerUrl: appConfig.memoryServerUrl }, 'Starting MetaBot bridge...');

  const handles: BotHandle[] = await Promise.all(
    appConfig.bots.map((botConfig) => startBot(botConfig, logger, appConfig.memoryServerUrl)),
  );

  logger.info({ bots: handles.map((h) => h.name) }, 'All bots started');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    for (const handle of handles) {
      handle.bridge.destroy();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
