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
 * Adapts the Feishu-specific MessageSender to the platform-agnostic IMessageSender interface.
 * Handles card building (CardState → Feishu JSON) internally.
 */
export class FeishuSenderAdapter implements IMessageSender {
  constructor(private sender: MessageSender) {}

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    return this.sender.sendCard(chatId, USE_V2 ? buildCardV2(state) : buildCard(state));
  }

  async updateCard(messageId: string, state: CardState): Promise<boolean> {
    return this.sender.updateCard(messageId, USE_V2 ? buildCardV2(state) : buildCard(state));
  }

  /**
   * AskUserQuestion card — always Schema 1.0, regardless of CARD_SCHEMA_V2.
   *
   * Why: Feishu mobile App silently drops `tag: action` button blocks under
   * Schema 2.0, so v2 question cards show up with NO buttons on iOS/Android.
   * v1 button rendering is verified working on mobile (PR #199 tested it).
   *
   * Why a SEPARATE card rather than switching the main streaming card's
   * schema mid-life: Feishu rejects `updateCard` with a different schema
   * than the original create ("ErrCode 200830: schemaV2 card can not change
   * schemaV1"). So the main streaming card stays v2 throughout, and the
   * question gets its own dedicated v1 card sent alongside.
   *
   * See memory: bug-feishu-v2-mobile-action-buttons.
   */
  async sendQuestionCard(chatId: string, state: CardState): Promise<string | undefined> {
    return this.sender.sendCard(chatId, buildCard(state));
  }

  async updateQuestionCard(messageId: string, state: CardState): Promise<boolean> {
    return this.sender.updateCard(messageId, buildCard(state));
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
