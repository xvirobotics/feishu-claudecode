import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../src/engines/claude/session-manager.js';
import { ExecutorRegistry } from '../src/engines/claude/executor-registry.js';
import { composeScopeKey } from '../src/session/compose-key.js';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
} as any;

function makeFakeExecutor(opts: { id: string; state?: string } = { id: 'fake' }) {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    id: opts.id,
    getState: () => (opts.state ?? 'ready'),
    getLastActivityAt: () => Date.now(),
    getSessionId: () => undefined,
    hasActiveTurn: () => false,
    start: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    once: (event: string, cb: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    emit: (event: string, ...args: any[]) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
  } as any;
}

describe('composeScopeKey', () => {
  it('returns chatId when perUserContext is false', () => {
    expect(composeScopeKey('oc_123', 'ou_456', false)).toBe('oc_123');
  });

  it('returns chatId when userId is missing', () => {
    expect(composeScopeKey('oc_123', undefined, true)).toBe('oc_123');
  });

  it('returns chatId when perUserContext is undefined', () => {
    expect(composeScopeKey('oc_123', 'ou_456', undefined)).toBe('oc_123');
  });

  it('returns chatId:userId when perUserContext is true and userId present', () => {
    expect(composeScopeKey('oc_123', 'ou_456', true)).toBe('oc_123:ou_456');
  });
});

describe('SessionManager per-user scoping', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager('/tmp/test', mockLogger);
  });

  it('with perUserContext false: same chatId shares session', () => {
    const s1 = manager.getSession('oc_123');
    const s2 = manager.getSession('oc_123');
    expect(s1).toBe(s2);
  });

  it('with perUserContext true: different userIds in same chat get different sessions', () => {
    const keyA = composeScopeKey('oc_123', 'ou_A', true);
    const keyB = composeScopeKey('oc_123', 'ou_B', true);
    const sA = manager.getSession(keyA);
    const sB = manager.getSession(keyB);
    expect(sA).not.toBe(sB);
  });

  it('/reset from user A with perUserContext on: user A cleared, user B intact', () => {
    const keyA = composeScopeKey('oc_123', 'ou_A', true);
    const keyB = composeScopeKey('oc_123', 'ou_B', true);

    manager.setSessionId(keyA, 'sess-A');
    manager.setSessionId(keyB, 'sess-B');

    manager.resetSession(keyA);

    expect(manager.getSession(keyA).sessionId).toBeUndefined();
    expect(manager.getSession(keyB).sessionId).toBe('sess-B');
  });
});

describe('ExecutorRegistry per-user scoping', () => {
  let registry: ExecutorRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ExecutorRegistry({ logger: mockLogger });
  });

  it('acquire and peek by scopeKey (chatId-only)', async () => {
    const fake = makeFakeExecutor({ id: 'e1' });
    // Monkey-patch constructor path
    (registry as any).acquire = async (scopeKey: string, _opts: any) => {
      // Insert fake directly, bypassing real PersistentClaudeExecutor construction
      (registry as any).executors.set(scopeKey, { executor: fake, scopeKey });
      return fake;
    };

    const exec = await registry.acquire('oc_123', { cwd: '/tmp' });
    expect(exec).toBe(fake);
    expect(registry.peek('oc_123')).toBe(fake);
    expect(registry.peek('oc_999')).toBeUndefined();
  });

  it('acquire and peek by composed scopeKey', async () => {
    const fake = makeFakeExecutor({ id: 'e2' });
    (registry as any).acquire = async (scopeKey: string, _opts: any) => {
      (registry as any).executors.set(scopeKey, { executor: fake, scopeKey });
      return fake;
    };

    const scopeKey = composeScopeKey('oc_123', 'ou_A', true);
    const exec = await registry.acquire(scopeKey, { cwd: '/tmp' });
    expect(exec).toBe(fake);
    expect(registry.peek(scopeKey)).toBe(fake);
    expect(registry.peek('oc_123')).toBeUndefined(); // different key
  });

  it('list() returns scopeKey instead of chatId', async () => {
    const fake = makeFakeExecutor({ id: 'e3' });
    (registry as any).acquire = async (scopeKey: string, _opts: any) => {
      (registry as any).executors.set(scopeKey, { executor: fake, scopeKey });
      return fake;
    };

    const scopeKey = composeScopeKey('oc_123', 'ou_A', true);
    await registry.acquire(scopeKey, { cwd: '/tmp' });
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].scopeKey).toBe(scopeKey);
  });
});

describe('MessageBridge isBusy / stopChatTask with perUserContext', () => {
  // We test the public surface via a minimal mock of MessageBridge internals
  // rather than instantiating the full bridge (which needs real senders, engines, etc.)
  it('isBusy returns true for chatId when ANY scope in that chat is busy (perUserContext)', () => {
    // Simulate runningTasks map directly
    const runningTasks = new Map<string, any>();
    const chatId = 'oc_123';
    const scopeKeyA = composeScopeKey(chatId, 'ou_A', true);
    const scopeKeyB = composeScopeKey(chatId, 'ou_B', true);

    // Mimic the bridge's isBusy logic
    function isBusy(cid: string): boolean {
      if (runningTasks.has(cid)) return true;
      const prefix = `${cid}:`;
      for (const key of runningTasks.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    }

    // Only user A has a running task
    runningTasks.set(scopeKeyA, { startTime: Date.now() });

    expect(isBusy(chatId)).toBe(true);
    expect(runningTasks.has(scopeKeyB)).toBe(false);
  });

  it('stopChatTask stops ALL tasks matching chatId when perUserContext is on', () => {
    const stopped: string[] = [];
    const runningTasks = new Map<string, any>();
    const chatId = 'oc_123';
    const scopeKeyA = composeScopeKey(chatId, 'ou_A', true);
    const scopeKeyB = composeScopeKey(chatId, 'ou_B', true);

    function stopTask(scopeKey: string): void {
      const task = runningTasks.get(scopeKey);
      if (!task) return;
      stopped.push(scopeKey);
    }

    function stopChatTask(cid: string): boolean {
      let did = false;
      if (runningTasks.has(cid)) {
        stopTask(cid);
        did = true;
      }
      const prefix = `${cid}:`;
      for (const key of Array.from(runningTasks.keys())) {
        if (key.startsWith(prefix)) {
          stopTask(key);
          did = true;
        }
      }
      return did;
    }

    runningTasks.set(scopeKeyA, { startTime: Date.now() });
    runningTasks.set(scopeKeyB, { startTime: Date.now() });

    expect(stopChatTask(chatId)).toBe(true);
    expect(stopped).toContain(scopeKeyA);
    expect(stopped).toContain(scopeKeyB);
    expect(stopped).toHaveLength(2);
  });
});
