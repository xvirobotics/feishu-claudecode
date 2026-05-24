import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { startTelegramBot } from './telegram/telegram-bot.js';
import { startWechatBot } from './wechat/wechat-bot.js';
import { BotRegistry } from './api/bot-registry.js';
import { NullSender } from './web/null-sender.js';
import { PeerManager } from './api/peer-manager.js';
import { TaskScheduler } from './scheduler/task-scheduler.js';
import { startApiServer } from './api/http-server.js';
import { startMemoryServer } from './memory/memory-server.js';
import { DocSync } from './sync/doc-sync.js';
import { MemoryClient } from './memory/memory-client.js';
import { CloudClient } from './cluster/cloud-client.js';
import { createRoutes as createDispatcherRoutes } from './cluster/dispatcher.js';
import type { BotMeta } from '@metabot/shared';

import { SessionRegistry } from './session/session-registry.js';

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
  const dispatcher = createEventDispatcher(
    botConfig,
    botLogger,
    (msg) => {
      bridge.handleMessage(msg).catch((err) => {
        botLogger.error({ err, msg }, 'Unhandled error in message bridge');
      });
    },
    botOpenId,
    rawSender,
    (event) => {
      bridge.handleCardAction(event).catch((err) => {
        botLogger.error({ err, event }, 'Unhandled error in card action handler');
      });
    },
  );

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
  if (appConfig.memory.instanceToken && !process.env.MEMORY_INSTANCE_TOKEN) {
    process.env.MEMORY_INSTANCE_TOKEN = appConfig.memory.instanceToken;
  }

  const feishuCount = appConfig.feishuBots.length;
  const telegramCount = appConfig.telegramBots.length;
  const wechatCount = appConfig.wechatBots.length;
  logger.info({ feishuBots: feishuCount, telegramBots: telegramCount, wechatBots: wechatCount, memoryServerUrl: appConfig.memoryServerUrl }, 'Starting MetaBot bridge...');

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

  const wechatHandles = wechatCount > 0
    ? await startBotsSafely(
      appConfig.wechatBots,
      (bot) => startWechatBot(bot, logger, appConfig.memoryServerUrl, appConfig.memory.secret || undefined),
      logger,
      'wechat',
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

  // Register web-only bots (no IM platform — accessible via Web UI only)
  for (const webConfig of appConfig.webBots) {
    const botLogger = logger.child({ bot: webConfig.name });
    const sender = new NullSender();
    const bridge = new MessageBridge(webConfig, botLogger, sender, appConfig.memoryServerUrl, appConfig.memory.secret || undefined);
    registry.register({ name: webConfig.name, platform: 'web', config: webConfig, bridge, sender });
  }

  for (const handle of wechatHandles) {
    registry.register({
      name: handle.name,
      platform: 'wechat',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
    });
  }

  const allNames = [
    ...feishuHandles.map((h) => h.name),
    ...telegramHandles.map((h) => h.name),
    ...appConfig.webBots.map((b) => b.name),
    ...wechatHandles.map((h) => h.name),
  ];
  logger.info({ bots: allNames }, 'All bots started');

  // Create task scheduler
  const scheduler = new TaskScheduler(registry, logger);

  // Initialize peer manager for cross-instance bot discovery
  let peerManager: PeerManager | undefined;
  if (appConfig.peers.length > 0) {
    peerManager = new PeerManager(appConfig.peers, logger);
    await peerManager.refreshAll();
    const statuses = peerManager.getPeerStatuses();
    const healthyCount = statuses.filter((s) => s.healthy).length;
    logger.info({ peerCount: statuses.length, healthyPeers: healthyCount }, 'Peer manager initialized');
  }

  // Start embedded MetaMemory server
  let memoryServer: ReturnType<typeof startMemoryServer> | undefined;
  if (appConfig.memory.enabled) {
    memoryServer = startMemoryServer({
      port: appConfig.memory.port,
      databaseDir: appConfig.memory.databaseDir,
      secret: appConfig.memory.secret || undefined,
      adminToken: appConfig.memory.adminToken,
      readerToken: appConfig.memory.readerToken,
      instanceToken: appConfig.memory.instanceToken,
      instanceId: appConfig.instance.instanceId,
      memoryNamespace: appConfig.memory.namespace,
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

  // Initialize cross-platform session registry
  const sessionRegistry = new SessionRegistry(logger);
  // Inject session registry + scheduler into all bot bridges so the
  // slash-command layer (`/<N>`, `/0`) can queue per-chat deferred
  // sends. Setter injection, because both objects are process-singletons
  // built after the bot registry is populated.
  for (const info of registry.list()) {
    const bot = registry.get(info.name);
    if (bot) {
      bot.bridge.setSessionRegistry(sessionRegistry);
      bot.bridge.setScheduler(scheduler);
    }
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
    peerManager,
    memoryServerUrl: appConfig.memoryServerUrl,
    memoryAuthToken: appConfig.memory.adminToken || appConfig.memory.readerToken || appConfig.memory.secret || undefined,
    instance: appConfig.instance,
    sessionRegistry,
  });

  // ─── Pending-switch: detect project switch and inject sessionId/history ─────
  // After all bots are registered, check if there's a pending-switch.json
  // written by 01-switch-bot.sh or /api/bots/:name/switch endpoint before restart.
  {
    const botName = process.env.BOT_NAME;
    if (botName) {
      const dataDir = process.env.METABOT_DATA_DIR || path.join(os.homedir(), '.metabot', botName);
      const pendingSwitchPath = path.join(dataDir, 'pending-switch.json');
      if (fs.existsSync(pendingSwitchPath)) {
        try {
          const switchData = JSON.parse(fs.readFileSync(pendingSwitchPath, 'utf-8'));
          const { chatId, workDir, sessionId, recentHistory } = switchData as {
            chatId?:        string;
            workDir?:       string;
            sessionId?:     string;
            recentHistory?: Array<{ role: string; content: string }>;
          };
          logger.info({ botName, chatId, workDir, sessionId }, 'Processing pending project switch');

          const bot = registry.get(botName);
          if (bot) {
            if (chatId && sessionId) {
              // chatId known — inject sessionId immediately
              bot.bridge.getSessionManager().setSessionId(chatId, sessionId, 'claude');
              logger.info({ botName, chatId, sessionId: sessionId.slice(0, 8) }, 'Injected sessionId from pending switch');

              if (recentHistory && recentHistory.length > 0) {
                const lines: string[] = [
                  `**项目已切换** → \`${workDir}\``,
                  `Session: \`${sessionId.slice(0, 8)}...\`\n`,
                  '**最近对话历史：**',
                  '---',
                ];
                for (const msg of recentHistory) {
                  const prefix = msg.role === 'user' ? '👤 **用户**' : '🤖 **助手**';
                  const text   = msg.content.length > 300
                    ? msg.content.slice(0, 300) + '...'
                    : msg.content;
                  lines.push(`${prefix}：${text}\n`);
                }
                bot.sender.sendTextNotice(chatId, '项目切换完成', lines.join('\n'), 'green')
                  .catch((err: any) => logger.warn({ err: err?.message, botName }, 'Failed to push switch history'));
                logger.info({ botName, chatId, historyLen: recentHistory.length }, 'Switch history pushed');
              }
            } else {
              // chatId unknown — defer to first incoming message
              bot.bridge.pendingSwitchNotice = { workDir, sessionId, recentHistory };
              logger.info({ botName, sessionId: sessionId?.slice(0, 8), historyLen: recentHistory?.length || 0 }, 'Switch notice deferred to first message');
            }
          }

          fs.unlinkSync(pendingSwitchPath);
          logger.info({ botName }, 'Pending switch processed and cleaned up');
        } catch (err: any) {
          logger.warn({ err: err?.message, botName }, 'Failed to process pending switch');
          try { fs.unlinkSync(pendingSwitchPath); } catch { /* ignore */ }
        }
      }
    }
  }

  // Cloud-split (PR-4 + PR-5b): dial out to the cloud relay when any bot has
  // cloudUrl set. PR-4 ships a single client per process — the first cloudUrl
  // wins. Multi-bot multi-cloudUrl handling is deferred to a later PR.
  //
  // PR-5b wires the dispatcher to the real SessionRegistry + BotRegistry so
  // inbound `transcript.get` / `sessions.list` request frames return real
  // payloads instead of 501; and broadcasts the CloudClient to every bridge
  // so transcript-card links rewrite to the cloud-assigned base after
  // `register_ack` lands.
  const cloudUrlBot = appConfig.feishuBots.find((b) => b.cloudUrl && b.cloudUrl.trim());
  let cloudClient: CloudClient | undefined;
  if (cloudUrlBot && cloudUrlBot.cloudUrl) {
    const allFeishuBots: BotMeta[] = appConfig.feishuBots.map((b) => ({
      name: b.name,
      hubVisible: Boolean(b.hubVisible),
      ...(b.accessAllowOpenIds?.length ? { accessAllowOpenIds: b.accessAllowOpenIds } : {}),
      // Ship Feishu OAuth credentials to cloud so it can host its own
      // /api/auth/feishu/{login,callback} routes (memory-only on cloud side).
      ...(b.feishu?.appId ? { feishuAppId: b.feishu.appId } : {}),
      ...(b.feishu?.appSecret ? { feishuAppSecret: b.feishu.appSecret } : {}),
    }));
    if (!appConfig.instance.publicKey || !appConfig.instance.privateKeyPath) {
      logger.warn('cloud-client: skipping — instance identity has no ed25519 keypair on disk');
    } else {
      const dispatcherRoutes = createDispatcherRoutes({
        sessionRegistry,
        botRegistry: registry,
      });
      cloudClient = new CloudClient({
        cloudUrl: cloudUrlBot.cloudUrl,
        instanceId: appConfig.instance.instanceId,
        publicKey: appConfig.instance.publicKey,
        privateKeyPath: appConfig.instance.privateKeyPath,
        version: getMetabotVersion(),
        bots: allFeishuBots,
        logger,
        routes: dispatcherRoutes,
      });
      cloudClient.connect();
      // Broadcast to every bridge so card links pick up the cloud base URL
      // once `register_ack` resolves it. Done unconditionally — the bridge
      // falls back to local `publicBaseUrl` while `getPublicBaseUrl()` is
      // still undefined.
      for (const info of registry.list()) {
        const bot = registry.get(info.name);
        if (bot) bot.bridge.setCloudClient(cloudClient);
      }
    }
  } else {
    logger.info('cloud-client: no cloudUrl configured, skipping cloud relay');
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    scheduler.destroy();
    if (peerManager) {
      peerManager.destroy();
    }
    if (cloudClient) {
      cloudClient.disconnect();
    }
    apiServer.close();
    if (docSync) {
      docSync.destroy();
    }
    sessionRegistry.close();
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
    for (const handle of wechatHandles) {
      handle.bridge.destroy();
      handle.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Windows: PM2 sends 'shutdown' message instead of SIGTERM
  process.on('message', (msg: any) => {
    if (msg === 'shutdown') {
      logger.info('Received PM2 shutdown message');
      shutdown();
    }
  });
}

function getMetabotVersion(): string {
  try {
    // Resolve package.json relative to compiled dist/index.js OR tsx src/index.ts
    const candidates = [
      path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'),
      path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // fall through to default
  }
  return '0.0.0';
}

async function startBotsSafely<TConfig extends BotConfigBase, THandle>(
  bots: TConfig[],
  starter: (bot: TConfig) => Promise<THandle>,
  logger: Logger,
  platform: 'feishu' | 'telegram' | 'wechat',
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
