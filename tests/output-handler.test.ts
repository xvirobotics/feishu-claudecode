import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OutputHandler } from '../src/bridge/output-handler.js';
import { OutputsManager } from '../src/bridge/outputs-manager.js';
import type { CardState } from '../src/types.js';

/**
 * Output-file handling has two failure modes that look identical to a
 * Feishu user — "the bot didn't generate anything":
 *
 *   1. The agent never wrote a file (correctly silent)
 *   2. The file is too large to upload (was silent — bug)
 *
 * These tests lock in case (2): a single coalesced ⚠️ notice for the
 * whole batch, citing actual file names and sizes. Don't relax to per-
 * file notices (a 10-file all-oversized batch would spam) or back to
 * a logger.warn-only path (the regression).
 */

const mockLogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
} as any;

const mockProcessor = {
  getImagePaths: () => [],
} as any;

interface RecordedNotice {
  chatId:  string;
  title:   string;
  content: string;
  color?:  string;
}

interface RecordedSend {
  type:   'image' | 'file' | 'text';
  chatId: string;
  filePath?: string;
  fileName?: string;
}

function buildSender(opts: { failImage?: boolean; failFile?: boolean } = {}) {
  const notices: RecordedNotice[] = [];
  const sends:   RecordedSend[]   = [];
  const sender = {
    sendCard:      async () => undefined,
    updateCard:    async () => true,
    sendTextNotice: async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText:      async (chatId: string, text: string) => {
      sends.push({ type: 'text', chatId, filePath: text });
    },
    sendImageFile: async (chatId: string, filePath: string) => {
      sends.push({ type: 'image', chatId, filePath });
      return !opts.failImage;
    },
    sendLocalFile: async (chatId: string, filePath: string, fileName: string) => {
      sends.push({ type: 'file', chatId, filePath, fileName });
      return !opts.failFile;
    },
    downloadImage: async () => true,
    downloadFile:  async () => true,
  };
  return { sender: sender as any, notices, sends };
}

function emptyState(): CardState {
  return { status: 'complete', userPrompt: '', responseText: '', toolCalls: [] };
}

describe('OutputHandler.sendOutputFiles', () => {
  let tmpDir:   string;
  let outputs:  OutputsManager;
  let chatDir:  string;

  beforeEach(() => {
    tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-output-handler-'));
    outputs  = new OutputsManager(tmpDir, mockLogger);
    chatDir  = outputs.prepareDir('chat-1');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends a small image via sendImageFile', async () => {
    fs.writeFileSync(path.join(chatDir, 'pic.png'), Buffer.alloc(100));
    const { sender, sends, notices } = buildSender();
    await new OutputHandler(mockLogger, sender, outputs).sendOutputFiles('chat-1', chatDir, mockProcessor, emptyState());
    expect(sends).toEqual([expect.objectContaining({ type: 'image', chatId: 'chat-1' })]);
    expect(notices).toHaveLength(0);
  });

  it('sends a small file via sendLocalFile', async () => {
    fs.writeFileSync(path.join(chatDir, 'report.pdf'), Buffer.alloc(1024));
    const { sender, sends, notices } = buildSender();
    await new OutputHandler(mockLogger, sender, outputs).sendOutputFiles('chat-1', chatDir, mockProcessor, emptyState());
    expect(sends).toEqual([expect.objectContaining({ type: 'file', fileName: 'report.pdf' })]);
    expect(notices).toHaveLength(0);
  });

  it('sends an oversized-file notice when an image exceeds 10MB (regression)', async () => {
    // 10 MB + 1 byte
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    fs.writeFileSync(path.join(chatDir, 'huge.png'), big);
    const { sender, sends, notices } = buildSender();
    await new OutputHandler(mockLogger, sender, outputs).sendOutputFiles('chat-1', chatDir, mockProcessor, emptyState());
    expect(sends).toHaveLength(0);                   // upload skipped
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Too Large');
    expect(notices[0].content).toContain('huge.png');
    expect(notices[0].content).toMatch(/MB/);
    expect(notices[0].color).toBe('orange');
  });

  it('sends an oversized-file notice when a file exceeds 30MB (regression — previous limit was 50MB)', async () => {
    // 30 MB + 1 byte — would have squeezed through the old 50MB gate
    // and silently failed at the Feishu API. New cap catches it client-side.
    const big = Buffer.alloc(30 * 1024 * 1024 + 1);
    fs.writeFileSync(path.join(chatDir, 'video.mp4'), big);
    const { sender, sends, notices } = buildSender();
    await new OutputHandler(mockLogger, sender, outputs).sendOutputFiles('chat-1', chatDir, mockProcessor, emptyState());
    expect(sends).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('video.mp4');
    expect(notices[0].content).toMatch(/30MB/);      // limit cited
  });

  it('coalesces multiple oversized files into a single notice', async () => {
    fs.writeFileSync(path.join(chatDir, 'huge1.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(chatDir, 'huge2.zip'), Buffer.alloc(30 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(chatDir, 'ok.txt'),    Buffer.alloc(100));
    const { sender, sends, notices } = buildSender();
    await new OutputHandler(mockLogger, sender, outputs).sendOutputFiles('chat-1', chatDir, mockProcessor, emptyState());
    // ok.txt should still be sent
    expect(sends).toEqual([expect.objectContaining({ fileName: 'ok.txt' })]);
    // Single notice listing both oversized files
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('huge1.png');
    expect(notices[0].content).toContain('huge2.zip');
    expect(notices[0].content).toContain('2');  // count
  });

  it('uses singular wording when exactly one file is oversized', async () => {
    fs.writeFileSync(path.join(chatDir, 'huge.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    const { sender, notices } = buildSender();
    await new OutputHandler(mockLogger, sender, outputs).sendOutputFiles('chat-1', chatDir, mockProcessor, emptyState());
    expect(notices[0].content).toMatch(/1\*\* file because it exceeds/);
    expect(notices[0].content).not.toMatch(/files because they/);
  });
});
