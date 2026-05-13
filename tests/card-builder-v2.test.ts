import { describe, it, expect } from 'vitest';
import {
  buildCardV2,
  buildHelpCardV2,
  buildStatusCardV2,
  buildTextCardV2,
} from '../src/feishu/card-builder-v2.js';
import type { CardState } from '../src/types.js';

/**
 * v2 card schema is what users see by default (CARD_SCHEMA_V2 !== 'false').
 * Anything missing here is invisible to every Feishu user — that includes
 * the `goalCondition` badge and `teamState` panel that powers /goal and
 * Agent Teams. Keep these tests strict: a missing render path is a
 * silent product regression, not a style nit.
 */

function findElements(json: any): any[] {
  return json.body?.elements ?? [];
}

describe('buildCardV2', () => {
  it('renders schema 2.0 envelope', () => {
    const state: CardState = {
      status:       'thinking',
      userPrompt:   'hi',
      responseText: '',
      toolCalls:    [],
    };
    const json = JSON.parse(buildCardV2(state));
    expect(json.schema).toBe('2.0');
    expect(json.body).toBeDefined();
    expect(json.header.template).toBe('blue');
  });

  it('renders 🎯 Goal badge when goalCondition is set (regression: must not silently drop)', () => {
    const state: CardState = {
      status:        'running',
      userPrompt:    'task',
      responseText:  'working…',
      toolCalls:     [],
      goalCondition: 'Ship the persistent executor PR by Friday',
    };
    const elements = findElements(JSON.parse(buildCardV2(state)));
    const goal = elements.find(
      (e) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('🎯'),
    );
    expect(goal).toBeDefined();
    expect(goal.content).toContain('Goal:');
    expect(goal.content).toContain('Ship the persistent executor PR');
  });

  it('renders 🧑‍🤝‍🧑 Team panel with teammates and tasks (regression)', () => {
    const state: CardState = {
      status:       'running',
      userPrompt:   'investigate',
      responseText: '',
      toolCalls:    [],
      teamState: {
        name: 'feishu-ux-review',
        teammates: [
          { name: 'ux-researcher',  status: 'working', lastSubject: 'auditing card UX' },
          { name: 'arch-reviewer',  status: 'idle' },
        ],
        tasks: [
          { taskId: 't1', subject: 'UX audit',  status: 'in_progress', teammate: 'ux-researcher' },
          { taskId: 't2', subject: 'Arch review', status: 'completed',  teammate: 'arch-reviewer' },
        ],
      },
    };
    const elements = findElements(JSON.parse(buildCardV2(state)));
    const team = elements.find(
      (e) => e.tag === 'markdown' && typeof e.content === 'string' && /Team/.test(e.content) && /Teammates/.test(e.content),
    );
    expect(team).toBeDefined();
    // Team name
    expect(team.content).toContain('feishu-ux-review');
    // Teammates with both statuses
    expect(team.content).toContain('ux-researcher');
    expect(team.content).toContain('arch-reviewer');
    expect(team.content).toContain('⏳');                  // working icon
    expect(team.content).toContain('💤');                  // idle icon
    expect(team.content).toContain('auditing card UX');     // lastSubject
    // Tasks summary line
    expect(team.content).toContain('1 in progress');
    expect(team.content).toContain('1 done');
    expect(team.content).toContain('UX audit');
    expect(team.content).toContain('Arch review');
  });

  it('omits Team panel when teamState has no teammates and no tasks', () => {
    const state: CardState = {
      status:       'running',
      userPrompt:   'x',
      responseText: '',
      toolCalls:    [],
      teamState:    { teammates: [], tasks: [] },
    };
    const elements = findElements(JSON.parse(buildCardV2(state)));
    const team = elements.find(
      (e) => e.tag === 'markdown' && typeof e.content === 'string' && /Teammates/.test(e.content),
    );
    expect(team).toBeUndefined();
  });

  it('renders tool calls section', () => {
    const state: CardState = {
      status:       'running',
      userPrompt:   'fix bug',
      responseText: '',
      toolCalls: [
        { name: 'Read', detail: '`src/index.ts`', status: 'done' },
        { name: 'Edit', detail: '`src/index.ts`', status: 'running' },
      ],
    };
    const elements = findElements(JSON.parse(buildCardV2(state)));
    const tools = elements.find(
      (e) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('Read'),
    );
    expect(tools).toBeDefined();
    expect(tools.content).toContain('✅');
    expect(tools.content).toContain('⏳');
  });

  it('renders background events with status icon + last event', () => {
    const state: CardState = {
      status:       'running',
      userPrompt:   'watch ci',
      responseText: '',
      toolCalls:    [],
      backgroundEvents: [
        { taskId: 'bheol4172', description: 'Watching CI for PR #255', status: 'running',   lastEvent: 'check (20) running' },
        { taskId: 'bmkr16j6f', description: 'Watching deploy',         status: 'completed', lastEvent: 'CI done: success'   },
      ],
    };
    const elements = findElements(JSON.parse(buildCardV2(state)));
    const bg = elements.find(
      (e) => e.tag === 'markdown' && typeof e.content === 'string' && /Background/.test(e.content),
    );
    expect(bg).toBeDefined();
    expect(bg.content).toContain('Watching CI for PR #255');
    expect(bg.content).toContain('check (20) running');
  });

  it('renders pendingQuestion as buttons with v2 callback behaviors', () => {
    const state: CardState = {
      status:       'waiting_for_input',
      userPrompt:   'deploy',
      responseText: 'Before deploying...',
      toolCalls:    [],
      pendingQuestion: {
        toolUseId: 'q1',
        questions: [{
          question:    'Which env?',
          header:      'Deploy',
          options: [
            { label: 'Production', description: 'Live environment' },
            { label: 'Staging',    description: 'Test environment' },
          ],
          multiSelect: false,
        }],
      },
    };
    const json     = JSON.parse(buildCardV2(state));
    const elements = findElements(json);
    expect(json.header.template).toBe('yellow');
    const action = elements.find((e) => e.tag === 'action');
    expect(action).toBeDefined();
    expect(action.actions).toHaveLength(2);
    // v2 must use behaviors[].value, not top-level value (which is silently dropped)
    expect(action.actions[0].behaviors).toBeDefined();
    expect(action.actions[0].behaviors[0].type).toBe('callback');
    expect(action.actions[0].behaviors[0].value).toEqual({
      action:        'answer_question',
      toolUseId:     'q1',
      questionIndex: 0,
      optionIndex:   0,
    });
  });

  it('shows stats footer with cost/duration/model on complete', () => {
    const state: CardState = {
      status:        'complete',
      userPrompt:    'task',
      responseText:  'done',
      toolCalls:     [],
      durationMs:    5000,
      sessionCostUsd: 0.03,
      model:         'claude-opus-4-7',
      totalTokens:   1500,
      contextWindow: 200000,
    };
    const elements = findElements(JSON.parse(buildCardV2(state)));
    const footer = elements.find((e) => e.tag === 'column_set');
    expect(footer).toBeDefined();
    const inner = JSON.stringify(footer);
    expect(inner).toContain('5.0s');
    expect(inner).toContain('$0.03');
    expect(inner).toContain('opus-4-7');                 // claude- prefix stripped
    expect(inner).toContain('ctx:');
  });

  it('truncates long content', () => {
    const state: CardState = {
      status:       'complete',
      userPrompt:   'task',
      responseText: 'x'.repeat(30000),
      toolCalls:    [],
    };
    const elements = findElements(JSON.parse(buildCardV2(state)));
    const md = elements.find(
      (e) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('truncated'),
    );
    expect(md).toBeDefined();
  });
});

describe('buildHelpCardV2', () => {
  it('returns valid v2 card with header', () => {
    const json = JSON.parse(buildHelpCardV2());
    expect(json.schema).toBe('2.0');
    expect(json.header.title.content).toContain('Help');
    expect(json.body.elements.length).toBeGreaterThan(0);
  });
});

describe('buildStatusCardV2', () => {
  it('shows session info', () => {
    const json = JSON.parse(buildStatusCardV2('user123', '/home/user/project', 'sess-abc-12345678', true));
    const md = json.body.elements[0].content;
    expect(md).toContain('user123');
    expect(md).toContain('/home/user/project');
    expect(md).toContain('sess-abc');
    expect(md).toContain('Yes');
  });
});

describe('buildTextCardV2', () => {
  it('builds simple text card', () => {
    const json = JSON.parse(buildTextCardV2('Title', 'Some content', 'green'));
    expect(json.schema).toBe('2.0');
    expect(json.header.template).toBe('green');
    expect(json.header.title.content).toBe('Title');
    expect(json.body.elements[0].content).toBe('Some content');
  });
});
