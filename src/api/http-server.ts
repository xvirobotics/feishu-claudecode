import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from './bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { DocSync } from '../sync/doc-sync.js';
import { addBot, removeBot, getBotEntry } from './bots-config-writer.js';
import { installSkillsToWorkDir } from './skills-installer.js';
import { webBotFromJson } from '../config.js';
import { NullSender } from '../web/null-sender.js';
import { MessageBridge } from '../bridge/message-bridge.js';
import { metrics } from '../utils/metrics.js';
import { FeishuDocReader } from '../feishu/doc-reader.js';
import type { PeerManager } from './peer-manager.js';
import { handleVoiceRequest } from './voice-handler.js';
import { AsyncTaskStore } from './async-task-store.js';
import { setupWebSocketServer, serveStaticFiles, type WebSocketHandle } from '../web/ws-server.js';
import type { TwilioHandler } from '../twilio/twilio-handler.js';
import type { PushService } from './push-service.js';
import type { DeviceStore } from './device-store.js';
import { IntentRouter } from './intent-router.js';
import { getTeamStatus } from './team-status.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { BudgetManager } from './budget-manager.js';
import { TeamManager } from './team-manager.js';

interface ApiServerOptions {
  port: number;
  secret?: string;
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
  docSync?: DocSync;
  feishuServiceClient?: lark.Client;
  peerManager?: PeerManager;
  memoryServerUrl?: string;
  memoryAuthToken?: string;
  twilioHandler?: TwilioHandler;
  pushService?: PushService;
  deviceStore?: DeviceStore;
  circuitBreaker?: CircuitBreaker;
  budgetManager?: BudgetManager;
  teamManager?: TeamManager;
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrapPreviewHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:20px 24px;color:#1a1a1a;line-height:1.6;font-size:14px;background:#fff}
h1,h2,h3{margin-top:1.2em;margin-bottom:.4em}
h2{font-size:16px;color:#555;border-bottom:1px solid #eee;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f5f5f5;font-weight:600}
tr:nth-child(even){background:#fafafa}
img{max-width:100%}
p{margin:.6em 0}
</style></head><body>${body}</body></html>`;
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
  const { port, secret, registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient, peerManager, memoryServerUrl, memoryAuthToken, twilioHandler, pushService, deviceStore } = options;
  const host = secret ? '0.0.0.0' : '127.0.0.1';
  const asyncTaskStore = new AsyncTaskStore();
  const intentRouter = new IntentRouter(logger);
  const circuitBreaker = options.circuitBreaker ?? new CircuitBreaker(logger);
  const budgetManager = options.budgetManager ?? new BudgetManager(logger);
  const teamManager = options.teamManager ?? new TeamManager(logger);

  // Will be set after WebSocket server is initialized
  const ws: { handle?: WebSocketHandle } = {};

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    // Twilio webhook routes (exempt from Bearer auth — Twilio uses signature validation)
    if (twilioHandler && url.startsWith('/twilio/')) {
      try {
        const handled = await twilioHandler.handleRequest(req, res, url.split('?')[0], method);
        if (handled) return;
      } catch (err: any) {
        logger.error({ err, url }, 'Twilio handler error');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
        return;
      }
    }

    // Auth check if secret is configured (exempt /web/ static files, /memory/ proxy, /api/files/, /twilio/ — WS auth is handled via ?token=)
    if (secret && !url.startsWith('/web') && !url.startsWith('/memory') && !url.startsWith('/api/files/') && !url.startsWith('/twilio/')) {
      const auth = req.headers.authorization;
      // Also support ?token= query param for upload endpoint (like WebSocket does)
      const urlToken = url.includes('token=') ? new URL(url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token') : null;
      if (auth !== `Bearer ${secret}` && urlToken !== secret) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    try {
      // Route: POST /api/call — initiate outbound phone call
      if (method === 'POST' && url === '/api/call') {
        if (!twilioHandler) {
          jsonResponse(res, 400, { error: 'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.' });
          return;
        }

        const body = await parseJsonBody(req);
        const phone = (body.phone as string) || '';
        const message = body.message as string | undefined;
        const botName = (body.botName as string) || 'default';
        const chatId = (body.chatId as string) || `twilio-${phone}`;

        if (!phone) {
          jsonResponse(res, 400, { error: 'Missing required field: phone (E.164 format, e.g. +1234567890)' });
          return;
        }

        const bot = registry.get(botName);
        if (!bot) {
          jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
          return;
        }

        try {
          const result = await twilioHandler.initiateCall({ phone, message, botName, chatId });
          jsonResponse(res, 200, result);
        } catch (err: any) {
          logger.error({ err, phone, botName }, 'Failed to initiate outbound call');
          jsonResponse(res, 500, { error: `Failed to initiate call: ${err.message}` });
        }
        return;
      }

      // Route: POST /api/voice (Whisper STT + Agent + optional TTS)
      // Must be before other routes because it reads raw audio body, not JSON.
      if (method === 'POST' && (url === '/api/voice' || url.startsWith('/api/voice?'))) {
        await handleVoiceRequest(req, res, registry, logger);
        return;
      }

      // Route: POST /api/upload — save uploaded files so Claude can access them
      if (method === 'POST' && (url === '/api/upload' || url.startsWith('/api/upload?'))) {
        const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB
        const chunks: Buffer[] = [];
        let totalSize = 0;

        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > MAX_UPLOAD_SIZE) {
              req.destroy();
              reject(Object.assign(new Error('File too large (max 50 MB)'), { statusCode: 413 }));
              return;
            }
            chunks.push(chunk);
          });
          req.on('end', () => resolve());
          req.on('error', reject);
        });

        const buffer = Buffer.concat(chunks);
        const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const originalName = urlObj.searchParams.get('filename') || 'upload';
        const chatId = urlObj.searchParams.get('chatId') || 'web';

        // Save to /tmp/metabot-uploads/<chatId>/
        const uploadDir = path.join(os.tmpdir(), 'metabot-uploads', chatId);
        fs.mkdirSync(uploadDir, { recursive: true });

        // Sanitize filename
        const safeName = originalName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
        const filePath = path.join(uploadDir, safeName);
        fs.writeFileSync(filePath, buffer);

        logger.info({ chatId, filename: safeName, size: buffer.length }, 'File uploaded');
        jsonResponse(res, 200, { path: filePath, filename: safeName, size: buffer.length });
        return;
      }

      // Route: GET /api/files/preview/<chatId>/<filename> — convert docx/xlsx to HTML for preview
      if (method === 'GET' && url.startsWith('/api/files/preview/')) {
        const filePart = decodeURIComponent(url.slice('/api/files/preview/'.length).split('?')[0]);
        const fullPath = path.resolve(path.join(os.tmpdir(), 'metabot-uploads', filePart));
        const uploadsRoot = path.resolve(path.join(os.tmpdir(), 'metabot-uploads'));

        if (!fullPath.startsWith(uploadsRoot)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        try {
          if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            return;
          }

          const ext = path.extname(fullPath).toLowerCase();
          let html = '';

          if (ext === '.docx') {
            const mammoth = await import('mammoth');
            const result = await mammoth.default.convertToHtml({ path: fullPath });
            html = wrapPreviewHtml(path.basename(fullPath), result.value);
          } else if (ext === '.xlsx' || ext === '.xls') {
            const XLSX = await import('xlsx');
            const workbook = XLSX.read(fs.readFileSync(fullPath));
            const tables: string[] = [];
            for (const name of workbook.SheetNames) {
              const sheet = workbook.Sheets[name];
              tables.push(`<h2>${escapeHtml(name)}</h2>` + XLSX.utils.sheet_to_html(sheet));
            }
            html = wrapPreviewHtml(path.basename(fullPath), tables.join('\n'));
          } else if (ext === '.pptx' || ext === '.ppt') {
            // Try libreoffice conversion
            const { execSync } = await import('child_process');
            const tmpOut = path.join(os.tmpdir(), 'metabot-preview-' + Date.now());
            fs.mkdirSync(tmpOut, { recursive: true });
            try {
              execSync(`soffice --headless --convert-to html --outdir "${tmpOut}" "${fullPath}"`, { timeout: 30000 });
              const htmlFile = fs.readdirSync(tmpOut).find((f: string) => f.endsWith('.html'));
              if (htmlFile) {
                html = fs.readFileSync(path.join(tmpOut, htmlFile), 'utf-8');
              } else {
                throw new Error('LibreOffice conversion produced no output');
              }
            } finally {
              fs.rmSync(tmpOut, { recursive: true, force: true });
            }
          } else {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Unsupported format for preview');
            return;
          }

          const buf = Buffer.from(html, 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': buf.length.toString(),
            'Cache-Control': 'private, max-age=300',
          });
          res.end(buf);
        } catch (err: any) {
          logger.error({ err, path: fullPath }, 'File preview conversion error');
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Conversion failed: ' + (err.message || 'unknown error'));
        }
        return;
      }

      // Route: GET /api/files/<chatId>/<filename> — serve uploaded files for preview/download
      if (method === 'GET' && url.startsWith('/api/files/')) {
        const filePart = decodeURIComponent(url.slice('/api/files/'.length).split('?')[0]);
        const fullPath = path.resolve(path.join(os.tmpdir(), 'metabot-uploads', filePart));
        const uploadsRoot = path.resolve(path.join(os.tmpdir(), 'metabot-uploads'));

        // Security: prevent directory traversal
        if (!fullPath.startsWith(uploadsRoot)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        try {
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const ext = path.extname(fullPath).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
              '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
              '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
              '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
              '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
              '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
              '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
            };
            const contentType = mimeMap[ext] || 'application/octet-stream';
            const content = fs.readFileSync(fullPath);
            const fileName = path.basename(fullPath);
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': content.length.toString(),
              'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
              'Cache-Control': 'private, max-age=3600',
            });
            res.end(content);
            return;
          }
        } catch { /* fall through */ }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }

      // Route: GET /api/health
      if (method === 'GET' && url === '/api/health') {
        const peerStatuses = peerManager?.getPeerStatuses() ?? [];
        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          bots: registry.list().length,
          peerBots: peerManager?.getPeerBots().length ?? 0,
          peers: peerStatuses.length,
          peersHealthy: peerStatuses.filter((p) => p.healthy).length,
          scheduledTasks: scheduler.taskCount(),
          recurringTasks: scheduler.recurringTaskCount(),
        });
        return;
      }

      // Route: GET /api/team/status — aggregated team status
      if (method === 'GET' && url === '/api/team/status') {
        const status = getTeamStatus(registry);
        jsonResponse(res, 200, status);
        return;
      }

      // Route: POST /api/route — route a message to the best bot
      if (method === 'POST' && url === '/api/route') {
        const body = await parseJsonBody(req);
        const message = body.message as string;
        const currentBot = body.currentBot as string | undefined;
        if (!message) {
          jsonResponse(res, 400, { error: 'Missing required field: message' });
          return;
        }
        const allBots = [...registry.list(), ...(peerManager?.getPeerBots() ?? [])];
        const result = await intentRouter.route(message, allBots, currentBot);
        jsonResponse(res, 200, result);
        return;
      }

      // Route: GET /api/router/mode — get current router mode
      if (method === 'GET' && url === '/api/router/mode') {
        jsonResponse(res, 200, { mode: intentRouter.getMode() });
        return;
      }

      // Route: PUT /api/router/mode — set router mode
      if (method === 'PUT' && url === '/api/router/mode') {
        const body = await parseJsonBody(req);
        const mode = body.mode as string;
        if (!['auto', 'suggest', 'manual'].includes(mode)) {
          jsonResponse(res, 400, { error: 'Invalid mode. Use: auto, suggest, manual' });
          return;
        }
        intentRouter.setMode(mode as 'auto' | 'suggest' | 'manual');
        jsonResponse(res, 200, { mode });
        return;
      }

      // Route: GET /api/bots/:name/profile — detailed bot profile with stats
      if (method === 'GET' && /^\/api\/bots\/[^/]+\/profile$/.test(url)) {
        const botName = decodeURIComponent(url.split('/')[3]);
        const bot = registry.get(botName);
        if (!bot) {
          jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
          return;
        }
        const stats = bot.bridge.costTracker.getStats();
        const botStats = stats.byBot[botName];
        jsonResponse(res, 200, {
          name: bot.name,
          description: bot.config.description,
          specialties: bot.config.specialties,
          icon: bot.config.icon,
          platform: bot.platform,
          workingDirectory: bot.config.claude.defaultWorkingDirectory,
          maxConcurrentTasks: bot.config.maxConcurrentTasks,
          budgetLimitDaily: bot.config.budgetLimitDaily,
          stats: botStats || { totalTasks: 0, completedTasks: 0, failedTasks: 0, totalCostUsd: 0 },
        });
        return;
      }

      // Route: POST /api/devices/register — register device for push notifications
      if (method === 'POST' && url === '/api/devices/register') {
        if (!deviceStore) {
          jsonResponse(res, 400, { error: 'Push notifications not configured. Set APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID.' });
          return;
        }
        const body = await parseJsonBody(req);
        const deviceToken = body.deviceToken as string;
        const chatId = body.chatId as string;
        if (!deviceToken || !chatId) {
          jsonResponse(res, 400, { error: 'Missing required fields: deviceToken, chatId' });
          return;
        }
        deviceStore.register(chatId, deviceToken);
        jsonResponse(res, 200, { registered: true });
        return;
      }

      // Route: DELETE /api/devices/register — unregister device from push notifications
      if (method === 'DELETE' && url === '/api/devices/register') {
        if (!deviceStore) {
          jsonResponse(res, 400, { error: 'Push notifications not configured.' });
          return;
        }
        const body = await parseJsonBody(req);
        const deviceToken = body.deviceToken as string;
        if (!deviceToken) {
          jsonResponse(res, 400, { error: 'Missing required field: deviceToken' });
          return;
        }
        deviceStore.unregister(deviceToken);
        jsonResponse(res, 200, { unregistered: true });
        return;
      }

      // Route: GET /api/bots
      if (method === 'GET' && url === '/api/bots') {
        const localBots = registry.list();
        const peerBots = peerManager?.getPeerBots() ?? [];
        jsonResponse(res, 200, { bots: [...localBots, ...peerBots] });
        return;
      }

      // Route: GET /api/peers
      if (method === 'GET' && url === '/api/peers') {
        jsonResponse(res, 200, { peers: peerManager?.getPeerStatuses() ?? [] });
        return;
      }

      // Route: GET /api/talk/:taskId — async task status
      if (method === 'GET' && url.startsWith('/api/talk/')) {
        const taskId = url.slice('/api/talk/'.length).split('?')[0];
        if (!taskId) {
          jsonResponse(res, 400, { error: 'Missing taskId' });
          return;
        }
        const task = asyncTaskStore.get(taskId);
        if (!task) {
          jsonResponse(res, 404, { error: 'Task not found' });
          return;
        }
        jsonResponse(res, 200, {
          taskId: task.id,
          status: task.status,
          botName: task.botName,
          chatId: task.chatId,
          createdAt: new Date(task.createdAt).toISOString(),
          completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
          result: task.result,
        });
        return;
      }

      // Route: POST /api/talk (primary) + POST /api/tasks (deprecated alias)
      if (method === 'POST' && (url === '/api/talk' || url === '/api/tasks')) {
        const body = await parseJsonBody(req);
        const rawBotName = body.botName as string;
        const chatId = body.chatId as string;
        const prompt = body.prompt as string;
        const sendCards = body.sendCards as boolean | undefined;
        const asyncMode = body.async === true;
        const callbackChatId = body.callbackChatId as string | undefined;
        const callbackBotName = body.callbackBotName as string | undefined;

        if (!rawBotName || !chatId || !prompt) {
          jsonResponse(res, 400, { error: 'Missing required fields: botName, chatId, prompt' });
          return;
        }

        // Parse qualified name: "peerName/botName" or just "botName"
        let targetPeerName: string | undefined;
        let botName: string;
        if (rawBotName.includes('/')) {
          const parts = rawBotName.split('/');
          targetPeerName = parts[0];
          botName = parts.slice(1).join('/');
        } else {
          botName = rawBotName;
        }

        // If targeting a specific peer, skip local lookup
        if (targetPeerName) {
          if (!peerManager) {
            jsonResponse(res, 404, { error: `No peers configured, cannot resolve: ${rawBotName}` });
            return;
          }
          const peerMatch = peerManager.findBotOnPeer(targetPeerName, botName);
          if (!peerMatch) {
            jsonResponse(res, 404, { error: `Bot not found on peer "${targetPeerName}": ${botName}` });
            return;
          }
          logger.info({ botName, peerName: targetPeerName, chatId, promptLength: prompt.length }, 'Forwarding talk to peer (qualified)');
          try {
            const result = await peerManager.forwardTask(peerMatch.peer, { botName, chatId, prompt, sendCards });
            const statusCode = (result as any).success === false ? 500 : 200;
            jsonResponse(res, statusCode, result);
          } catch (err: any) {
            logger.error({ err, botName, peerName: targetPeerName }, 'Peer forwarding failed');
            jsonResponse(res, 502, { error: `Peer forwarding failed: ${err.message}` });
          }
          return;
        }

        // Try local registry first
        const bot = registry.get(botName);
        if (bot) {
          // Circuit breaker check
          if (!circuitBreaker.isAvailable(botName)) {
            jsonResponse(res, 503, { error: `Bot "${botName}" is temporarily unavailable (circuit open)` });
            return;
          }

          // Budget check
          const budgetCheck = budgetManager.canAcceptTask(botName);
          if (!budgetCheck.allowed) {
            jsonResponse(res, 429, { error: budgetCheck.reason });
            return;
          }

          logger.info({ botName, chatId, promptLength: prompt.length, asyncMode }, 'API talk request');

          // Async mode: accept immediately, execute in background
          if (asyncMode) {
            const asyncTask = asyncTaskStore.create({
              botName, chatId, prompt, callbackChatId, callbackBotName,
            });

            // Fire and forget
            (async () => {
              asyncTaskStore.update(asyncTask.id, { status: 'running' });
              try {
                const result = await bot.bridge.executeApiTask({
                  prompt, chatId, userId: 'api', sendCards: sendCards ?? true,
                });
                asyncTaskStore.update(asyncTask.id, {
                  status: result.success ? 'completed' : 'failed',
                  completedAt: Date.now(),
                  result: {
                    success: result.success,
                    responseText: result.responseText,
                    costUsd: result.costUsd,
                    durationMs: result.durationMs,
                    error: result.error,
                  },
                });

                // Record circuit breaker and budget results
                if (result.success) {
                  circuitBreaker.recordSuccess(botName);
                } else {
                  circuitBreaker.recordFailure(botName);
                }
                if (result.costUsd) {
                  budgetManager.recordCost(botName, result.costUsd);
                }

                // Send callback if configured
                if (callbackChatId && callbackBotName) {
                  const callbackBot = registry.get(callbackBotName);
                  if (callbackBot) {
                    const summary = result.responseText?.slice(0, 500) || 'Task completed';
                    await callbackBot.bridge.executeApiTask({
                      prompt: `[Async task callback] Bot "${botName}" finished a task. Result: ${summary}`,
                      chatId: callbackChatId,
                      userId: 'system',
                      sendCards: true,
                      maxTurns: 1,
                    });
                  }
                }
              } catch (err: any) {
                circuitBreaker.recordFailure(botName);
                asyncTaskStore.update(asyncTask.id, {
                  status: 'failed',
                  completedAt: Date.now(),
                  result: { success: false, responseText: '', error: err.message },
                });
              }
            })();

            jsonResponse(res, 202, {
              taskId: asyncTask.id,
              status: 'accepted',
              message: 'Task accepted for async execution',
            });
            return;
          }

          // If WS clients are subscribed to this chatId, stream updates to them
          const subs = ws.handle?.subscriptions;
          const hasWsSubscribers = subs && (subs.getSubscribers(chatId)?.size ?? 0) > 0;

          const result = await bot.bridge.executeApiTask({
            prompt,
            chatId,
            userId: 'api',
            sendCards: sendCards ?? true,
            ...(hasWsSubscribers ? {
              onUpdate: (state, bridgeMessageId, final) => {
                const msgType = final ? 'complete' : 'state';
                subs!.broadcast(chatId, {
                  type: msgType,
                  chatId,
                  messageId: bridgeMessageId,
                  state,
                  botName,
                });
              },
            } : {}),
          });

          // Record circuit breaker and budget results
          if (result.success) {
            circuitBreaker.recordSuccess(botName);
          } else {
            circuitBreaker.recordFailure(botName);
          }
          if (result.costUsd) {
            budgetManager.recordCost(botName, result.costUsd);
          }

          jsonResponse(res, result.success ? 200 : 500, result);
          return;
        }

        // Bot not found locally — check peers (unless this request is already forwarded)
        const origin = req.headers['x-metabot-origin'];
        if (!origin && peerManager) {
          const peerMatch = peerManager.findBotPeer(botName);
          if (peerMatch) {
            logger.info({ botName, peerName: peerMatch.peer.name, peerUrl: peerMatch.peer.url, chatId, promptLength: prompt.length }, 'Forwarding talk to peer');
            try {
              const result = await peerManager.forwardTask(peerMatch.peer, { botName, chatId, prompt, sendCards });
              const statusCode = (result as any).success === false ? 500 : 200;
              jsonResponse(res, statusCode, result);
            } catch (err: any) {
              logger.error({ err, botName, peerUrl: peerMatch.peer.url }, 'Peer forwarding failed');
              jsonResponse(res, 502, { error: `Peer forwarding failed: ${err.message}` });
            }
            return;
          }
        }

        jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
        return;
      }

      // Route: POST /api/schedule
      if (method === 'POST' && url === '/api/schedule') {
        const body = await parseJsonBody(req);
        const botName = body.botName as string;
        const chatId = body.chatId as string;
        const prompt = body.prompt as string;
        const cronExpr = body.cronExpr as string | undefined;
        const delaySeconds = body.delaySeconds as number | undefined;
        const sendCards = body.sendCards as boolean | undefined;
        const label = body.label as string | undefined;
        const timezone = body.timezone as string | undefined;

        if (!botName || !chatId || !prompt) {
          jsonResponse(res, 400, { error: 'Missing required fields: botName, chatId, prompt' });
          return;
        }

        const bot = registry.get(botName);
        if (!bot) {
          jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
          return;
        }

        if (cronExpr) {
          // Recurring task
          const recurring = scheduler.scheduleRecurring({
            botName, chatId, prompt, cronExpr, timezone, sendCards, label,
          });
          jsonResponse(res, 201, {
            id: recurring.id,
            type: 'recurring',
            botName: recurring.botName,
            chatId: recurring.chatId,
            prompt: recurring.prompt,
            cronExpr: recurring.cronExpr,
            timezone: recurring.timezone,
            nextExecuteAt: new Date(recurring.nextExecuteAt).toISOString(),
            sendCards: recurring.sendCards,
            label: recurring.label,
            status: recurring.status,
          });
        } else if (typeof delaySeconds === 'number' && delaySeconds > 0) {
          // One-time task (existing behavior)
          const task = scheduler.scheduleTask({
            botName, chatId, prompt, delaySeconds, sendCards, label,
          });
          jsonResponse(res, 201, {
            id: task.id,
            type: 'one-time',
            botName: task.botName,
            chatId: task.chatId,
            prompt: task.prompt,
            executeAt: new Date(task.executeAt).toISOString(),
            sendCards: task.sendCards,
            label: task.label,
            status: task.status,
          });
        } else {
          jsonResponse(res, 400, { error: 'Provide either cronExpr (recurring) or delaySeconds (one-time, positive number)' });
        }
        return;
      }

      // Route: GET /api/schedule
      if (method === 'GET' && url === '/api/schedule') {
        const tasks = scheduler.listTasks().map((t) => ({
          id: t.id,
          type: 'one-time',
          botName: t.botName,
          chatId: t.chatId,
          prompt: t.prompt,
          executeAt: new Date(t.executeAt).toISOString(),
          sendCards: t.sendCards,
          label: t.label,
          status: t.status,
          createdAt: new Date(t.createdAt).toISOString(),
        }));
        const recurringTasks = scheduler.listRecurringTasks().map((r) => ({
          id: r.id,
          type: 'recurring',
          botName: r.botName,
          chatId: r.chatId,
          prompt: r.prompt,
          cronExpr: r.cronExpr,
          timezone: r.timezone,
          nextExecuteAt: new Date(r.nextExecuteAt).toISOString(),
          lastExecutedAt: r.lastExecutedAt ? new Date(r.lastExecutedAt).toISOString() : null,
          sendCards: r.sendCards,
          label: r.label,
          status: r.status,
          createdAt: new Date(r.createdAt).toISOString(),
        }));
        jsonResponse(res, 200, { tasks, recurringTasks });
        return;
      }

      // Route: POST /api/schedule/:id/pause
      if (method === 'POST' && /^\/api\/schedule\/[^/]+\/pause$/.test(url)) {
        const id = url.split('/')[3];
        const paused = scheduler.pauseRecurring(id);
        if (paused) {
          jsonResponse(res, 200, { id, status: 'paused' });
        } else {
          jsonResponse(res, 404, { error: `Recurring task not found or not pausable: ${id}` });
        }
        return;
      }

      // Route: POST /api/schedule/:id/resume
      if (method === 'POST' && /^\/api\/schedule\/[^/]+\/resume$/.test(url)) {
        const id = url.split('/')[3];
        const resumed = scheduler.resumeRecurring(id);
        if (resumed) {
          const recurring = scheduler.getRecurringTask(id);
          jsonResponse(res, 200, {
            id,
            status: 'active',
            nextExecuteAt: recurring ? new Date(recurring.nextExecuteAt).toISOString() : null,
          });
        } else {
          jsonResponse(res, 404, { error: `Recurring task not found or not resumable: ${id}` });
        }
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

        // Try one-time task first
        const updated = scheduler.updateTask(id, {
          prompt: body.prompt as string | undefined,
          delaySeconds: body.delaySeconds as number | undefined,
          label: body.label as string | undefined,
          sendCards: body.sendCards as boolean | undefined,
        });

        if (updated) {
          jsonResponse(res, 200, {
            id: updated.id,
            type: 'one-time',
            botName: updated.botName,
            chatId: updated.chatId,
            prompt: updated.prompt,
            executeAt: new Date(updated.executeAt).toISOString(),
            sendCards: updated.sendCards,
            label: updated.label,
            status: updated.status,
          });
          return;
        }

        // Try recurring task
        const updatedRecurring = scheduler.updateRecurring(id, {
          prompt: body.prompt as string | undefined,
          cronExpr: body.cronExpr as string | undefined,
          timezone: body.timezone as string | undefined,
          label: body.label as string | undefined,
          sendCards: body.sendCards as boolean | undefined,
        });

        if (updatedRecurring) {
          jsonResponse(res, 200, {
            id: updatedRecurring.id,
            type: 'recurring',
            botName: updatedRecurring.botName,
            chatId: updatedRecurring.chatId,
            prompt: updatedRecurring.prompt,
            cronExpr: updatedRecurring.cronExpr,
            timezone: updatedRecurring.timezone,
            nextExecuteAt: new Date(updatedRecurring.nextExecuteAt).toISOString(),
            sendCards: updatedRecurring.sendCards,
            label: updatedRecurring.label,
            status: updatedRecurring.status,
          });
          return;
        }

        jsonResponse(res, 404, { error: `Task not found or not updatable: ${id}` });
        return;
      }

      // Route: DELETE /api/schedule/:id
      if (method === 'DELETE' && url.startsWith('/api/schedule/')) {
        const id = url.slice('/api/schedule/'.length);
        if (!id) {
          jsonResponse(res, 400, { error: 'Missing task ID' });
          return;
        }

        // Try one-time task first
        const cancelled = scheduler.cancelTask(id);
        if (cancelled) {
          jsonResponse(res, 200, { id, type: 'one-time', status: 'cancelled' });
          return;
        }

        // Try recurring task
        const cancelledRecurring = scheduler.cancelRecurring(id);
        if (cancelledRecurring) {
          jsonResponse(res, 200, { id, type: 'recurring', status: 'cancelled' });
          return;
        }

        jsonResponse(res, 404, { error: `Task not found or not cancellable: ${id}` });
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
        if (platform !== 'feishu' && platform !== 'telegram' && platform !== 'web') {
          jsonResponse(res, 400, { error: 'platform must be "feishu", "telegram", or "web"' });
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
            ...(body.description ? { description: body.description } : {}),
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
            return;
          }
          entry = {
            name,
            ...(body.description ? { description: body.description } : {}),
            telegramBotToken: token,
            defaultWorkingDirectory: workDir,
            ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
            ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
            ...(body.model ? { model: body.model } : {}),
          };
        } else {
          // Web platform — no IM credentials needed
          const workDir = body.defaultWorkingDirectory as string;
          if (!workDir) {
            jsonResponse(res, 400, { error: 'Web bot requires: defaultWorkingDirectory' });
            return;
          }
          entry = {
            name,
            ...(body.description ? { description: body.description } : {}),
            defaultWorkingDirectory: workDir,
            ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
            ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
            ...(body.model ? { model: body.model } : {}),
          };
        }

        try {
          // Ensure working directory exists
          const workDir = (body.defaultWorkingDirectory as string);
          fs.mkdirSync(workDir, { recursive: true });

          addBot(botsConfigPath, platform as 'feishu' | 'telegram' | 'web', entry as any);
          logger.info({ name, platform }, 'Bot added to config');

          // Optionally install skills
          if (body.installSkills) {
            installSkillsToWorkDir(workDir, logger, { platform: platform as 'feishu' | 'telegram' | 'web' });
          }

          // Web bots can be activated immediately (no IM connection needed)
          let activated = false;
          if (platform === 'web') {
            const config = webBotFromJson(entry as any);
            const sender = new NullSender();
            const bridge = new MessageBridge(config, logger, sender,
              memoryServerUrl || 'http://localhost:8100',
              memoryAuthToken);
            registry.register({ name, platform: 'web', config, bridge, sender });
            activated = true;
            logger.info({ name }, 'Web bot activated immediately');
            // Broadcast updated bot list to WS clients
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
          ? { running: true, workingDirectory: running.config.claude.defaultWorkingDirectory }
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
          ws.handle?.broadcastBotList();
          jsonResponse(res, 200, { name, removed: true, message: 'Bot removed.' });
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

      // Route: GET /api/budgets
      if (method === 'GET' && url === '/api/budgets') {
        jsonResponse(res, 200, { budgets: budgetManager.getAllBudgets() });
        return;
      }

      // Route: PUT /api/budgets/:botName
      if (method === 'PUT' && url.match(/^\/api\/budgets\/[^/]+$/)) {
        const botName = decodeURIComponent(url.split('/')[3]);
        const body = await parseJsonBody(req);
        const dailyLimitUsd = body.dailyLimitUsd as number;
        if (typeof dailyLimitUsd !== 'number') {
          jsonResponse(res, 400, { error: 'Missing required field: dailyLimitUsd' });
          return;
        }
        budgetManager.setLimit(botName, dailyLimitUsd);
        jsonResponse(res, 200, { botName, dailyLimitUsd });
        return;
      }

      // Route: GET /api/costs/report
      if (method === 'GET' && url.startsWith('/api/costs/report')) {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const period = (parsed.searchParams.get('period') || 'daily') as 'daily' | 'weekly' | 'monthly';
        jsonResponse(res, 200, { period, report: budgetManager.getReport(period) });
        return;
      }

      // Route: GET /api/circuits
      if (method === 'GET' && url === '/api/circuits') {
        jsonResponse(res, 200, { circuits: circuitBreaker.getStatus() });
        return;
      }

      // Route: POST /api/circuits/:botName/reset
      if (method === 'POST' && url.match(/^\/api\/circuits\/[^/]+\/reset$/)) {
        const botName = decodeURIComponent(url.split('/')[3]);
        circuitBreaker.reset(botName);
        jsonResponse(res, 200, { reset: true, botName });
        return;
      }

      // Route: GET /api/teams
      if (method === 'GET' && url === '/api/teams') {
        jsonResponse(res, 200, { teams: teamManager.list() });
        return;
      }

      // Route: POST /api/teams
      if (method === 'POST' && url === '/api/teams') {
        const body = await parseJsonBody(req);
        const name = body.name as string;
        const members = body.members as string[] | undefined;
        const budgetDailyUsd = body.budgetDailyUsd as number | undefined;
        if (!name) {
          jsonResponse(res, 400, { error: 'Missing required field: name' });
          return;
        }
        try {
          const team = teamManager.create(name, members, budgetDailyUsd);
          jsonResponse(res, 201, team);
        } catch (err: any) {
          jsonResponse(res, 409, { error: err.message });
        }
        return;
      }

      // Route: GET /api/teams/:id
      if (method === 'GET' && url.match(/^\/api\/teams\/[^/]+$/) && !url.endsWith('/teams/')) {
        const id = decodeURIComponent(url.split('/')[3]);
        const team = teamManager.get(id) || teamManager.getByName(id);
        if (!team) {
          jsonResponse(res, 404, { error: 'Team not found' });
          return;
        }
        jsonResponse(res, 200, team);
        return;
      }

      // Route: PUT /api/teams/:id
      if (method === 'PUT' && url.match(/^\/api\/teams\/[^/]+$/)) {
        const id = decodeURIComponent(url.split('/')[3]);
        const body = await parseJsonBody(req);
        const updated = teamManager.update(id, body as any);
        if (!updated) {
          jsonResponse(res, 404, { error: 'Team not found' });
          return;
        }
        jsonResponse(res, 200, updated);
        return;
      }

      // Route: DELETE /api/teams/:id
      if (method === 'DELETE' && url.match(/^\/api\/teams\/[^/]+$/)) {
        const id = decodeURIComponent(url.split('/')[3]);
        const deleted = teamManager.delete(id);
        jsonResponse(res, deleted ? 200 : 404, { deleted });
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

      // Route: POST /api/sync — trigger wiki sync
      if (method === 'POST' && url === '/api/sync') {
        if (!docSync) {
          jsonResponse(res, 400, { error: 'Wiki sync is not configured' });
          return;
        }
        if (docSync.isSyncing()) {
          jsonResponse(res, 409, { error: 'Sync already in progress' });
          return;
        }
        // Run sync in background, return immediately
        const syncPromise = docSync.syncAll();
        syncPromise.then((result) => {
          logger.info({ result }, 'API-triggered wiki sync complete');
        }).catch((err) => {
          logger.error({ err }, 'API-triggered wiki sync failed');
        });
        jsonResponse(res, 202, { status: 'sync_started' });
        return;
      }

      // Route: GET /api/sync — get sync status
      if (method === 'GET' && url === '/api/sync') {
        if (!docSync) {
          jsonResponse(res, 400, { error: 'Wiki sync is not configured' });
          return;
        }
        const stats = docSync.getStats();
        jsonResponse(res, 200, {
          syncing: docSync.isSyncing(),
          wikiSpaceId: stats.wikiSpaceId,
          documentCount: stats.documentCount,
          folderCount: stats.folderCount,
        });
        return;
      }

      // Route: POST /api/sync/document — sync a single document by ID
      if (method === 'POST' && url === '/api/sync/document') {
        if (!docSync) {
          jsonResponse(res, 400, { error: 'Wiki sync is not configured' });
          return;
        }
        const body = await parseJsonBody(req);
        const docId = body.docId as string;
        if (!docId) {
          jsonResponse(res, 400, { error: 'Missing required field: docId' });
          return;
        }
        const result = await docSync.syncDocument(docId);
        jsonResponse(res, result.success ? 200 : 500, result);
        return;
      }

      // Route: GET /api/feishu/document — read a Feishu document
      if (method === 'GET' && url.startsWith('/api/feishu/document')) {
        const queryStr = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const params = new URLSearchParams(queryStr);
        const docUrl = params.get('url');
        const docId = params.get('docId');
        const botName = params.get('botName');

        if (!docUrl && !docId) {
          jsonResponse(res, 400, { error: 'Provide either url or docId query parameter' });
          return;
        }

        // Find a Feishu client to use: specific bot > service client > first bot fallback
        let clientForDoc: lark.Client | undefined;
        if (botName) {
          const bot = registry.getByPlatform(botName, 'feishu');
          clientForDoc = bot?.feishuClient;
          if (!clientForDoc) {
            jsonResponse(res, 404, { error: `Feishu bot not found: ${botName}` });
            return;
          }
        } else {
          clientForDoc = feishuServiceClient;
          if (!clientForDoc) {
            const feishuBots = registry.listByPlatform('feishu');
            clientForDoc = feishuBots[0]?.feishuClient;
          }
        }
        if (!clientForDoc) {
          jsonResponse(res, 400, { error: 'No Feishu service app or bots configured' });
          return;
        }

        const reader = new FeishuDocReader(clientForDoc, logger);
        let result;

        if (docUrl) {
          result = await reader.readByUrl(docUrl);
        } else if (docId) {
          // Try as document ID first
          result = await reader.readDocument(docId);
        }

        if (!result) {
          jsonResponse(res, 404, { error: 'Document not found or unreadable' });
          return;
        }

        jsonResponse(res, 200, result);
        return;
      }

      // Proxy /memory/* to MetaMemory server
      if (url.startsWith('/memory/') || url === '/memory') {
        const memoryUrl = memoryServerUrl || process.env.META_MEMORY_URL || 'http://localhost:8100';
        const targetPath = url.slice('/memory'.length) || '/';
        const targetUrl = `${memoryUrl}${targetPath}`;

        try {
          const headers: Record<string, string> = {};
          if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
          if (memoryAuthToken) headers['Authorization'] = `Bearer ${memoryAuthToken}`;

          let body: string | undefined;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            body = await readBody(req);
          }

          const proxyRes = await fetch(targetUrl, {
            method,
            headers,
            body,
          });

          const contentType = proxyRes.headers.get('content-type') || 'application/json';
          const responseBody = await proxyRes.text();
          res.writeHead(proxyRes.status, { 'Content-Type': contentType });
          res.end(responseBody);
        } catch (err: any) {
          logger.warn({ err, targetUrl }, 'MetaMemory proxy error');
          jsonResponse(res, 502, { error: `MetaMemory proxy error: ${err.message}` });
        }
        return;
      }

      // Static file serving for Web UI
      if (serveStaticFiles(req, res, url)) {
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

  // Set up WebSocket server for Web UI streaming
  ws.handle = setupWebSocketServer(server, registry, logger, secret, peerManager, pushService);

  server.listen(port, host, () => {
    logger.info({ host, port }, 'API server started');
  });

  return server;
}
