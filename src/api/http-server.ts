import * as fs from 'node:fs';
import * as http from 'node:http';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from './bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import { addBot, removeBot, getBotEntry } from './bots-config-writer.js';
import { installSkillsToWorkDir } from './skills-installer.js';
import { metrics } from '../utils/metrics.js';

interface ApiServerOptions {
  port: number;
  secret?: string;
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
}

interface JsonBody {
  [key: string]: unknown;
}

const startTime = Date.now();

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

class PayloadTooLargeError extends Error {
  statusCode = 413;
  constructor() { super('Request body too large (max 1 MB)'); }
}

async function parseJsonBody(req: http.IncomingMessage): Promise<JsonBody> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw) as JsonBody;
  } catch {
    throw Object.assign(new Error('Invalid JSON in request body'), { statusCode: 400 });
  }
}

export function startApiServer(options: ApiServerOptions): http.Server {
  const { port, secret, registry, scheduler, logger, botsConfigPath } = options;
  const host = secret ? '0.0.0.0' : '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    // Auth check if secret is configured
    if (secret) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${secret}`) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    try {
      // Route: GET /api/health
      if (method === 'GET' && url === '/api/health') {
        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          bots: registry.list().length,
          scheduledTasks: scheduler.taskCount(),
        });
        return;
      }

      // Route: GET /api/bots
      if (method === 'GET' && url === '/api/bots') {
        jsonResponse(res, 200, { bots: registry.list() });
        return;
      }

      // Route: POST /api/tasks
      if (method === 'POST' && url === '/api/tasks') {
        const body = await parseJsonBody(req);
        const botName = body.botName as string;
        const chatId = body.chatId as string;
        const prompt = body.prompt as string;
        const sendCards = body.sendCards as boolean | undefined;

        if (!botName || !chatId || !prompt) {
          jsonResponse(res, 400, { error: 'Missing required fields: botName, chatId, prompt' });
          return;
        }

        const bot = registry.get(botName);
        if (!bot) {
          jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
          return;
        }

        logger.info({ botName, chatId, promptLength: prompt.length }, 'API task request');

        const result = await bot.bridge.executeApiTask({
          prompt,
          chatId,
          userId: 'api',
          sendCards: sendCards ?? false,
        });

        jsonResponse(res, result.success ? 200 : 500, result);
        return;
      }

      // Route: POST /api/schedule
      if (method === 'POST' && url === '/api/schedule') {
        const body = await parseJsonBody(req);
        const botName = body.botName as string;
        const chatId = body.chatId as string;
        const prompt = body.prompt as string;
        const delaySeconds = body.delaySeconds as number;
        const sendCards = body.sendCards as boolean | undefined;
        const label = body.label as string | undefined;

        if (!botName || !chatId || !prompt || typeof delaySeconds !== 'number' || delaySeconds <= 0) {
          jsonResponse(res, 400, { error: 'Missing or invalid fields: botName, chatId, prompt, delaySeconds (positive number)' });
          return;
        }

        const bot = registry.get(botName);
        if (!bot) {
          jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
          return;
        }

        const task = scheduler.scheduleTask({
          botName,
          chatId,
          prompt,
          delaySeconds,
          sendCards,
          label,
        });

        jsonResponse(res, 201, {
          id: task.id,
          botName: task.botName,
          chatId: task.chatId,
          prompt: task.prompt,
          executeAt: new Date(task.executeAt).toISOString(),
          sendCards: task.sendCards,
          label: task.label,
          status: task.status,
        });
        return;
      }

      // Route: GET /api/schedule
      if (method === 'GET' && url === '/api/schedule') {
        const tasks = scheduler.listTasks().map((t) => ({
          id: t.id,
          botName: t.botName,
          chatId: t.chatId,
          prompt: t.prompt,
          executeAt: new Date(t.executeAt).toISOString(),
          sendCards: t.sendCards,
          label: t.label,
          status: t.status,
          createdAt: new Date(t.createdAt).toISOString(),
        }));
        jsonResponse(res, 200, { tasks });
        return;
      }

      // Route: PATCH /api/schedule/:id
      if (method === 'PATCH' && url.startsWith('/api/schedule/')) {
        const id = url.slice('/api/schedule/'.length);
        if (!id) {
          jsonResponse(res, 400, { error: 'Missing task ID' });
          return;
        }

        const body = await parseJsonBody(req);
        const updated = scheduler.updateTask(id, {
          prompt: body.prompt as string | undefined,
          delaySeconds: body.delaySeconds as number | undefined,
          label: body.label as string | undefined,
          sendCards: body.sendCards as boolean | undefined,
        });

        if (updated) {
          jsonResponse(res, 200, {
            id: updated.id,
            botName: updated.botName,
            chatId: updated.chatId,
            prompt: updated.prompt,
            executeAt: new Date(updated.executeAt).toISOString(),
            sendCards: updated.sendCards,
            label: updated.label,
            status: updated.status,
          });
        } else {
          jsonResponse(res, 404, { error: `Task not found or not updatable: ${id}` });
        }
        return;
      }

      // Route: DELETE /api/schedule/:id
      if (method === 'DELETE' && url.startsWith('/api/schedule/')) {
        const id = url.slice('/api/schedule/'.length);
        if (!id) {
          jsonResponse(res, 400, { error: 'Missing task ID' });
          return;
        }

        const cancelled = scheduler.cancelTask(id);
        if (cancelled) {
          jsonResponse(res, 200, { id, status: 'cancelled' });
        } else {
          jsonResponse(res, 404, { error: `Task not found or not cancellable: ${id}` });
        }
        return;
      }

      // Route: POST /api/bots — create a new bot
      if (method === 'POST' && url === '/api/bots') {
        if (!botsConfigPath) {
          jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
          return;
        }
        const body = await parseJsonBody(req);
        const platform = body.platform as string;
        const name = body.name as string;

        if (!platform || !name) {
          jsonResponse(res, 400, { error: 'Missing required fields: platform, name' });
          return;
        }
        if (platform !== 'feishu' && platform !== 'telegram') {
          jsonResponse(res, 400, { error: 'platform must be "feishu" or "telegram"' });
          return;
        }

        let entry: Record<string, unknown>;
        if (platform === 'feishu') {
          const appId = body.feishuAppId as string;
          const appSecret = body.feishuAppSecret as string;
          const workDir = body.defaultWorkingDirectory as string;
          if (!appId || !appSecret || !workDir) {
            jsonResponse(res, 400, { error: 'Feishu bot requires: feishuAppId, feishuAppSecret, defaultWorkingDirectory' });
            return;
          }
          entry = {
            name,
            feishuAppId: appId,
            feishuAppSecret: appSecret,
            defaultWorkingDirectory: workDir,
            ...(body.allowedTools ? { allowedTools: body.allowedTools } : {}),
            ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
            ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
            ...(body.model ? { model: body.model } : {}),
          };
        } else {
          const token = body.telegramBotToken as string;
          const workDir = body.defaultWorkingDirectory as string;
          if (!token || !workDir) {
            jsonResponse(res, 400, { error: 'Telegram bot requires: telegramBotToken, defaultWorkingDirectory' });
            return;
          }
          entry = {
            name,
            telegramBotToken: token,
            defaultWorkingDirectory: workDir,
            ...(body.allowedTools ? { allowedTools: body.allowedTools } : {}),
            ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
            ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
            ...(body.model ? { model: body.model } : {}),
          };
        }

        try {
          // Ensure working directory exists
          const workDir = (body.defaultWorkingDirectory as string);
          fs.mkdirSync(workDir, { recursive: true });

          addBot(botsConfigPath, platform, entry as any);
          logger.info({ name, platform }, 'Bot added to config');

          // Optionally install skills
          if (body.installSkills) {
            installSkillsToWorkDir(workDir, logger);
          }

          jsonResponse(res, 201, {
            name,
            platform,
            workingDirectory: workDir,
            message: 'Bot added. PM2 will restart to activate it.',
          });
        } catch (err: any) {
          if (err.message?.includes('already exists')) {
            jsonResponse(res, 409, { error: err.message });
          } else {
            throw err;
          }
        }
        return;
      }

      // Route: GET /api/bots/:name — get bot details
      if (method === 'GET' && url.startsWith('/api/bots/')) {
        const name = decodeURIComponent(url.slice('/api/bots/'.length));
        if (!name) {
          jsonResponse(res, 400, { error: 'Missing bot name' });
          return;
        }

        // Check running registry first
        const running = registry.get(name);
        const runningInfo = running
          ? { running: true, workingDirectory: running.config.claude.defaultWorkingDirectory, allowedTools: running.config.claude.allowedTools }
          : { running: false };

        // Check config file if available
        if (botsConfigPath) {
          const found = getBotEntry(botsConfigPath, name);
          if (found) {
            jsonResponse(res, 200, {
              name,
              platform: found.platform,
              ...runningInfo,
              config: found.entry,
            });
            return;
          }
        }

        if (running) {
          jsonResponse(res, 200, {
            name,
            platform: running.platform,
            ...runningInfo,
          });
          return;
        }

        jsonResponse(res, 404, { error: `Bot not found: ${name}` });
        return;
      }

      // Route: DELETE /api/bots/:name — remove a bot
      if (method === 'DELETE' && url.startsWith('/api/bots/')) {
        const name = decodeURIComponent(url.slice('/api/bots/'.length));
        if (!name) {
          jsonResponse(res, 400, { error: 'Missing bot name' });
          return;
        }
        if (!botsConfigPath) {
          jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
          return;
        }

        try {
          const removed = removeBot(botsConfigPath, name);
          if (!removed) {
            jsonResponse(res, 404, { error: `Bot not found: ${name}` });
            return;
          }
          registry.deregister(name);
          logger.info({ name }, 'Bot removed from config');
          jsonResponse(res, 200, { name, removed: true, message: 'Bot removed. PM2 will restart to deactivate it.' });
        } catch (err: any) {
          if (err.message?.includes('Cannot remove the last bot')) {
            jsonResponse(res, 400, { error: err.message });
          } else {
            throw err;
          }
        }
        return;
      }

      // Route: GET /api/stats — cost and usage aggregation
      if (method === 'GET' && url === '/api/stats') {
        const stats: Record<string, unknown> = {};
        for (const bot of registry.list()) {
          const registered = registry.get(bot.name);
          if (registered?.bridge?.costTracker) {
            stats[bot.name] = registered.bridge.costTracker.getStats();
          }
        }
        jsonResponse(res, 200, stats);
        return;
      }

      // Route: GET /api/metrics — Prometheus exposition format
      if (method === 'GET' && url === '/api/metrics') {
        metrics.setGauge('metabot_uptime_seconds', Math.floor((Date.now() - startTime) / 1000));
        const body = metrics.serialize();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(body);
        return;
      }

      // 404 fallback
      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        logger.error({ err, method, url }, 'API request error');
      }
      jsonResponse(res, statusCode, { error: err.message || 'Internal server error' });
    }
  });

  server.listen(port, host, () => {
    logger.info({ host, port }, 'API server started');
  });

  return server;
}
