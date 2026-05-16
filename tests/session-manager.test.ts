import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../src/engines/claude/session-manager.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'metabot-session-test-'));
    process.env.SESSION_STORE_DIR = storeDir;
  });

  afterEach(() => {
    if (manager) manager.destroy();
    delete process.env.SESSION_STORE_DIR;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it('creates a new session with default working directory', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const session = manager.getSession('chat1');
    expect(session.workingDirectory).toBe('/tmp/test-dir');
    expect(session.sessionId).toBeUndefined();
  });

  it('returns the same session for the same chatId', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat1');
    expect(s1).toBe(s2);
  });

  it('returns different sessions for different chatIds', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat2');
    expect(s1).not.toBe(s2);
  });

  it('sets session ID', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBe('sess-abc');
    expect(session.sessionIdEngine).toBe('codex');
  });

  it('resets session (clears sessionId)', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    manager.resetSession('chat1');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBeUndefined();
    expect(session.sessionIdEngine).toBeUndefined();
  });

  it('tracks model engine and clears it with the model override', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.setSessionModel('chat1', 'gpt-5.5-codex', 'codex');

    let session = manager.getSession('chat1');
    expect(session.model).toBe('gpt-5.5-codex');
    expect(session.modelEngine).toBe('codex');

    manager.setSessionModel('chat1', undefined);
    session = manager.getSession('chat1');
    expect(session.model).toBeUndefined();
    expect(session.modelEngine).toBeUndefined();
  });

  it('persists session and model engine metadata', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'persist-test');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    manager.setSessionModel('chat1', 'gpt-5.5-codex', 'codex');
    manager.destroy();

    manager = new SessionManager('/tmp/test-dir', createLogger(), 'persist-test');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBe('sess-abc');
    expect(session.sessionIdEngine).toBe('codex');
    expect(session.model).toBe('gpt-5.5-codex');
    expect(session.modelEngine).toBe('codex');
  });
});
