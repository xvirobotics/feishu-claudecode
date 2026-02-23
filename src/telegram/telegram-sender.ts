import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { Bot, InputFile } from 'grammy';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState, CardStatus } from '../types.js';
import type { Logger } from '../utils/logger.js';

const MAX_MESSAGE_LENGTH = 4096;

const STATUS_EMOJI: Record<CardStatus, string> = {
  thinking: '\u{1F535}',      // 🔵
  running: '\u{1F535}',       // 🔵
  complete: '\u{1F7E2}',      // 🟢
  error: '\u{1F534}',         // 🔴
  waiting_for_input: '\u{1F7E1}', // 🟡
};

const STATUS_LABEL: Record<CardStatus, string> = {
  thinking: 'Thinking...',
  running: 'Running...',
  complete: 'Complete',
  error: 'Error',
  waiting_for_input: 'Waiting for Input',
};

/**
 * Renders a CardState into an HTML string for Telegram.
 * Telegram supports a subset of HTML: <b>, <i>, <code>, <pre>, <a>.
 */
function renderCardHtml(state: CardState): string {
  const parts: string[] = [];

  // Header
  const emoji = STATUS_EMOJI[state.status];
  const label = STATUS_LABEL[state.status];
  parts.push(`${emoji} <b>${escapeHtml(label)}</b>`);
  parts.push('');

  // Tool calls
  if (state.toolCalls.length > 0) {
    for (const t of state.toolCalls) {
      const icon = t.status === 'running' ? '\u{23F3}' : '\u{2705}'; // ⏳ / ✅
      parts.push(`${icon} <b>${escapeHtml(t.name)}</b> ${escapeHtml(t.detail)}`);
    }
    parts.push('---');
  }

  // Response text
  if (state.responseText) {
    parts.push(markdownToTelegramHtml(state.responseText));
  } else if (state.status === 'thinking') {
    parts.push('<i>Claude is thinking...</i>');
  }

  // Pending question
  if (state.pendingQuestion) {
    parts.push('');
    parts.push('---');
    for (const q of state.pendingQuestion.questions) {
      parts.push(`<b>[${escapeHtml(q.header)}] ${escapeHtml(q.question)}</b>`);
      parts.push('');
      q.options.forEach((opt, i) => {
        parts.push(`<b>${i + 1}.</b> ${escapeHtml(opt.label)} \u{2014} <i>${escapeHtml(opt.description)}</i>`);
      });
      parts.push(`<b>${q.options.length + 1}.</b> Other\uFF08\u8F93\u5165\u81EA\u5B9A\u4E49\u56DE\u7B54\uFF09`);
      parts.push('');
    }
    parts.push('<i>\u56DE\u590D\u6570\u5B57\u9009\u62E9\uFF0C\u6216\u76F4\u63A5\u8F93\u5165\u81EA\u5B9A\u4E49\u7B54\u6848</i>');
  }

  // Error message
  if (state.errorMessage) {
    parts.push('');
    parts.push(`<b>Error:</b> ${escapeHtml(state.errorMessage)}`);
  }

  // Stats
  if (state.status === 'complete' || state.status === 'error') {
    const statParts: string[] = [];
    if (state.durationMs !== undefined) {
      statParts.push(`Duration: ${(state.durationMs / 1000).toFixed(1)}s`);
    }
    if (state.costUsd !== undefined) {
      statParts.push(`Cost: $${state.costUsd.toFixed(4)}`);
    }
    if (statParts.length > 0) {
      parts.push('');
      parts.push(`<i>${escapeHtml(statParts.join(' | '))}</i>`);
    }
  }

  return truncateMessage(parts.join('\n'));
}

/**
 * Renders a simple notice message as HTML for Telegram.
 */
function renderNoticeHtml(title: string, content: string): string {
  const parts: string[] = [];
  parts.push(`<b>${escapeHtml(title)}</b>`);
  parts.push('');
  parts.push(markdownToTelegramHtml(content));
  return truncateMessage(parts.join('\n'));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Converts Markdown text to Telegram-compatible HTML.
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough, links, headings.
 * All non-markdown text is HTML-escaped to prevent injection.
 */
function markdownToTelegramHtml(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block start/end
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        codeBlockLines = [];
      } else {
        // End of code block
        inCodeBlock = false;
        const codeContent = escapeHtml(codeBlockLines.join('\n'));
        if (codeBlockLang) {
          result.push(`<pre><code class="language-${escapeHtml(codeBlockLang)}">${codeContent}</code></pre>`);
        } else {
          result.push(`<pre>${codeContent}</pre>`);
        }
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Convert inline markdown for non-code-block lines
    result.push(convertInlineMarkdown(line));
  }

  // If code block was never closed, render what we have
  if (inCodeBlock) {
    const codeContent = escapeHtml(codeBlockLines.join('\n'));
    result.push(`<pre>${codeContent}</pre>`);
  }

  return result.join('\n');
}

/**
 * Converts inline Markdown syntax to Telegram HTML for a single line.
 */
