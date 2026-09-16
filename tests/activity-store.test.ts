import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityStore } from '../src/api/activity-store.js';

const logger = {
  child: () => logger,
  info: () => {},
} as any;

function createStore(): ActivityStore {
  process.env.SESSION_STORE_DIR = mkdtempSync(join(tmpdir(), 'metabot-activity-'));
  return new ActivityStore(logger);
}

function recordOne(store: ActivityStore): void {
  store.record({
    type: 'task_started',
    botName: 'bot',
    chatId: 'chat',
    prompt: 'hello',
    responsePreview: 'world',
    timestamp: Date.now(),
  });
}

describe('ActivityStore content storage', () => {
  afterEach(() => {
    delete process.env.METABOT_ACTIVITY_INCLUDE_CONTENT;
    delete process.env.SESSION_STORE_DIR;
  });

  it('persists prompt and response preview by default', () => {
    const store = createStore();
    recordOne(store);

    const [row] = store.list({ limit: 1 });
    expect(row.prompt).toBe('hello');
    expect(row.responsePreview).toBe('world');
    store.close();
  });

  it('stores no content when METABOT_ACTIVITY_INCLUDE_CONTENT=false', () => {
    process.env.METABOT_ACTIVITY_INCLUDE_CONTENT = 'false';
    const store = createStore();
    recordOne(store);

    const [row] = store.list({ limit: 1 });
    expect(row.prompt).toBeUndefined();
    expect(row.responsePreview).toBeUndefined();
    // Non-content fields keep working.
    expect(row.botName).toBe('bot');
    expect(row.chatId).toBe('chat');
    store.close();
  });
});
