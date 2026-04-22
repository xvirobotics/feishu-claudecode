import * as fs from 'node:fs';
import type { Logger } from '../utils/logger.js';
import type { CardState } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import { StreamProcessor, extractImagePaths } from '../engines/index.js';
import { OutputsManager } from './outputs-manager.js';

export class OutputHandler {
  constructor(
    private logger: Logger,
    private sender: IMessageSender,
    private outputsManager: OutputsManager,
  ) {}

  async sendOutputFiles(
    chatId: string,
    outputsDir: string,
    processor: StreamProcessor,
    state: CardState,
  ): Promise<void> {
    const sentPaths = new Set<string>();

    // 1. Scan the outputs directory for any files Claude placed there
    const outputFiles = this.outputsManager.scanOutputs(outputsDir);
    for (const file of outputFiles) {
      try {
        if (file.isImage && file.sizeBytes < 10 * 1024 * 1024) {
          this.logger.info({ filePath: file.filePath }, 'Sending output image from outputs dir');
          await this.sender.sendImageFile(chatId, file.filePath);
        } else if (!file.isImage && file.sizeBytes < 50 * 1024 * 1024) {
          this.logger.info({ filePath: file.filePath }, 'Sending output file from outputs dir');
          const sent = await this.sender.sendLocalFile(chatId, file.filePath, file.fileName);
          if (!sent && OutputsManager.isTextFile(file.extension) && file.sizeBytes < 30 * 1024) {
            this.logger.info({ filePath: file.filePath }, 'File upload failed, sending as text message');
            const content = fs.readFileSync(file.filePath, 'utf-8');
            await this.sender.sendText(chatId, `📄 ${file.fileName}\n\n${content}`);
          }
        } else {
          this.logger.warn({ filePath: file.filePath, sizeBytes: file.sizeBytes }, 'Output file too large to send');
        }
        sentPaths.add(file.filePath);
      } catch (err) {
        this.logger.warn({ err, filePath: file.filePath }, 'Failed to send output file');
      }
    }

    // 2. Fallback: send images detected via old method (Write tool tracking + response text scanning)
    const imagePaths = new Set<string>(processor.getImagePaths());
    if (state.responseText) {
      for (const p of extractImagePaths(state.responseText)) {
        imagePaths.add(p);
      }
    }

    for (const imgPath of imagePaths) {
      if (sentPaths.has(imgPath)) continue;
      try {
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).isFile()) {
          const size = fs.statSync(imgPath).size;
          if (size > 0 && size < 10 * 1024 * 1024) {
            this.logger.info({ imgPath }, 'Sending output image (fallback)');
            await this.sender.sendImageFile(chatId, imgPath);
          }
        }
      } catch (err) {
        this.logger.warn({ err, imgPath }, 'Failed to send output image');
      }
    }
  }
}
