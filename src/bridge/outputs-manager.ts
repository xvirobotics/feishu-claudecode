import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);

export interface OutputFile {
  filePath: string;
  fileName: string;
  extension: string;
  isImage: boolean;
  sizeBytes: number;
}

export class OutputsManager {
  constructor(
    private baseDir: string,
    private logger: Logger,
  ) {}

  /** Create a fresh per-chat outputs directory, clearing any leftovers. */
  prepareDir(chatId: string): string {
    const dir = path.join(this.baseDir, chatId);
    // Remove leftover directory from a previous run
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
    fs.mkdirSync(dir, { recursive: true });
    this.logger.debug({ dir }, 'Prepared outputs directory');
    return dir;
  }

  /** Scan the outputs directory and return metadata for each file found. */
  scanOutputs(outputsDir: string): OutputFile[] {
    const results: OutputFile[] = [];
    try {
      if (!fs.existsSync(outputsDir)) return results;
      const entries = fs.readdirSync(outputsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(outputsDir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        const stat = fs.statSync(filePath);
        if (stat.size === 0) continue;
        results.push({
          filePath,
          fileName: entry.name,
          extension: ext,
          isImage: IMAGE_EXTENSIONS.has(ext),
          sizeBytes: stat.size,
        });
      }
    } catch (err) {
      this.logger.warn({ err, outputsDir }, 'Failed to scan outputs directory');
    }
    return results;
  }

  /** Remove the outputs directory after files have been sent. */
  cleanup(outputsDir: string): void {
    try {
      fs.rmSync(outputsDir, { recursive: true, force: true });
      this.logger.debug({ outputsDir }, 'Cleaned up outputs directory');
    } catch { /* ignore */ }
  }

  /** Map file extension to Feishu file type for im.v1.file.create. */
  static feishuFileType(ext: string): string {
    switch (ext) {
      case '.pdf': return 'pdf';
      case '.doc':
      case '.docx': return 'doc';
      case '.xls':
      case '.xlsx': return 'xls';
      case '.ppt':
      case '.pptx': return 'ppt';
      default: return 'stream';
    }
  }
}
