import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';

const logger = {
  child: () => logger,
  info: () => {},
} as any;

describe('AgentTeamStore', () => {
  it('stores team agents, tasks, messages, and runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const team = store.createTeam('demo', 'Demo team');
    expect(team).toMatchObject({ name: 'demo', description: 'Demo team', status: 'active' });

    const agent = store.createAgent('demo', {
      name: 'reviewer',
      role: 'review',
      engine: 'codex',
      prompt: 'Review changes',
    });
    expect(agent).toMatchObject({ teamName: 'demo', name: 'reviewer', status: 'idle', engine: 'codex' });
    expect(store.deleteAgent('demo', 'missing')).toBe(false);

    const task = store.createTask('demo', {
      subject: 'Review CLI',
      description: 'Check command shape',
      owner: 'reviewer',
    });
    expect(task).toMatchObject({ id: 1, subject: 'Review CLI', status: 'pending', owner: 'reviewer' });

    const updated = store.updateTask('demo', 1, { status: 'completed', result: 'Looks good' });
    expect(updated).toMatchObject({ status: 'completed', result: 'Looks good' });

    const message = store.sendMessage('demo', {
      fromName: 'lead',
      toName: 'reviewer',
      summary: 'review task',
      body: 'Please review task 1',
    });
    expect(message).toMatchObject({ fromName: 'lead', toName: 'reviewer', body: 'Please review task 1' });
    expect(store.listMessages('demo', 'reviewer', true)).toHaveLength(1);
    expect(store.markMessagesRead('demo', 'reviewer')).toBe(1);
    expect(store.listMessages('demo', 'reviewer', true)).toHaveLength(0);

    const run = store.createRun('demo', { agentName: 'reviewer', taskId: 1 });
    expect(run).toMatchObject({ teamName: 'demo', agentName: 'reviewer', taskId: 1, status: 'running' });
    expect(store.getRunningRun('demo', 'reviewer')).toMatchObject({ id: run.id, status: 'running' });
    expect(store.updateRun('demo', run.id, { status: 'completed', output: 'done' })).toMatchObject({ output: 'done' });
    expect(store.getRunningRun('demo', 'reviewer')).toBeUndefined();

    const status = store.status('demo');
    expect(status?.agents).toHaveLength(1);
    expect(status?.tasks).toHaveLength(1);
    expect(status?.runs).toHaveLength(1);
    expect(store.deleteAgent('demo', 'reviewer')).toBe(true);
    expect(store.listAgents('demo')).toHaveLength(0);

    store.close();
  });

  it('marks only selected message ids read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.createTeam('demo', 'Demo team');

    const first = store.sendMessage('demo', { fromName: 'lead', toName: 'reviewer', body: 'Task #1' });
    const second = store.sendMessage('demo', { fromName: 'lead', toName: 'reviewer', body: 'Task #2' });
    store.sendMessage('demo', { fromName: 'lead', toName: 'other', body: 'Other task' });

    expect(store.markMessagesReadById('demo', 'reviewer', [first.id])).toBe(1);
    expect(store.listMessages('demo', 'reviewer', true).map((message) => message.id)).toEqual([second.id]);
    expect(store.listMessages('demo', 'other', true)).toHaveLength(1);

    store.close();
  });

  it('allows lead as a normal member name for nested teams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('demo', 'Demo team');
    expect(store.createAgent('demo', { name: 'lead', engine: 'codex' })).toMatchObject({ name: 'lead', status: 'idle' });
    store.reconcileTeams([{
      name: 'demo',
      agents: [
        { name: 'lead', role: 'lead', engine: 'codex' },
        { name: 'worker', role: 'worker', engine: 'codex' },
      ],
    }]);

    expect(store.getAgent('demo', 'lead')).toMatchObject({ name: 'lead', role: 'lead' });
    expect(store.listAgents('demo').map((agent) => agent.name)).toEqual(['lead', 'worker']);
    expect(store.status('demo')?.agents.map((agent) => agent.name)).toEqual(['lead', 'worker']);

    store.close();
  });

  it('does not stop manual teams when bots.json resident teams are removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('manual-team', 'Created by CLI', {
      displayChatIds: ['oc_manual'],
    });
    store.reconcileTeams([{
      name: 'resident-team',
      description: 'From bots.json',
      displayChatIds: ['oc_resident'],
      agents: [{ name: 'lead', engine: 'codex' }],
    }]);

    expect(store.getTeam('manual-team')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident-team')).toMatchObject({ status: 'active', managedByConfig: true });
    expect(store.listAgents('resident-team').map((agent) => agent.name)).toEqual(['lead']);

    store.reconcileTeams([]);

    expect(store.getTeam('manual-team')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident-team')).toMatchObject({ status: 'stopped', managedByConfig: true });
    expect(store.findTeamForChat('oc_manual')).toMatchObject({ name: 'manual-team' });
    expect(store.findTeamForChat('oc_resident')).toBeUndefined();
    store.close();
  });

  it('reconciles configured teams and resolves chat display bindings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.reconcileTeams([{
      name: 'metabot-dev',
      description: 'Runtime team',
      chatIds: ['team:metabot-dev:runtime-engineer'],
      displayChatIds: ['oc_chat_123'],
      agents: [
        { name: 'lead', role: 'lead', engine: 'codex' },
        { name: 'runtime-engineer', role: 'runtime', engine: 'codex', prompt: 'Own runtime' },
      ],
      tasks: [
        { id: 5, subject: 'Implement supervisor', owner: 'runtime-engineer' },
      ],
    }]);

    expect(store.getTeam('metabot-dev')).toMatchObject({
      name: 'metabot-dev',
      chatIds: ['team:metabot-dev:runtime-engineer'],
      displayChatIds: ['oc_chat_123'],
      managedByConfig: true,
    });
    expect(store.getAgent('metabot-dev', 'runtime-engineer')).toMatchObject({ role: 'runtime', engine: 'codex' });
    expect(store.getAgent('metabot-dev', 'lead')).toMatchObject({ role: 'lead', engine: 'codex' });
    expect(store.getTask('metabot-dev', 5)).toMatchObject({ subject: 'Implement supervisor', owner: 'runtime-engineer' });
    expect(store.findTeamForChat('oc_chat_123')).toMatchObject({ name: 'metabot-dev' });
    expect(store.findTeamForChat('team:metabot-dev:runtime-engineer')).toMatchObject({ name: 'metabot-dev' });
    expect(store.findTeamForChat('oc_other')).toBeUndefined();

    store.reconcileTeams([{
      name: 'metabot-dev',
      description: 'Runtime team',
      displayChatIds: ['oc_chat_456'],
      agents: [
        { name: 'lead', role: 'lead', engine: 'codex' },
      ],
    }]);

    expect(store.getAgent('metabot-dev', 'runtime-engineer')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('oc_chat_123')).toBeUndefined();
    expect(store.findTeamForChat('oc_chat_456')).toMatchObject({ name: 'metabot-dev' });

    store.reconcileTeams([]);
    expect(store.getTeam('metabot-dev')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('oc_chat_456')).toBeUndefined();
    store.close();
  });

  it('preserves manual teams when resident config is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('manual', 'Manual team', { displayChatIds: ['manual-chat'] });
    store.reconcileTeams([{
      name: 'resident',
      displayChatIds: ['resident-chat'],
      agents: [{ name: 'worker', engine: 'codex' }],
    }]);

    expect(store.getTeam('manual')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident')).toMatchObject({ status: 'active', managedByConfig: true });

    store.reconcileTeams([]);
    expect(store.getTeam('manual')).toMatchObject({ status: 'active' });
    expect(store.findTeamForChat('manual-chat')).toMatchObject({ name: 'manual' });
    expect(store.getTeam('resident')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('resident-chat')).toBeUndefined();

    store.close();
  });
});

describe('AgentTeamStore shutdown safety', () => {
  it('returns empty/undefined from read accessors after close instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-closed-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.createTeam('demo', 'Demo team');
    store.setTeamChatBindings('demo', { chatIds: ['oc_chat'] });

    store.close();
    expect(store.isClosed()).toBe(true);
    // These used to throw "The database connection is not open" when a turn
    // finalized its card during shutdown.
    expect(store.listTeams()).toEqual([]);
    expect(store.getTeam('demo')).toBeUndefined();
    expect(store.findTeamForChat('oc_chat')).toBeUndefined();
    expect(store.status('demo')).toBeUndefined();
  });

  it('close() is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-close2-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
