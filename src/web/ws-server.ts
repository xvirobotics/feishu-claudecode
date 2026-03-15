import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { BotRegistry, BotInfo } from '../api/bot-registry.js';
import type { Logger } from '../utils/logger.js';
import type { CardState, PendingQuestion } from '../types.js';
import type { PeerManager } from '../api/peer-manager.js';
import { ChatSubscriptionManager } from './chat-subscriptions.js';
import { GroupManager, type ChatGroup } from './group-manager.js';

// ─── Client → Server messages ──────────────────────────────────────────────

type ClientMessage =
  | { type: 'chat'; botName: string; chatId: string; text: string; messageId?: string }
  | { type: 'group_chat'; groupId: string; chatId: string; text: string; messageId?: string }
  | { type: 'stop'; chatId: string; botName?: string }
  | { type: 'answer'; chatId: string; toolUseId: string; answer: string }
  | { type: 'create_group'; name: string; members: string[] }
  | { type: 'delete_group'; groupId: string }
  | { type: 'list_groups' }
  | { type: 'ping' };

// ─── Server → Client messages ──────────────────────────────────────────────

type ServerMessage =
  | { type: 'connected'; bots: BotInfo[] }
  | { type: 'bots_updated'; bots: BotInfo[] }
  | { type: 'state'; chatId: string; messageId: string; state: CardState; botName?: string }
  | { type: 'complete'; chatId: string; messageId: string; state: CardState; botName?: string }
  | { type: 'error'; chatId: string; messageId?: string; error: string }
  | { type: 'notice'; chatId: string; title: string; content: string; color?: string }
  | { type: 'file'; chatId: string; url: string; name: string; mimeType: string; size?: number }
  | { type: 'group_created'; group: ChatGroup }
  | { type: 'group_deleted'; groupId: string }
  | { type: 'groups_list'; groups: ChatGroup[] }
  | { type: 'pong' };

// ─── MIME types for static file serving ────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
};

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface WebSocketHandle {
  /** Broadcast updated bot list to all connected WS clients. */
  broadcastBotList: () => void;
  /** Chat subscription manager for pub/sub streaming. */
  subscriptions: ChatSubscriptionManager;
}

/**
 * Set up a WebSocket server on the existing HTTP server for the Web UI.
 */
