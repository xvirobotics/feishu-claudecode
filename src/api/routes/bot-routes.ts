import * as fs from 'node:fs';
import type * as http from 'node:http';
import { addBot, removeBot, updateBot, getBotEntry, addPeer, removePeer } from '../bots-config-writer.js';
import { installSkillsToWorkDir } from '../skills-installer.js';
import { webBotFromJson } from '../../config.js';
import { resolveEngineName } from '../../engines/index.js';
import { NullSender } from '../../web/null-sender.js';
import { MessageBridge } from '../../bridge/message-bridge.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleBotRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger, botsConfigPath, peerManager, ws } = ctx;

  // GET /api/bots/:name/profile — detailed bot profile with stats
  if (method === 'GET' && /^\/api\/bots\/[^/]+\/profile$/.test(url)) {
    const botName = decodeURIComponent(url.split('/')[3]);
    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }
    const stats = bot.bridge.costTracker.getStats();
    const botStats = stats.byBot[botName];
    jsonResponse(res, 200, {
      name: bot.name,
      description: bot.config.description,
      specialties: bot.config.specialties,
      icon: bot.config.icon,
      platform: bot.platform,
      engine: resolveEngineName(bot.config),
      model: defaultModelForConfig(bot.config),
      workingDirectory: bot.config.claude.defaultWorkingDirectory,
      maxConcurrentTasks: bot.config.maxConcurrentTasks,
      budgetLimitDaily: bot.config.budgetLimitDaily,
      stats: botStats || { totalTasks: 0, completedTasks: 0, failedTasks: 0, totalCostUsd: 0 },
    });
    return true;
  }

  // GET /api/bots
  if (method === 'GET' && url === '/api/bots') {
    const localBots = registry.list();
    const peerBots = peerManager?.getPeerBots() ?? [];
    jsonResponse(res, 200, { bots: [...localBots, ...peerBots] });
    return true;
  }

  // GET /api/peers
  if (method === 'GET' && url === '/api/peers') {
    jsonResponse(res, 200, { peers: peerManager?.getPeerStatuses() ?? [] });
    return true;
  }

  // POST /api/peers — add a static peer at runtime (no restart)
  if (method === 'POST' && url === '/api/peers') {
    if (!peerManager) {
      jsonResponse(res, 400, { error: 'Peering is disabled (no PeerManager configured)' });
      return true;
    }
    const body = await parseJsonBody(req);
    const name = (body.name as string)?.trim();
    const peerUrl = (body.url as string)?.trim();
    const secret = (body.secret as string) || undefined;
    if (!name || !peerUrl) {
      jsonResponse(res, 400, { error: 'Missing required fields: name, url' });
      return true;
    }
    if (!/^https?:\/\//i.test(peerUrl)) {
      jsonResponse(res, 400, { error: 'url must start with http:// or https://' });
      return true;
    }

    peerManager.addPeer({ name, url: peerUrl, ...(secret ? { secret } : {}) });

    // Persist to bots.json so the peer survives a restart (best-effort).
    let persisted = false;
    if (botsConfigPath) {
      try {
        addPeer(botsConfigPath, { name, url: peerUrl, ...(secret ? { secret } : {}) });
        persisted = true;
      } catch (err: any) {
        logger.warn({ name, err: err?.message }, 'peer added in-memory but persisting to bots.json failed');
      }
    }
    logger.info({ name, url: peerUrl, persisted }, 'peer added at runtime');
    jsonResponse(res, 201, {
      name,
      url: peerUrl,
      persisted,
      message: persisted
        ? 'Peer added and persisted. Active immediately, no restart needed.'
        : 'Peer added (in-memory only — set BOTS_CONFIG to persist across restarts).',
    });
    return true;
  }

  // DELETE /api/peers/:name — remove a peer at runtime
  if (method === 'DELETE' && url.startsWith('/api/peers/')) {
    if (!peerManager) {
      jsonResponse(res, 400, { error: 'Peering is disabled (no PeerManager configured)' });
      return true;
    }
    const name = decodeURIComponent(url.slice('/api/peers/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing peer name' });
      return true;
    }
    const removed = peerManager.removePeer(name);
    let persistedRemoval = false;
    if (botsConfigPath) {
      try {
        persistedRemoval = removePeer(botsConfigPath, name);
      } catch (err: any) {
        logger.warn({ name, err: err?.message }, 'peer removed in-memory but updating bots.json failed');
      }
    }
    if (!removed && !persistedRemoval) {
      jsonResponse(res, 404, { error: `Peer not found: ${name}` });
      return true;
    }
    logger.info({ name, persistedRemoval }, 'peer removed at runtime');
    jsonResponse(res, 200, { name, removed: true });
    return true;
  }

  // POST /api/bots — create a new bot
  if (method === 'POST' && url === '/api/bots') {
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }
    const body = await parseJsonBody(req);
    const platform = body.platform as string;
    const name = body.name as string;

    if (!platform || !name) {
      jsonResponse(res, 400, { error: 'Missing required fields: platform, name' });
      return true;
    }
    if (platform !== 'feishu' && platform !== 'telegram' && platform !== 'web' && platform !== 'slack') {
      jsonResponse(res, 400, { error: 'platform must be "feishu", "telegram", "web", or "slack"' });
      return true;
    }

    let entry: Record<string, unknown>;
    if (platform === 'feishu') {
      const appId = body.feishuAppId as string;
      const appSecret = body.feishuAppSecret as string;
      const workDir = body.defaultWorkingDirectory as string;
      if (!appId || !appSecret || !workDir) {
        jsonResponse(res, 400, { error: 'Feishu bot requires: feishuAppId, feishuAppSecret, defaultWorkingDirectory' });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        feishuAppId: appId,
        feishuAppSecret: appSecret,
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    } else if (platform === 'telegram') {
      const token = body.telegramBotToken as string;
      const workDir = body.defaultWorkingDirectory as string;
      if (!token || !workDir) {
        jsonResponse(res, 400, { error: 'Telegram bot requires: telegramBotToken, defaultWorkingDirectory' });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        telegramBotToken: token,
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    } else if (platform === 'web') {
      const workDir = body.defaultWorkingDirectory as string;
      if (!workDir) {
        jsonResponse(res, 400, { error: 'Web bot requires: defaultWorkingDirectory' });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    } else {
      const token = body.slackBotToken as string;
      const signingSecret = body.slackSigningSecret as string;
      const workDir = body.defaultWorkingDirectory as string;
      if (!token || !signingSecret || !workDir) {
        jsonResponse(res, 400, {
          error: 'Slack bot requires: slackBotToken, slackSigningSecret, defaultWorkingDirectory',
        });
        return true;
      }
      entry = {
        name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.engine ? { engine: body.engine } : {}),
        ...(body.codex ? { codex: body.codex } : {}),
        ...(body.kimi ? { kimi: body.kimi } : {}),
        slackBotToken: token,
        slackSigningSecret: signingSecret,
        ...(body.slackBotUserId ? { slackBotUserId: body.slackBotUserId } : {}),
        ...(body.groupNoMention ? { groupNoMention: true } : {}),
        defaultWorkingDirectory: workDir,
        ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
        ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
        ...(body.model ? { model: body.model } : {}),
      };
    }

    try {
      const workDir = body.defaultWorkingDirectory as string;
      fs.mkdirSync(workDir, { recursive: true });

      addBot(botsConfigPath, platform as 'feishu' | 'telegram' | 'web' | 'slack', entry as any);
      logger.info({ name, platform }, 'Bot added to config');

      if (body.installSkills) {
        installSkillsToWorkDir(workDir, logger, { platform: platform as 'feishu' | 'telegram' | 'web' | 'slack' });
      }

      let activated = false;
      if (platform === 'web') {
        const config = webBotFromJson(entry as any);
        const sender = new NullSender();
        const bridge = new MessageBridge(config, logger, sender);
        registry.register({ name, platform: 'web', config, bridge, sender });
        activated = true;
        logger.info({ name }, 'Web bot activated immediately');
        ws.handle?.broadcastBotList();
      }

      jsonResponse(res, 201, {
        name,
        platform,
        workingDirectory: workDir,
        message: activated ? 'Bot added and activated.' : 'Bot added. PM2 will restart to activate it.',
      });
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        jsonResponse(res, 409, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  // PUT /api/bots/:name — update an existing bot
  if (method === 'PUT' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }
    const body = await parseJsonBody(req);
    const updated = updateBot(botsConfigPath, name, body);
    if (!updated) {
      jsonResponse(res, 404, { error: `Bot not found: ${name}` });
      return true;
    }
    logger.info({ name, updates: Object.keys(body) }, 'Bot config updated');
    ws.handle?.broadcastBotList();
    jsonResponse(res, 200, { name, updated: true });
    return true;
  }

  // GET /api/bots/:name
  if (method === 'GET' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }

    const running = registry.get(name);
    const runningInfo = running
      ? { running: true, workingDirectory: running.config.claude.defaultWorkingDirectory }
      : { running: false };

    if (botsConfigPath) {
      const found = getBotEntry(botsConfigPath, name);
      if (found) {
        jsonResponse(res, 200, { name, platform: found.platform, ...runningInfo, config: found.entry });
        return true;
      }
    }

    if (running) {
      jsonResponse(res, 200, { name, platform: running.platform, ...runningInfo });
      return true;
    }

    jsonResponse(res, 404, { error: `Bot not found: ${name}` });
    return true;
  }

  // DELETE /api/bots/:name
  if (method === 'DELETE' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }

    try {
      const removed = removeBot(botsConfigPath, name);
      if (!removed) {
        jsonResponse(res, 404, { error: `Bot not found: ${name}` });
        return true;
      }
      registry.deregister(name);
      logger.info({ name }, 'Bot removed from config');
      ws.handle?.broadcastBotList();
      jsonResponse(res, 200, { name, removed: true, message: 'Bot removed.' });
    } catch (err: any) {
      if (err.message?.includes('Cannot remove the last bot')) {
        jsonResponse(res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  return false;
}

function defaultModelForConfig(config: import('../../config.js').BotConfigBase): string | undefined {
  switch (resolveEngineName(config)) {
    case 'claude':
      return config.claude.model;
    case 'kimi':
      return config.kimi?.model;
    case 'codex':
      return config.codex?.model || config.codex?.displayModel;
  }
}
