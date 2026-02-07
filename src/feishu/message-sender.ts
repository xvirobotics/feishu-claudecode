import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

export class MessageSender {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  async sendCard(chatId: string, cardContent: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: cardContent,
          msg_type: 'interactive',
        },
      });

      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.error({ resp }, 'Failed to get message_id from send response');
      }
      return messageId;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send card');
      return undefined;
    }
  }

  async updateCard(messageId: string, cardContent: string): Promise<void> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardContent },
      });
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to update card');
    }
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, imageKey, savePath }, 'Image downloaded');
        return true;
      }
      this.logger.error({ messageId, imageKey }, 'Empty response when downloading image');
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, imageKey }, 'Failed to download image');
      return false;
    }
  }

  async uploadImage(filePath: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });
      const imageKey = resp?.image_key;
      if (imageKey) {
        this.logger.info({ filePath, imageKey }, 'Image uploaded to Feishu');
      }
      return imageKey;
    } catch (err) {
      this.logger.error({ err, filePath }, 'Failed to upload image');
      return undefined;
    }
  }

  async sendImage(chatId: string, imageKey: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });
    } catch (err) {
      this.logger.error({ err, chatId, imageKey }, 'Failed to send image');
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    const imageKey = await this.uploadImage(filePath);
    if (!imageKey) return false;
    await this.sendImage(chatId, imageKey);
    return true;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send text');
    }
  }
}