export function setupWebSocketServer(
  server: Server,
  registry: BotRegistry,
  logger: Logger,
  secret?: string,
  peerManager?: PeerManager,
): WebSocketHandle {
  const wsLogger = logger.child({ module: 'ws' });

  const wss = new WebSocketServer({ noServer: true });

  // Track all connected clients for broadcasting
  const connectedClients = new Set<WebSocket>();

  // Chat subscription manager for pub/sub streaming
  const subscriptions = new ChatSubscriptionManager();

  // Group manager for group chat
  const groupManager = new GroupManager();

  // Handle HTTP upgrade requests
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Only upgrade requests to /ws path
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Auth via ?token=SECRET query parameter (if secret is configured)
    if (secret) {
      const token = url.searchParams.get('token');
      if (token !== secret) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        wsLogger.warn('WebSocket connection rejected: invalid token');
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // Handle new WebSocket connections
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    wsLogger.info('WebSocket client connected');
    connectedClients.add(ws);

    // Per-connection state
    const pendingAnswers = new Map<string, {
      resolve: (answer: string) => void;
      reject: (err: Error) => void;
    }>();
    // Track chatId → botName for stop commands
    const chatBotMap = new Map<string, string>();

    // Send connected message with bot list
    const bots = registry.list();
    const peerBots = peerManager?.getPeerBots() ?? [];
    sendMessage(ws, { type: 'connected', bots: [...bots, ...peerBots] });

    // Heartbeat: ping every 30s, close if no pong
    let isAlive = true;
    ws.on('pong', () => { isAlive = true; });

    const heartbeat = setInterval(() => {
      if (!isAlive) {
        wsLogger.info('WebSocket client timed out (no pong), closing');
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    // Handle client messages
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        sendMessage(ws, { type: 'error', chatId: '', error: 'Invalid JSON message' });
        return;
      }

      wsLogger.debug({ type: msg.type, chatId: (msg as any).chatId }, 'WS message received');

      switch (msg.type) {
        case 'chat':
          chatBotMap.set(msg.chatId, msg.botName);
          subscriptions.subscribe(msg.chatId, ws);
          handleChat(ws, msg, registry, peerManager, pendingAnswers, wsLogger).catch((err) => {
            wsLogger.error({ err, chatId: msg.chatId }, 'WS chat handler error');
            sendMessage(ws, { type: 'error', chatId: msg.chatId, messageId: msg.messageId, error: err.message || 'Internal error' });
          });
          break;

        case 'stop':
          handleStop(ws, msg, registry, chatBotMap, wsLogger);
          break;

        case 'answer':
          handleAnswer(msg, pendingAnswers, wsLogger);
          break;

        case 'group_chat':
          handleGroupChat(ws, msg, groupManager, registry, subscriptions, pendingAnswers, wsLogger).catch((err) => {
            wsLogger.error({ err, chatId: msg.chatId }, 'WS group chat handler error');
            sendMessage(ws, { type: 'error', chatId: msg.chatId, messageId: msg.messageId, error: err.message || 'Internal error' });
          });
          break;

        case 'create_group': {
          const { name, members } = msg;
          if (!name || !members || members.length < 2) {
            sendMessage(ws, { type: 'error', chatId: '', error: 'Group needs a name and at least 2 members' });
            break;
          }
          // Validate all members exist
          const invalid = members.filter((m) => !registry.get(m));
          if (invalid.length > 0) {
            sendMessage(ws, { type: 'error', chatId: '', error: `Unknown bot(s): ${invalid.join(', ')}` });
            break;
          }
          const group = groupManager.create(name, members);
          wsLogger.info({ groupId: group.id, name, members }, 'Group created');
          // Broadcast to all clients
          for (const client of connectedClients) {
            sendMessage(client, { type: 'group_created', group });
          }
          break;
        }

        case 'delete_group': {
          const deleted = groupManager.delete(msg.groupId);
          if (deleted) {
            wsLogger.info({ groupId: msg.groupId }, 'Group deleted');
            for (const client of connectedClients) {
              sendMessage(client, { type: 'group_deleted', groupId: msg.groupId });
            }
          } else {
            sendMessage(ws, { type: 'error', chatId: '', error: `Group not found: ${msg.groupId}` });
          }
          break;
        }

        case 'list_groups':
          sendMessage(ws, { type: 'groups_list', groups: groupManager.list() });
          break;

        case 'ping':
          sendMessage(ws, { type: 'pong' });
          break;

        default:
          sendMessage(ws, { type: 'error', chatId: '', error: `Unknown message type: ${(msg as any).type}` });
      }
    });

    ws.on('close', () => {
      wsLogger.info('WebSocket client disconnected');
      connectedClients.delete(ws);
      subscriptions.unsubscribeAll(ws);
      clearInterval(heartbeat);
      // Reject all pending answers
      for (const [, { reject }] of pendingAnswers) {
        reject(new Error('WebSocket connection closed'));
      }
      pendingAnswers.clear();
    });

    ws.on('error', (err) => {
      wsLogger.error({ err }, 'WebSocket error');
      clearInterval(heartbeat);
    });
  });

  wsLogger.info('WebSocket server initialized on /ws');

  return {
    broadcastBotList() {
      const bots = registry.list();
      const peerBots = peerManager?.getPeerBots() ?? [];
      const msg = JSON.stringify({ type: 'bots_updated', bots: [...bots, ...peerBots] });
      for (const ws of connectedClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }
    },
    subscriptions,
  };
}

// ─── Message handlers ──────────────────────────────────────────────────────

