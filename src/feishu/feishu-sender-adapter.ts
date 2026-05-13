import * as path from 'node:path';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState } from '../types.js';
import { MessageSender } from './message-sender.js';
import { buildCard, buildTextCard } from './card-builder.js';
import { buildCardV2, buildTextCardV2 } from './card-builder-v2.js';
import { OutputsManager } from '../bridge/outputs-manager.js';

// v2 (native table + lark_md headings + grey footer) is the default.
// Set CARD_SCHEMA_V2=false to opt out and fall back to v1.
const USE_V2 = process.env.CARD_SCHEMA_V2 !== 'false';

/**
 * Pick which card builder to use for a given state.
 *
 * Default: v2. Override: v1 when the card carries an AskUserQuestion
 * (`state.pendingQuestion`). Reason: Feishu mobile App doesn't render
 * `tag: action` blocks under Card Schema 2.0, so the option buttons go
 * invisible on iOS/Android even though the JSON is correct (logs confirm
 * card content is sent but no `card.action.trigger` events come back).
 * v1 button rendering is verified working on mobile (PR #199). Question
 * cards don't use any v2-exclusive feature (native table / lark_md
 * heading), so falling back to v1 has no visible regression.
 *
 * See memory: bug-feishu-v2-mobile-action-buttons.
 */
export function buildCardForState(state: CardState): string {
  if (USE_V2 && !state.pendingQuestion) return buildCardV2(state);
  return buildCard(state);
}

/**
 * Adapts the Feishu-specific MessageSender to the platform-agnostic IMessageSender interface.
 * Handles card building (CardState → Feishu JSON) internally.
 */
export class FeishuSenderAdapter implements IMessageSender {
  constructor(private sender: MessageSender) {}

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    return this.sender.sendCard(chatId, buildCardForState(state));
  }

  async updateCard(messageId: string, state: CardState): Promise<boolean> {
    return this.sender.updateCard(messageId, buildCardForState(state));
  }

  async sendTextNotice(chatId: string, title: string, content: string, color: string = 'blue'): Promise<void> {
    await this.sender.sendCard(chatId, USE_V2 ? buildTextCardV2(title, content, color) : buildTextCard(title, content, color));
  }

  async sendText(chatId: string, text: string): Promise<void> {
    return this.sender.sendText(chatId, text);
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    return this.sender.sendImageFile(chatId, filePath);
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    const ext = path.extname(fileName).toLowerCase();
    const feishuType = OutputsManager.feishuFileType(ext);
    return this.sender.sendLocalFile(chatId, filePath, fileName, feishuType);
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    return this.sender.downloadImage(messageId, imageKey, savePath);
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    return this.sender.downloadFile(messageId, fileKey, savePath);
  }
}
