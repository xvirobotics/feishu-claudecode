import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);

/** How long to keep output files before cleanup (ms). */
const RETENTION_MS = 5 * 60 * 1000; // 5 minutes

export interface OutputFile {
  filePath: string;
  fileName: string;
  extension: string;
  isImage: boolean;
  sizeBytes: number;
}

export class OutputsManager {
  /** Tracks directories scheduled for deferred cleanup: dir -> timeout handle */
  private pendingCleanups = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private baseDir: string,
    private logger: Logger,
  ) {}

  /** Create a fresh per-chat outputs directory, preserving recent files. */
  prepareDir(chatId: string): string {
    const dir = path.join(this.baseDir, chatId);

    // Cancel any pending deferred cleanup for this directory
    const pending = this.pendingCleanups.get(dir);
    if (pending) {
      clearTimeout(pending);
      this.pendingCleanups.delete(dir);
    }

    // Only remove files older than RETENTION_MS, keep recent ones
    try {
      if (fs.existsSync(dir)) {
        const now = Date.now();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const filePath = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > RETENTION_MS) {
              fs.unlinkSync(filePath);
            }
          } catch { /* ignore individual file errors */ }
        }
      } else {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // If anything fails, ensure the directory exists
      fs.mkdirSync(dir, { recursive: true });
    }

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

  /** Schedule deferred cleanup of the outputs directory after RETENTION_MS. */
  cleanup(outputsDir: string): void {
    // Cancel any existing timer for this dir
    const existing = this.pendingCleanups.get(outputsDir);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pendingCleanups.delete(outputsDir);
      try {
        fs.rmSync(outputsDir, { recursive: true, force: true });
        this.logger.debug({ outputsDir }, 'Cleaned up outputs directory (deferred)');
      } catch { /* ignore */ }
    }, RETENTION_MS);

    // Don't let the timer keep the process alive
    timer.unref();

    this.pendingCleanups.set(outputsDir, timer);
    this.logger.debug({ outputsDir, retentionMs: RETENTION_MS }, 'Scheduled deferred outputs cleanup');
  }

  /** Check if a file extension is a text-based format that can be sent as text. */
  static isTextFile(ext: string): boolean {
    const textExts = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.css', '.js', '.ts', '.py', '.sh', '.sql', '.ini', '.cfg', '.conf', '.toml']);
    return textExts.has(ext);
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