async function handleChat(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'chat' }>,
  registry: BotRegistry,
  peerManager: PeerManager | undefined,
  pendingAnswers: Map<string, { resolve: (answer: string) => void; reject: (err: Error) => void }>,
  logger: Logger,
): Promise<void> {
  const { botName, chatId, text, messageId: clientMessageId } = msg;

  if (!botName || !chatId || !text) {
    sendMessage(ws, { type: 'error', chatId: chatId || '', error: 'Missing required fields: botName, chatId, text' });
    return;
  }

  // Find bot in local registry
  const bot = registry.get(botName);
  if (!bot) {
    // Try peer bots — but we cannot stream from peers via WS, so reject
    const peerBot = peerManager?.findBotPeer(botName);
    if (peerBot) {
      sendMessage(ws, {
        type: 'error',
        chatId,
        error: `Bot "${botName}" is on a peer instance (${peerBot.peer.name}). WebSocket streaming is only supported for local bots.`,
      });
    } else {
      sendMessage(ws, { type: 'error', chatId, error: `Bot not found: ${botName}` });
    }
    return;
  }

  logger.info({ botName, chatId, textLength: text.length }, 'WS chat request');

  try {
    await bot.bridge.executeApiTask({
      prompt: text,
      chatId,
      userId: 'web',
      sendCards: false,
      onUpdate: (state: CardState, bridgeMessageId: string, final: boolean) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Use the client-provided messageId so the frontend can match the response
        const msgId = clientMessageId || bridgeMessageId;
        if (final) {
          sendMessage(ws, { type: 'complete', chatId, messageId: msgId, state });
        } else {
          sendMessage(ws, { type: 'state', chatId, messageId: msgId, state });
        }
      },
      onOutputFiles: (files) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Copy output files to uploads dir so they're accessible via /api/files/
        const uploadsDir = path.join(os.tmpdir(), 'metabot-uploads', chatId);
        fs.mkdirSync(uploadsDir, { recursive: true });
        for (const file of files) {
          try {
            const destPath = path.join(uploadsDir, file.fileName);
            fs.copyFileSync(file.filePath, destPath);
            const ext = file.extension.replace('.', '');
            const mimeMap: Record<string, string> = {
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
              pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              zip: 'application/zip', txt: 'text/plain', json: 'application/json', csv: 'text/csv', md: 'text/markdown',
              html: 'text/html',
            };
            const mimeType = mimeMap[ext] || 'application/octet-stream';
            sendMessage(ws, {
              type: 'file',
              chatId,
              url: `/api/files/${encodeURIComponent(chatId)}/${encodeURIComponent(file.fileName)}`,
              name: file.fileName,
              mimeType,
              size: file.sizeBytes,
            });
          } catch (err) {
            logger.warn({ err, file: file.fileName }, 'Failed to copy output file for web');
          }
        }
      },
      onQuestion: (question: PendingQuestion): Promise<string> => {
        return new Promise<string>((resolve, reject) => {
          pendingAnswers.set(question.toolUseId, { resolve, reject });

          // Set a timeout so we don't wait forever
          const timeout = setTimeout(() => {
            pendingAnswers.delete(question.toolUseId);
            // Auto-answer after timeout
            const autoAnswer = JSON.stringify({ answers: { _timeout: 'User did not respond in time, please decide on your own.' } });
            resolve(autoAnswer);
          }, 5 * 60 * 1000); // 5 minutes

          // Clean up timeout when resolved
          const originalResolve = resolve;
          const wrappedResolve = (answer: string) => {
            clearTimeout(timeout);
            originalResolve(answer);
          };
          const originalReject = reject;
          const wrappedReject = (err: Error) => {
            clearTimeout(timeout);
            originalReject(err);
          };
          pendingAnswers.set(question.toolUseId, { resolve: wrappedResolve, reject: wrappedReject });
        });
      },
    });
  } catch (err: any) {
    logger.error({ err, chatId, botName }, 'WS executeApiTask error');
    sendMessage(ws, { type: 'error', chatId, messageId: clientMessageId, error: err.message || 'Task execution failed' });
  }
}

function handleStop(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'stop' }>,
  registry: BotRegistry,
  chatBotMap: Map<string, string>,
  logger: Logger,
): void {
  const { chatId } = msg;
  const botName = msg.botName || chatBotMap.get(chatId);

  if (!botName) {
    sendMessage(ws, { type: 'error', chatId, error: 'Cannot determine bot for this chat. Send a message first.' });
    return;
  }

  const bot = registry.get(botName);
  if (!bot) {
    sendMessage(ws, { type: 'error', chatId, error: `Bot not found: ${botName}` });
    return;
  }

  const stopped = bot.bridge.stopChatTask(chatId);
  if (stopped) {
    logger.info({ chatId, botName }, 'WS task stopped');
    sendMessage(ws, { type: 'notice', chatId, title: 'Task Stopped', content: 'The running task has been stopped.' });
  } else {
    sendMessage(ws, { type: 'notice', chatId, title: 'No Task', content: 'No running task to stop.' });
  }
}

function handleAnswer(
  msg: Extract<ClientMessage, { type: 'answer' }>,
  pendingAnswers: Map<string, { resolve: (answer: string) => void; reject: (err: Error) => void }>,
  logger: Logger,
): void {
  const chatId = (msg as any).chatId as string;
  const { toolUseId, answer } = msg;

  const pending = pendingAnswers.get(toolUseId);
  if (!pending) {
    logger.warn({ chatId, toolUseId }, 'WS answer received but no pending question found');
    return;
  }

  pendingAnswers.delete(toolUseId);
  // Build the answer JSON in the format the bridge expects
  const answerJson = JSON.stringify({ answers: { _web: answer } });
  pending.resolve(answerJson);
  logger.info({ chatId, toolUseId }, 'WS answer resolved');
}

// ─── Group chat handler ──────────────────────────────────────────────────

