import * as fs from 'node:fs';
import type { Logger } from '../utils/logger.js';
import type { CardState } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import { StreamProcessor, extractImagePaths } from '../engines/index.js';
import { OutputsManager } from './outputs-manager.js';

/**
 * Feishu API limits documented at
 *   https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create
 *   https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/file/create
 *
 * Previous value of 50 MB for FILE_MAX_BYTES was incorrect — uploads in
 * the 30-50 MB range would attempt and silently fail at the Feishu API
 * level with the user never knowing. Aligning to the documented cap
 * lets the OversizedNotice path catch them instead.
 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const FILE_MAX_BYTES  = 30 * 1024 * 1024; // 30 MB

interface OversizedFile {
  fileName:  string;
  sizeBytes: number;
  isImage:   boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

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
    const oversized: OversizedFile[] = [];

    // 1. Scan the outputs directory for any files the agent placed there
    const outputFiles = this.outputsManager.scanOutputs(outputsDir);
    for (const file of outputFiles) {
      try {
        if (file.isImage && file.sizeBytes <= IMAGE_MAX_BYTES) {
          this.logger.info({ filePath: file.filePath }, 'Sending output image from outputs dir');
          await this.sender.sendImageFile(chatId, file.filePath);
        } else if (!file.isImage && file.sizeBytes <= FILE_MAX_BYTES) {
          this.logger.info({ filePath: file.filePath }, 'Sending output file from outputs dir');
          const sent = await this.sender.sendLocalFile(chatId, file.filePath, file.fileName);
          if (!sent && OutputsManager.isTextFile(file.extension) && file.sizeBytes < 30 * 1024) {
            this.logger.info({ filePath: file.filePath }, 'File upload failed, sending as text message');
            const content = fs.readFileSync(file.filePath, 'utf-8');
            await this.sender.sendText(chatId, `📄 ${file.fileName}\n\n${content}`);
          }
        } else {
          // Track for a single end-of-batch notice so users know files exist
          // but were dropped — silently logging warn was the original bug.
          this.logger.warn({ filePath: file.filePath, sizeBytes: file.sizeBytes }, 'Output file too large to send');
          oversized.push({ fileName: file.fileName, sizeBytes: file.sizeBytes, isImage: file.isImage });
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
          if (size <= 0) continue;
          if (size <= IMAGE_MAX_BYTES) {
            this.logger.info({ imgPath }, 'Sending output image (fallback)');
            await this.sender.sendImageFile(chatId, imgPath);
          } else {
            // Same notice path as the outputs-dir scan — match user-visible behaviour.
            this.logger.warn({ imgPath, sizeBytes: size }, 'Fallback output image too large to send');
            oversized.push({ fileName: imgPath.split('/').pop() ?? imgPath, sizeBytes: size, isImage: true });
          }
        }
      } catch (err) {
        this.logger.warn({ err, imgPath }, 'Failed to send output image');
      }
    }

    // 3. If anything was dropped for being too large, tell the user. Previously
    //    these failed silently — users assumed the bot just didn't generate
    //    the file. One coalesced notice for the whole batch instead of one
    //    per file so a 10-file batch with all-oversized doesn't spam.
    if (oversized.length > 0) {
      await this.sendOversizedNotice(chatId, oversized);
    }
  }

  private async sendOversizedNotice(chatId: string, files: OversizedFile[]): Promise<void> {
    const lines = [
      `Cannot send **${files.length}** file${files.length === 1 ? '' : 's'} because ${files.length === 1 ? 'it exceeds' : 'they exceed'} the Feishu upload limit (max ${IMAGE_MAX_BYTES / 1024 / 1024}MB images, ${FILE_MAX_BYTES / 1024 / 1024}MB files):`,
      '',
      ...files.map((f) => `- \`${f.fileName}\` — ${formatBytes(f.sizeBytes)}${f.isImage ? ' (image)' : ''}`),
    ];
    try {
      await this.sender.sendTextNotice(chatId, '⚠️ Files Too Large', lines.join('\n'), 'orange');
    } catch (err) {
      this.logger.warn({ err, chatId, count: files.length }, 'Failed to send oversized-file notice');
    }
  }
}
