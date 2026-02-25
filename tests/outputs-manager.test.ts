import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OutputsManager } from '../src/bridge/outputs-manager.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

describe('OutputsManager', () => {
  let tmpDir: string;
  let manager: OutputsManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-test-'));
    manager = new OutputsManager(tmpDir, mockLogger);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('prepareDir', () => {
    it('creates a chat-specific directory', () => {
      const dir = manager.prepareDir('chat-123');
      expect(fs.existsSync(dir)).toBe(true);
      expect(dir).toBe(path.join(tmpDir, 'chat-123'));
    });

    it('clears existing directory contents', () => {
      const dir = manager.prepareDir('chat-123');
      fs.writeFileSync(path.join(dir, 'old.txt'), 'old content');
      const dir2 = manager.prepareDir('chat-123');
      expect(fs.readdirSync(dir2)).toHaveLength(0);
    });
  });

  describe('scanOutputs', () => {
    it('returns empty for non-existent directory', () => {
      expect(manager.scanOutputs('/nonexistent')).toEqual([]);
    });

    it('detects image files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'chart.png'), 'fake-png-data');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('chart.png');
      expect(files[0].isImage).toBe(true);
      expect(files[0].extension).toBe('.png');
    });

    it('detects non-image files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'report.pdf'), 'fake-pdf-data');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(1);
      expect(files[0].isImage).toBe(false);
      expect(files[0].extension).toBe('.pdf');
    });

    it('skips empty files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'empty.txt'), '');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(0);
    });

    it('skips directories', () => {
      const dir = manager.prepareDir('chat-1');
      fs.mkdirSync(path.join(dir, 'subdir'));
      fs.writeFileSync(path.join(dir, 'file.txt'), 'content');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('file.txt');
    });

    it('returns multiple files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'a.png'), 'img');
      fs.writeFileSync(path.join(dir, 'b.pdf'), 'pdf');
      fs.writeFileSync(path.join(dir, 'c.jpg'), 'jpg');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(3);
    });
  });

  describe('cleanup', () => {
    it('removes the outputs directory', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'data');
      manager.cleanup(dir);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('handles non-existent directory gracefully', () => {
      expect(() => manager.cleanup('/nonexistent/path')).not.toThrow();
    });
  });

  describe('static methods', () => {
    it('isTextFile identifies text extensions', () => {
      expect(OutputsManager.isTextFile('.md')).toBe(true);
      expect(OutputsManager.isTextFile('.py')).toBe(true);
      expect(OutputsManager.isTextFile('.json')).toBe(true);
      expect(OutputsManager.isTextFile('.png')).toBe(false);
      expect(OutputsManager.isTextFile('.pdf')).toBe(false);
    });

    it('feishuFileType maps extensions correctly', () => {
      expect(OutputsManager.feishuFileType('.pdf')).toBe('pdf');
      expect(OutputsManager.feishuFileType('.docx')).toBe('doc');
      expect(OutputsManager.feishuFileType('.xlsx')).toBe('xls');
      expect(OutputsManager.feishuFileType('.pptx')).toBe('ppt');
      expect(OutputsManager.feishuFileType('.zip')).toBe('stream');
    });
  });
});
