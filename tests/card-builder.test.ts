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
    expect(json.elements.some((e: any) => e.tag === 'markdown' && /thinking/i.test(e.content))).toBe(true);
  });

  it('builds running card with a single-line tool indicator (no per-tool list)', () => {
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
    // Should show one summary line referencing the latest (running) tool +
    // the total tool count, NOT a per-tool list. The earlier completed tool
    // ("Read") must NOT appear — only the current "Edit" plus the count.
    const md = json.elements.find(
      (e: any) => e.tag === 'markdown' && /\*\*Edit\*\* · 2 tools/.test(e.content),
    );
    expect(md).toBeDefined();
    expect(md.content).toContain('⏳');
    expect(md.content).not.toContain('Read');
    expect(md.content).not.toContain('✅');
  });

  it('omits the tool indicator entirely once the turn is complete', () => {
    const state: CardState = {
      status: 'complete',
      userPrompt: 'fix bug',
      responseText: 'Done.',
      toolCalls: [
        { name: 'Read', detail: '`src/index.ts`', status: 'done' },
        { name: 'Edit', detail: '`src/index.ts`', status: 'done' },
      ],
    };
    const json = JSON.parse(buildCard(state));
    const toolEl = json.elements.find(
      (e: any) => e.tag === 'markdown' && (e.content.includes('Read') || e.content.includes('Edit') || /\d+ tools?/.test(e.content)),
    );
    expect(toolEl).toBeUndefined();
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
    // update_multi stays true even though we don't ship action buttons —
    // belt-and-braces in case Feishu ever decides to redeliver clicks.
    expect(json.config.update_multi).toBe(true);
    // Buttons were removed: v2 mobile silently drops `tag: action` blocks,
    // and v1 buttons trigger code 200340 on click. Question cards default
    // to typed answers — numbered options inline + a prompt to reply.
    const actionEl = json.elements.find((e: any) => e.tag === 'action');
    expect(actionEl).toBeUndefined();
    const promptEl = json.elements.find(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('请回复数字'),
    );
    expect(promptEl).toBeDefined();
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

  it('renders a background task section with status icon + last event', () => {
    const state: CardState = {
      status: 'running',
      userPrompt: 'watch ci',
      responseText: 'watching…',
      toolCalls: [],
      backgroundEvents: [
        { taskId: 'bheol4172', description: 'Watching CI for PR #215', status: 'running', lastEvent: 'check (20) running' },
        { taskId: 'bmkr16j6f', description: 'Watching deploy', status: 'completed', lastEvent: 'CI done: success' },
      ],
    };
    const json = JSON.parse(buildCard(state));
    const bg = json.elements.find((e: any) => e.tag === 'markdown' && /Background/.test(e.content));
    expect(bg).toBeDefined();
    expect(bg.content).toContain('⏳');
    expect(bg.content).toContain('✅');
    expect(bg.content).toContain('Watching CI for PR #215');
    expect(bg.content).toContain('check (20) running');
    expect(bg.content).toContain('CI done: success');
    expect(bg.content).toContain('bheol4'); // short task id
  });

  it('omits background section when no events', () => {
    const state: CardState = {
      status: 'running',
      userPrompt: 'x',
      responseText: 'y',
      toolCalls: [],
    };
    const json = JSON.parse(buildCard(state));
    const bg = json.elements.find((e: any) => e.tag === 'markdown' && /Background/.test(e.content));
    expect(bg).toBeUndefined();
  });

  // Regression — keep parity with card-builder-v2: both builders must render
  // these or /goal and Agent Teams become invisible to users.
  it('renders 🎯 Goal badge when goalCondition is set (regression)', () => {
    const state: CardState = {
      status:        'running',
      userPrompt:    't',
      responseText:  '',
      toolCalls:     [],
      goalCondition: 'Ship the PR by Friday',
    };
    const json = JSON.parse(buildCard(state));
    const goal = json.elements.find(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('🎯'),
    );
    expect(goal).toBeDefined();
    expect(goal.content).toContain('Ship the PR by Friday');
  });

  it('renders 🧑‍🤝‍🧑 Team panel when teamState has members or tasks (regression)', () => {
    const state: CardState = {
      status:       'running',
      userPrompt:   't',
      responseText: '',
      toolCalls:    [],
      teamState: {
        name:      'feishu-ux-review',
        teammates: [{ name: 'ux-researcher', status: 'working', lastSubject: 'audit' }],
        tasks:     [{ taskId: 't1', subject: 'UX audit', status: 'in_progress', teammate: 'ux-researcher' }],
      },
    };
    const json = JSON.parse(buildCard(state));
    const team = json.elements.find(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && /Teammates/.test(e.content),
    );
    expect(team).toBeDefined();
    expect(team.content).toContain('feishu-ux-review');
    expect(team.content).toContain('ux-researcher');
    expect(team.content).toContain('UX audit');
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
