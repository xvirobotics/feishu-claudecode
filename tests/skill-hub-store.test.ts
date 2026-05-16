import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillHubStore } from '../src/api/skill-hub-store.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => createLogger() } as any;
}

const SAMPLE_SKILL = `---
name: test-skill
description: "A test skill for unit testing"
tags: test, demo
user-invocable: true
context: fork
allowed-tools: Read, Bash
---

# Test Skill

This is a test skill.
`;

describe('SkillHubStore', () => {
  let store: SkillHubStore;
  let tmpDir: string;

  function createStore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hub-test-'));
    store = new SkillHubStore(tmpDir, createLogger());
    return store;
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('publishes and retrieves a skill', () => {
    createStore();
    const record = store.publish({
      name: 'test-skill',
      skillMd: SAMPLE_SKILL,
      author: 'test-bot',
      ownerInstanceId: 'alice',
      ownerInstanceName: 'Alice MetaBot',
    });
    expect(record.name).toBe('test-skill');
    expect(record.description).toBe('A test skill for unit testing');
    expect(record.version).toBe(1);
    expect(record.author).toBe('test-bot');
    expect(record.ownerInstanceId).toBe('alice');
    expect(record.ownerInstanceName).toBe('Alice MetaBot');
    expect(record.visibility).toBe('published');
    expect(record.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.tags).toEqual(['test', 'demo']);

    const retrieved = store.get('test-skill');
    expect(retrieved).toBeDefined();
    expect(retrieved!.skillMd).toBe(SAMPLE_SKILL);
    expect(retrieved!.contentHash).toBe(record.contentHash);
  });

  it('bumps version on re-publish', () => {
    createStore();
    store.publish({ name: 'test-skill', skillMd: SAMPLE_SKILL, author: 'bot-a' });
    const v2 = store.publish({ name: 'test-skill', skillMd: SAMPLE_SKILL, author: 'bot-b' });
    expect(v2.version).toBe(2);
    expect(v2.author).toBe('bot-b');
  });

  it('lists all skills', () => {
    createStore();
    store.publish({ name: 'skill-a', skillMd: '---\nname: skill-a\n---\nA', author: 'bot' });
    store.publish({ name: 'skill-b', skillMd: '---\nname: skill-b\n---\nB', author: 'bot' });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b']);
  });

  it('searches skills by keyword', () => {
    createStore();
    store.publish({ name: 'calendar-tool', skillMd: '---\nname: calendar-tool\ndescription: Manage calendars\n---\n# Calendar', author: 'bot' });
    store.publish({ name: 'data-viz', skillMd: '---\nname: data-viz\ndescription: Data visualization\n---\n# Charts', author: 'bot' });
    const results = store.search('calendar');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('calendar-tool');
  });

  it('removes a skill', () => {
    createStore();
    store.publish({ name: 'to-remove', skillMd: '---\nname: to-remove\n---\nX', author: 'bot' });
    expect(store.get('to-remove')).toBeDefined();
    const removed = store.remove('to-remove');
    expect(removed).toBe(true);
    expect(store.get('to-remove')).toBeUndefined();
  });

  it('returns false when removing non-existent skill', () => {
    createStore();
    expect(store.remove('nonexistent')).toBe(false);
  });

  it('handles skill without frontmatter', () => {
    createStore();
    const record = store.publish({ name: 'bare-skill', skillMd: '# Just markdown\nNo frontmatter here.', author: 'test' });
    expect(record.name).toBe('bare-skill');
    expect(record.description).toBe('');
    expect(record.tags).toEqual([]);
  });

  it('getContent returns skillMd and referencesTar', () => {
    createStore();
    const tar = Buffer.from('fake-tar-data');
    store.publish({ name: 'with-refs', skillMd: '---\nname: with-refs\n---\n# Refs', referencesTar: tar, author: 'bot' });
    const content = store.getContent('with-refs');
    expect(content).toBeDefined();
    expect(content!.skillMd).toContain('with-refs');
    expect(content!.referencesTar).toEqual(tar);
  });

  it('stores visibility and content hashes in summaries and search results', () => {
    createStore();
    store.publish({
      name: 'shared-skill',
      skillMd: '---\nname: shared-skill\ndescription: Shared skill\n---\n# Shared',
      referencesTar: Buffer.from('refs'),
      author: 'bot',
      ownerInstanceId: 'instance-a',
      ownerInstanceName: 'Instance A',
      visibility: 'shared',
    });

    const listed = store.list()[0];
    expect(listed.ownerInstanceId).toBe('instance-a');
    expect(listed.ownerInstanceName).toBe('Instance A');
    expect(listed.visibility).toBe('shared');
    expect(listed.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const searched = store.search('Shared')[0];
    expect(searched.ownerInstanceId).toBe('instance-a');
    expect(searched.visibility).toBe('shared');
    expect(searched.contentHash).toBe(listed.contentHash);
  });
});
