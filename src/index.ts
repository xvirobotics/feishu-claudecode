import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadAppConfig, type BotConfig } from './config.js';
import { createLogger, type Logger } from './utils/logger.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { MessageSender } from './feishu/message-sender.js';
import { FeishuSenderAdapter } from './feishu/feishu-sender-adapter.js';
import { MessageBridge } from './bridge/message-bridge.js';
import type { IMessageSender } from './bridge/message-sender.interface.js';
import type { BotConfigBase } from './config.js';
import { startTelegramBot, type TelegramBotHandle } from './telegram/telegram-bot.js';
import { BotRegistry } from './api/bot-registry.js';
import { TaskScheduler } from './scheduler/task-scheduler.js';
import { startApiServer } from './api/http-server.js';
import { startMemoryServer } from './memory/memory-server.js';
import { DocSync } from './sync/doc-sync.js';
import { MemoryClient } from './memory/memory-client.js';

interface FeishuBotHandle {
  name: string;
  bridge: MessageBridge;
  wsClient: lark.WSClient;
  config: BotConfigBase;
  sender: IMessageSender;
  feishuClient: lark.Client;
}

async function startFeishuBot(botConfig: BotConfig, logger: Logger, memoryServerUrl: string, memorySecret?: string): Promise<FeishuBotHandle> {
  const botLogger = logger.child({ bot: botConfig.name });

  botLogger.info('Starting Feishu bot...');

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
      botLogger.warn('Could not get bot open_id. Ensure the Feishu app has Bot capability enabled and the app version is published.');
    }
  } catch (err: any) {
    botLogger.warn({ err: err?.message || err }, 'Failed to fetch bot info. Check: 1) Bot capability is enabled in Feishu app 2) App is published 3) App credentials are correct');
  }

  // Create sender and bridge (FeishuSenderAdapter wraps the Feishu-specific MessageSender)
  const rawSender = new MessageSender(client, botLogger);
  const sender = new FeishuSenderAdapter(rawSender);
  const bridge = new MessageBridge(botConfig, botLogger, sender, memoryServerUrl, memorySecret);

  // Create event dispatcher wired to the bridge
  const dispatcher = createEventDispatcher(botConfig, botLogger, (msg) => {
    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, msg }, 'Unhandled error in message bridge');
    });
  }, botOpenId, rawSender);

  // Create WebSocket client
  const wsClient = new lark.WSClient({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  // Start WebSocket connection with event dispatcher
  await wsClient.start({ eventDispatcher: dispatcher });

  botLogger.info('Feishu bot is running');
  botLogger.info({
    defaultWorkingDirectory: botConfig.claude.defaultWorkingDirectory,
    allowedTools: botConfig.claude.allowedTools,
    maxTurns: botConfig.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: botConfig.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return { name: botConfig.name, bridge, wsClient, config: botConfig, sender, feishuClient: client };
}

async function main() {
  const appConfig = loadAppConfig();
  const logger = createLogger(appConfig.log.level);

  // Ensure MEMORY_SECRET env var is available for Claude subprocesses (used by metamemory skill)
  if (appConfig.memory.secret && !process.env.MEMORY_SECRET) {
    process.env.MEMORY_SECRET = appConfig.memory.secret;
  }

  const feishuCount = appConfig.feishuBots.length;
  const telegramCount = appConfig.telegramBots.length;
  logger.info({ feishuBots: feishuCount, telegramBots: telegramCount, memoryServerUrl: appConfig.memoryServerUrl }, 'Starting MetaBot bridge...');

  // Create bot registry
  const registry = new BotRegistry();

  // Start bots independently so a single platform/API timeout does not
  // take down the whole MetaBot process.
  const feishuHandles = feishuCount > 0
    ? await startBotsSafely(
      appConfig.feishuBots,
      (bot) => startFeishuBot(bot, logger, appConfig.memoryServerUrl, appConfig.memory.secret || undefined),
      logger,
      'feishu',
    )
    : [];

  const telegramHandles = telegramCount > 0
    ? await startBotsSafely(
      appConfig.telegramBots,
      (bot) => startTelegramBot(bot, logger, appConfig.memoryServerUrl, appConfig.memory.secret || undefined),
      logger,
      'telegram',
    )
    : [];

  // Register all bots in the registry
  for (const handle of feishuHandles) {
    registry.register({
      name: handle.name,
      platform: 'feishu',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
      feishuClient: handle.feishuClient,
    });
  }

  for (const handle of telegramHandles) {
    registry.register({
      name: handle.name,
      platform: 'telegram',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
    });
  }

  const allNames = [...feishuHandles.map((h) => h.name), ...telegramHandles.map((h) => h.name)];
  logger.info({ bots: allNames }, 'All bots started');

  // Create task scheduler
  const scheduler = new TaskScheduler(registry, logger);

  // Start embedded MetaMemory server
  let memoryServer: ReturnType<typeof startMemoryServer> | undefined;
  if (appConfig.memory.enabled) {
    memoryServer = startMemoryServer({
      port: appConfig.memory.port,
      databaseDir: appConfig.memory.databaseDir,
      secret: appConfig.memory.secret || undefined,
      adminToken: appConfig.memory.adminToken,
      readerToken: appConfig.memory.readerToken,
      logger,
    });
  }

  // Create a dedicated Feishu service client for wiki sync & doc reader
  let feishuServiceClient: lark.Client | undefined;
  if (appConfig.feishuService) {
    feishuServiceClient = new lark.Client({
      appId: appConfig.feishuService.appId,
      appSecret: appConfig.feishuService.appSecret,
      disableTokenCache: false,
    });
    logger.info('Feishu service client initialized (for wiki sync & doc reader)');
  }

  // Initialize wiki sync service (uses dedicated service app credentials)
  let docSync: DocSync | undefined;
  if (appConfig.feishuService && process.env.WIKI_SYNC_ENABLED !== 'false') {
    const syncMemoryClient = new MemoryClient(appConfig.memoryServerUrl, logger, appConfig.memory.secret || undefined);
    docSync = new DocSync(
      {
        feishuAppId: appConfig.feishuService.appId,
        feishuAppSecret: appConfig.feishuService.appSecret,
        databaseDir: appConfig.memory.databaseDir,
        wikiSpaceName: process.env.WIKI_SPACE_NAME || 'MetaMemory',
        wikiSpaceId: process.env.WIKI_SPACE_ID || undefined,
        throttleMs: process.env.WIKI_SYNC_THROTTLE_MS ? parseInt(process.env.WIKI_SYNC_THROTTLE_MS, 10) : undefined,
      },
      syncMemoryClient,
      logger,
    );
    // Inject into all Feishu bot bridges
    for (const handle of feishuHandles) {
      handle.bridge.setDocSync(docSync);
    }
    // Enable auto wiki sync on MetaMemory changes (debounced)
    if (process.env.WIKI_AUTO_SYNC !== 'false') {
      const debounceMs = process.env.WIKI_AUTO_SYNC_DEBOUNCE_MS
        ? parseInt(process.env.WIKI_AUTO_SYNC_DEBOUNCE_MS, 10)
        : 5000;
      docSync.startAutoSync(debounceMs);
    }
    logger.info('Wiki sync service initialized (auto-sync enabled, /sync for manual trigger)');
  }

  // Resolve bots config path for API-driven bot CRUD
  const botsConfigPath = process.env.BOTS_CONFIG
    ? path.resolve(process.env.BOTS_CONFIG)
    : undefined;

  // Start API server
  const apiServer = startApiServer({
    port: appConfig.api.port,
    secret: appConfig.api.secret,
    registry,
    scheduler,
    logger,
    botsConfigPath,
    docSync,
    feishuServiceClient,
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    scheduler.destroy();
    apiServer.close();
    if (docSync) {
      docSync.destroy();
    }
    if (memoryServer) {
      memoryServer.server.close();
      memoryServer.storage.close();
    }
    for (const handle of feishuHandles) {
      handle.bridge.destroy();
    }
    for (const handle of telegramHandles) {
      handle.bridge.destroy();
      handle.bot.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startBotsSafely<TConfig extends BotConfigBase, THandle>(
  bots: TConfig[],
  starter: (bot: TConfig) => Promise<THandle>,
  logger: Logger,
  platform: 'feishu' | 'telegram',
): Promise<THandle[]> {
  const results = await Promise.allSettled(bots.map((bot) => starter(bot)));
  const handles: THandle[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const bot = bots[i];
    if (!result || !bot) continue;

    if (result.status === 'fulfilled') {
      handles.push(result.value);
      continue;
    }

    logger.error(
      { err: result.reason, botName: bot.name, platform },
      'Failed to start bot; continuing with remaining bots',
    );
  }

  return handles;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
