import type { IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState } from '../types.js';

/**
 * No-op message sender for web-only bots.
 * Web bots communicate exclusively via WebSocket — no Feishu/Telegram messages.
 */
export class NullSender implements IMessageSender {
  async sendCard(_chatId: string, _state: CardState): Promise<string | undefined> {
    return undefined;
  }
  async updateCard(_messageId: string, _state: CardState): Promise<boolean> {
    return true;
  }
  async sendTextNotice(_chatId: string, _title: string, _content: string, _color?: string): Promise<void> {}
  async sendText(_chatId: string, _text: string): Promise<void> {}
  async sendImageFile(_chatId: string, _filePath: string): Promise<boolean> {
    return false;
  }
  async sendLocalFile(_chatId: string, _filePath: string, _fileName: string): Promise<boolean> {
    return false;
  }
  async downloadImage(_messageId: string, _imageKey: string, _savePath: string): Promise<boolean> {
    return false;
  }
  async downloadFile(_messageId: string, _fileKey: string, _savePath: string): Promise<boolean> {
    return false;
  }
}
