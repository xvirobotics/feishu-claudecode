import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState, CardStatus } from '../types.js';
import type { SlackBotConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';

const MAX_MESSAGE_LENGTH = 39000;
const SLACK_API_BASE = 'https://slack.com/api';

const STATUS_EMOJI: Record<CardStatus, string> = {
  thinking: ':large_blue_circle:',
  running: ':large_blue_circle:',
  complete: ':large_green_circle:',
  error: ':red_circle:',
  waiting_for_input: ':large_yellow_circle:',
  agent_activity: ':large_blue_circle:',
};

const STATUS_LABEL: Record<CardStatus, string> = {
  thinking: 'Thinking...',
  running: 'Running...',
  complete: 'Complete',
  error: 'Error',
  waiting_for_input: 'Waiting for Input',
  agent_activity: 'Agent activity',
};

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  user_id?: string;
  upload_url?: string;
  file_id?: string;
  file?: { url_private_download?: string; url_private?: string };
  [key: string]: unknown;
}

export async function slackApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackApiResponse> {
  const resp = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await resp.json().catch(() => ({}))) as SlackApiResponse;
  if (!resp.ok || json.ok === false) {
    throw new Error(`Slack ${method} failed: ${json.error || `HTTP ${resp.status}`}`);
  }
  return json;
}

