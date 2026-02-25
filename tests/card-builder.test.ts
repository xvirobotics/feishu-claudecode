import { describe, it, expect } from 'vitest';
import { buildCard, buildHelpCard, buildStatusCard, buildTextCard } from '../src/feishu/card-builder.js';
import type { CardState } from '../src/types.js';

describe('buildCard', () => {
  it('builds thinking card', () => {
    const state: CardState = {
      status: 'thinking',
      userPrompt: 'hello',
      responseText: '',
      toolCalls: [],
    };
    const json = JSON.parse(buildCard(state));
    expect(json.header.template).toBe('blue');
    expect(json.header.title.content).toContain('Thinking');
    expect(json.elements.some((e: any) => e.tag === 'markdown' && e.content.includes('thinking'))).toBe(true);
  });

  it('builds running card with tool calls', () => {
    const state: CardState = {
      status: 'running',
      userPrompt: 'fix bug',
      responseText: 'Looking at the code...',
      toolCalls: [
        { name: 'Read', detail: '`src/index.ts`', status: 'done' },
        { name: 'Edit', detail: '`src/index.ts`', status: 'running' },
      ],
    };
    const json = JSON.parse(buildCard(state));
    expect(json.header.template).toBe('blue');
    const md = json.elements.find((e: any) => e.tag === 'markdown' && e.content.includes('Read'));
    expect(md).toBeDefined();
    expect(md.content).toContain('✅');
    expect(md.content).toContain('⏳');
  });

  it('builds complete card with stats', () => {
    const state: CardState = {
      status: 'complete',
      userPrompt: 'task',
      responseText: 'All done!',
      toolCalls: [],
      durationMs: 5000,
      costUsd: 0.03,
    };
    const json = JSON.parse(buildCard(state));
    expect(json.header.template).toBe('green');
    const note = json.elements.find((e: any) => e.tag === 'note');
    expect(note).toBeDefined();
    expect(note.elements[0].content).toContain('5.0s');
  });

  it('builds error card with error message', () => {
    const state: CardState = {
      status: 'error',
      userPrompt: 'task',
      responseText: '',
      toolCalls: [],
      errorMessage: 'Process crashed',
    };
    const json = JSON.parse(buildCard(state));
    expect(json.header.template).toBe('red');
    const errEl = json.elements.find((e: any) => e.tag === 'markdown' && e.content.includes('Process crashed'));
    expect(errEl).toBeDefined();
  });

  it('builds waiting_for_input card with question', () => {
    const state: CardState = {
      status: 'waiting_for_input',
      userPrompt: 'deploy',
      responseText: 'Before deploying...',
      toolCalls: [],
      pendingQuestion: {
        toolUseId: 'q1',
        questions: [{
          question: 'Which env?',
          header: 'Deploy',
          options: [
            { label: 'Production', description: 'Live environment' },
            { label: 'Staging', description: 'Test environment' },
          ],
          multiSelect: false,
        }],
      },
    };
    const json = JSON.parse(buildCard(state));
    expect(json.header.template).toBe('yellow');
    const qEl = json.elements.find((e: any) => e.tag === 'markdown' && e.content.includes('Which env?'));
    expect(qEl).toBeDefined();
    expect(qEl.content).toContain('Production');
    expect(qEl.content).toContain('Staging');
  });

  it('truncates long content', () => {
    const state: CardState = {
      status: 'complete',
      userPrompt: 'task',
      responseText: 'x'.repeat(30000),
      toolCalls: [],
    };
    const json = JSON.parse(buildCard(state));
    const md = json.elements.find((e: any) => e.tag === 'markdown' && e.content.includes('truncated'));
    expect(md).toBeDefined();
  });
});

describe('buildHelpCard', () => {
  it('returns valid card JSON', () => {
    const json = JSON.parse(buildHelpCard());
    expect(json.header.title.content).toContain('Help');
    expect(json.elements.length).toBeGreaterThan(0);
  });
});

describe('buildStatusCard', () => {
  it('shows session info', () => {
    const json = JSON.parse(buildStatusCard('user123', '/home/user/project', 'sess-abc-12345678', true));
    const md = json.elements[0].content;
    expect(md).toContain('user123');
    expect(md).toContain('/home/user/project');
    expect(md).toContain('sess-abc');
    expect(md).toContain('Yes');
  });

  it('shows no session', () => {
    const json = JSON.parse(buildStatusCard('user', '/home', undefined, false));
    const md = json.elements[0].content;
    expect(md).toContain('None');
    expect(md).toContain('No');
  });
});

describe('buildTextCard', () => {
  it('builds simple text card', () => {
    const json = JSON.parse(buildTextCard('Title', 'Some content', 'green'));
    expect(json.header.template).toBe('green');
    expect(json.header.title.content).toBe('Title');
    expect(json.elements[0].content).toBe('Some content');
  });
});