async function handleGroupChat(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'group_chat' }>,
  groupManager: GroupManager,
  registry: BotRegistry,
  subscriptions: ChatSubscriptionManager,
  pendingAnswers: Map<string, { resolve: (answer: string) => void; reject: (err: Error) => void }>,
  logger: Logger,
): Promise<void> {
  const { groupId, chatId, text, messageId: clientMessageId } = msg;

  const group = groupManager.get(groupId);
  if (!group) {
    sendMessage(ws, { type: 'error', chatId, error: `Group not found: ${groupId}` });
    return;
  }

  // Parse @mention to route to specific bot
  const mentionMatch = text.match(/^@(\S+)\s+([\s\S]*)$/);
  if (!mentionMatch) {
    sendMessage(ws, { type: 'error', chatId, error: 'In group chat, use @botName to address a specific bot' });
    return;
  }

  const targetBot = mentionMatch[1];
  const prompt = mentionMatch[2].trim();

  if (!group.members.includes(targetBot)) {
    sendMessage(ws, { type: 'error', chatId, error: `Bot "${targetBot}" is not a member of this group` });
    return;
  }

  const bot = registry.get(targetBot);
  if (!bot) {
    sendMessage(ws, { type: 'error', chatId, error: `Bot not found: ${targetBot}` });
    return;
  }

  // Use per-bot chatId to avoid "chat busy" conflicts between bots
  const botChatId = `group-${groupId}-${targetBot}`;

  // Subscribe the client to the group chatId for receiving updates
  subscriptions.subscribe(chatId, ws);

  logger.info({ groupId, targetBot, chatId, botChatId, promptLength: prompt.length }, 'Group chat request');

  try {
    await bot.bridge.executeApiTask({
      prompt,
      chatId: botChatId,
      userId: 'web',
      sendCards: false,
      groupMembers: group.members,
      onUpdate: (state: CardState, bridgeMessageId: string, final: boolean) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const msgId = clientMessageId || bridgeMessageId;
        const msgType = final ? 'complete' : 'state';
        // Broadcast to all subscribers of this group chat using the user-facing chatId
        subscriptions.broadcast(chatId, {
          type: msgType,
          chatId,
          messageId: msgId,
          state,
          botName: targetBot,
        });
      },
      onQuestion: (question: PendingQuestion): Promise<string> => {
        return new Promise<string>((resolve, reject) => {
          pendingAnswers.set(question.toolUseId, { resolve, reject });
          const timeout = setTimeout(() => {
            pendingAnswers.delete(question.toolUseId);
            resolve(JSON.stringify({ answers: { _timeout: 'User did not respond in time, please decide on your own.' } }));
          }, 5 * 60 * 1000);
          const wrappedResolve = (answer: string) => { clearTimeout(timeout); resolve(answer); };
          const wrappedReject = (err: Error) => { clearTimeout(timeout); reject(err); };
          pendingAnswers.set(question.toolUseId, { resolve: wrappedResolve, reject: wrappedReject });
        });
      },
    });
  } catch (err: any) {
    logger.error({ err, chatId, targetBot }, 'WS group chat error');
    sendMessage(ws, { type: 'error', chatId, messageId: clientMessageId, error: err.message || 'Task execution failed' });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sendMessage(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Static file serving ──────────────────────────────────────────────────

/**
 * Serve static files from the `dist/web/` directory for `/web/*` requests.
 * Returns true if the request was handled, false otherwise.
 */
export function serveStaticFiles(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): boolean {
  // Only handle GET /web/*
  if (req.method !== 'GET') return false;

  // Redirect /web to /web/
  if (url === '/web') {
    res.writeHead(301, { Location: '/web/' });
    res.end();
    return true;
  }

  if (!url.startsWith('/web/')) return false;

  // Strip query string for file path resolution
  const cleanUrl = url.includes('?') ? url.slice(0, url.indexOf('?')) : url;

  // Resolve the file path relative to dist/web/
  const webRoot = path.resolve(process.cwd(), 'dist', 'web');
  let filePath = cleanUrl.slice('/web/'.length);

  // Default to index.html for root
  if (!filePath || filePath === '') {
    filePath = 'index.html';
  }

  const fullPath = path.resolve(webRoot, filePath);

  // Security: prevent directory traversal
  if (!fullPath.startsWith(webRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  // Try to serve the file
  try {
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = fs.readFileSync(fullPath);
      // Hashed assets get long cache; index.html gets no-cache
      const isHashed = filePath.startsWith('assets/') && /-[a-zA-Z0-9]{8,}\./.test(filePath);
      const cacheControl = isHashed ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
      res.end(content);
      return true;
    }
  } catch {
    // Fall through to SPA fallback
  }

  // Asset files that don't exist should 404 (not SPA fallback)
  if (filePath.startsWith('assets/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
  }

  // SPA fallback: serve index.html for any unmatched non-asset path
  const indexPath = path.resolve(webRoot, 'index.html');
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(content);
      return true;
    }
  } catch {
    // index.html not found
  }

  // dist/web/ doesn't exist yet
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Web UI not found. Build the web frontend first.');
  return true;
}