function convertInlineMarkdown(line: string): string {
  // Headings: # Heading → <b>Heading</b>
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return `<b>${convertInlineFormatting(headingMatch[2])}</b>`;
  }

  // Horizontal rule: --- or *** or ___
  if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
    return '---';
  }

  // Unordered list: - item or * item
  const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (ulMatch) {
    return `${ulMatch[1]}• ${convertInlineFormatting(ulMatch[2])}`;
  }

  // Ordered list: 1. item
  const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (olMatch) {
    return `${olMatch[1]}${olMatch[2]}. ${convertInlineFormatting(olMatch[3])}`;
  }

  // Blockquote: > text
  const bqMatch = line.match(/^>\s?(.*)$/);
  if (bqMatch) {
    return `┃ <i>${convertInlineFormatting(bqMatch[1])}</i>`;
  }

  return convertInlineFormatting(line);
}

/**
 * Converts inline formatting: bold, italic, strikethrough, code, links.
 */
function convertInlineFormatting(text: string): string {
  // Split out inline code spans first to avoid processing markdown inside them
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (!codeMatch || codeMatch.index === undefined) {
      parts.push(formatNonCode(remaining));
      break;
    }
    // Text before inline code
    if (codeMatch.index > 0) {
      parts.push(formatNonCode(remaining.slice(0, codeMatch.index)));
    }
    // Inline code — only escape HTML, no further formatting
    parts.push(`<code>${escapeHtml(codeMatch[1])}</code>`);
    remaining = remaining.slice(codeMatch.index + codeMatch[0].length);
  }

  return parts.join('');
}

/**
 * Apply formatting (bold, italic, strikethrough, links) to non-code text.
 */
function formatNonCode(text: string): string {
  let result = escapeHtml(text);

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold + Italic: ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  result = result.replace(/___(.+?)___/g, '<b><i>$1</i></b>');

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (avoid matching mid-word underscores like variable_name)
  result = result.replace(/\*(.+?)\*/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  return result;
}

function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const half = Math.floor(MAX_MESSAGE_LENGTH / 2) - 30;
  return (
    text.slice(0, half) +
    '\n\n... (truncated) ...\n\n' +
    text.slice(-half)
  );
}

/**
 * Telegram implementation of IMessageSender.
 * Uses grammY Bot API for sending/updating messages.
 */
export class TelegramSender implements IMessageSender {
  /** Map of messageId (string) to { chatId, messageIdNum } for updates. */
  private messageMap = new Map<string, { chatId: number; messageId: number }>();

  constructor(
    private bot: Bot,
    private logger: Logger,
  ) {}

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    try {
      const html = renderCardHtml(state);
      const msg = await this.bot.api.sendMessage(Number(chatId), html, { parse_mode: 'HTML' });
      const msgIdStr = `tg:${chatId}:${msg.message_id}`;
      this.messageMap.set(msgIdStr, { chatId: Number(chatId), messageId: msg.message_id });
      return msgIdStr;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send Telegram message');
      return undefined;
    }
  }

  async updateCard(messageId: string, state: CardState): Promise<void> {
    const ref = this.messageMap.get(messageId);
    if (!ref) {
      this.logger.warn({ messageId }, 'Cannot update unknown Telegram message');
      return;
    }
    try {
      const html = renderCardHtml(state);
      await this.bot.api.editMessageText(ref.chatId, ref.messageId, html, { parse_mode: 'HTML' });
    } catch (err: any) {
      // Telegram returns 400 if message content hasn't changed — ignore
      if (err?.error_code === 400 && err?.description?.includes('message is not modified')) {
        return;
      }
      this.logger.error({ err, messageId }, 'Failed to update Telegram message');
    }
  }

  async sendTextNotice(chatId: string, title: string, content: string, _color?: string): Promise<void> {
    try {
      const html = renderNoticeHtml(title, content);
      await this.bot.api.sendMessage(Number(chatId), html, { parse_mode: 'HTML' });
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send Telegram notice');
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      const truncated = truncateMessage(text);
      await this.bot.api.sendMessage(Number(chatId), truncated);
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send Telegram text');
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    try {
      await this.bot.api.sendPhoto(Number(chatId), new InputFile(filePath));
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send Telegram photo');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    try {
      await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath, fileName));
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, filePath }, 'Failed to send Telegram document');
      return false;
    }
  }

  async downloadImage(messageId: string, fileId: string, savePath: string): Promise<boolean> {
    return this.downloadTelegramFile(fileId, savePath);
  }

  async downloadFile(messageId: string, fileId: string, savePath: string): Promise<boolean> {
    return this.downloadTelegramFile(fileId, savePath);
  }

  private async downloadTelegramFile(fileId: string, savePath: string): Promise<boolean> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        this.logger.error({ fileId }, 'Telegram file has no file_path');
        return false;
      }

      const token = this.bot.token;
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

      await downloadUrl(url, savePath);
      this.logger.info({ fileId, savePath }, 'Downloaded Telegram file');
      return true;
    } catch (err) {
      this.logger.error({ err, fileId }, 'Failed to download Telegram file');
      return false;
    }
  }
}

function downloadUrl(url: string, savePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const fileStream = fs.createWriteStream(savePath);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        fileStream.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}