export async function resolveSlackBotUserId(token: string): Promise<string | undefined> {
  const resp = await fetch(`${SLACK_API_BASE}/auth.test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await resp.json().catch(() => ({}))) as SlackApiResponse;
  if (!resp.ok || json.ok === false) return undefined;
  return typeof json.user_id === 'string' ? json.user_id : undefined;
}

export function renderSlackCardText(state: CardState): string {
  const parts: string[] = [];
  parts.push(`${STATUS_EMOJI[state.status]} *${escapeSlack(STATUS_LABEL[state.status])}*`);

  if (state.toolCalls.length > 0 && state.status !== 'complete' && state.status !== 'error') {
    const last = state.toolCalls[state.toolCalls.length - 1];
    const icon = last.status === 'running' ? ':hourglass_flowing_sand:' : ':white_check_mark:';
    parts.push(
      `${icon} *${escapeSlack(last.name)}* · ${state.toolCalls.length} tool${state.toolCalls.length > 1 ? 's' : ''}`,
    );
  }

  if (state.responseText) {
    parts.push(state.responseText);
  } else if (state.status === 'thinking') {
    parts.push('_Thinking..._');
  }

  if (state.pendingQuestion) {
    parts.push('');
    for (const q of state.pendingQuestion.questions) {
      parts.push(`*[${escapeSlack(q.header)}] ${escapeSlack(q.question)}*`);
      q.options.forEach((opt, i) => {
        parts.push(`${i + 1}. *${escapeSlack(opt.label)}* — _${escapeSlack(opt.description)}_`);
      });
      parts.push(`${q.options.length + 1}. Other（输入自定义回答）`);
    }
    parts.push('_Reply with a number, or type a custom answer._');
  }

  if (state.errorMessage) {
    parts.push(`*Error:* ${escapeSlack(state.errorMessage)}`);
  }

  const stats: string[] = [];
  if (state.totalTokens && state.contextWindow) {
    const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
    const tokensK = state.totalTokens >= 1000 ? `${(state.totalTokens / 1000).toFixed(1)}k` : String(state.totalTokens);
    stats.push(`ctx ${tokensK}/${Math.round(state.contextWindow / 1000)}k (${pct}%)`);
  }
  if (state.status === 'complete' || state.status === 'error') {
    if (state.model) stats.push(state.model.replace(/^claude-/, ''));
    if (state.durationMs !== undefined) stats.push(`${(state.durationMs / 1000).toFixed(1)}s`);
  }
  if (stats.length > 0) parts.push(`_${escapeSlack(stats.join(' | '))}_`);

  return truncate(parts.join('\n'));
}

function renderNoticeText(title: string, content: string): string {
  return truncate(`*${escapeSlack(title)}*\n\n${content}`);
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const half = Math.floor(MAX_MESSAGE_LENGTH / 2) - 32;
  return `${text.slice(0, half)}\n\n... (truncated) ...\n\n${text.slice(-half)}`;
}

export class SlackSender implements IMessageSender {
  skipCompletionNotice = true;

  constructor(
    private readonly config: SlackBotConfig,
    private readonly logger: Logger,
  ) {}

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    try {
      const result = await slackApi(this.config.slack.botToken, 'chat.postMessage', {
        channel: chatId,
        text: renderSlackCardText(state),
        mrkdwn: true,
      });
      if (typeof result.channel === 'string' && typeof result.ts === 'string') {
        return `slack:${result.channel}:${result.ts}`;
      }
      return undefined;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send Slack card');
      return undefined;
    }
  }

  async updateCard(messageId: string, state: CardState): Promise<boolean> {
    const ref = parseSlackMessageId(messageId);
    if (!ref) {
      this.logger.warn({ messageId }, 'Cannot update unknown Slack message');
      return false;
    }
    try {
      await slackApi(this.config.slack.botToken, 'chat.update', {
        channel: ref.channel,
        ts: ref.ts,
        text: renderSlackCardText(state),
        mrkdwn: true,
      });
      return true;
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to update Slack card');
      return false;
    }
  }

  async sendTextNotice(chatId: string, title: string, content: string, _color?: string): Promise<void> {
    await this.sendText(chatId, renderNoticeText(title, content));
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await slackApi(this.config.slack.botToken, 'chat.postMessage', {
        channel: chatId,
        text: truncate(text),
        mrkdwn: true,
      });
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send Slack text');
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    return this.sendLocalFile(chatId, filePath, path.basename(filePath));
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    try {
      const stat = fs.statSync(filePath);
      const start = await slackApi(this.config.slack.botToken, 'files.getUploadURLExternal', {
        filename: fileName,
        length: stat.size,
      });
      if (typeof start.upload_url !== 'string' || typeof start.file_id !== 'string') {
        throw new Error('Slack upload URL response missing upload_url/file_id');
      }
      const upload = await fetch(start.upload_url, {
        method: 'POST',
        body: fs.readFileSync(filePath),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!upload.ok) {
        throw new Error(`Slack file upload failed: HTTP ${upload.status}`);
      }
      await slackApi(this.config.slack.botToken, 'files.completeUploadExternalUpload', {
        files: [{ id: start.file_id, title: fileName }],
        channel_id: chatId,
      });
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send Slack file');
      return false;
    }
  }

  async downloadImage(_messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    return this.downloadFile(_messageId, imageKey, savePath);
  }

  async downloadFile(_messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    try {
      const url =
        fileKey.startsWith('http://') || fileKey.startsWith('https://')
          ? fileKey
          : await this.resolveSlackFileUrl(fileKey);
      if (!url) throw new Error('Slack file URL not found');
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.slack.botToken}` },
      });
      if (!resp.ok || !resp.body) throw new Error(`Slack file download failed: HTTP ${resp.status}`);
      const bytes = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(savePath, bytes);
      return true;
    } catch (err) {
      this.logger.error({ err, fileKey, savePath }, 'Failed to download Slack file');
      return false;
    }
  }

  private async resolveSlackFileUrl(fileId: string): Promise<string | undefined> {
    const info = await slackApi(this.config.slack.botToken, 'files.info', { file: fileId });
    return info.file?.url_private_download || info.file?.url_private;
  }
}

function parseSlackMessageId(messageId: string): { channel: string; ts: string } | undefined {
  const match = messageId.match(/^slack:([^:]+):(.+)$/);
  if (!match) return undefined;
  return { channel: match[1], ts: match[2] };
}
