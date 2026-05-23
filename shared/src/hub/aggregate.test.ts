import { describe, it, expect } from 'vitest';
import {
  HUB_HIDDEN_FIELDS,
  botToHubBot,
  buildHubHost,
  hubAccessAllowListUnion,
} from './aggregate.js';
import type { HubBotInput, HubProcInfo } from './types.js';

describe('botToHubBot', () => {
  it('marks status=stopped when no proc info', () => {
    const out = botToHubBot({ name: 'sa', hubVisible: true }, null, 0);
    expect(out.status).toBe('stopped');
    expect(out.uptimeMs).toBeUndefined();
    expect(out.sessions).toBe(0);
    expect(out.hiddenFields).toEqual([...HUB_HIDDEN_FIELDS]);
  });

  it('translates errored → error and converts bytes to MB', () => {
    const proc: HubProcInfo = { name: 'sa', status: 'errored', memoryBytes: 100 * 1024 * 1024 };
    const out = botToHubBot({ name: 'sa', hubVisible: true }, proc, 3);
    expect(out.status).toBe('error');
    expect(out.memMb).toBe(100);
    expect(out.sessions).toBe(3);
  });

  it('strips trailing slashes off publicBaseUrl', () => {
    const out = botToHubBot(
      { name: 'sa', hubVisible: true, publicBaseUrl: 'https://x.example.com///' },
      null,
      0,
    );
    expect(out.transcriptBaseUrl).toBe('https://x.example.com');
  });
});

describe('buildHubHost', () => {
  const baseInput = {
    hostId:           'machine-a',
    hostName:         'Machine-A',
    agentVersion:     'metabot 1.0.0',
    osDescription:    'Linux 5.4.0',
    lastSeen:         '2026-05-23T12:00:00.000Z',
    sessionCountByBot: {},
  };

  it('skips hubVisible=false bots and counts them in hiddenBotCount', () => {
    const feishuBots: HubBotInput[] = [
      { name: 'visible1', hubVisible: true },
      { name: 'hidden1' },
      { name: 'hidden2', hubVisible: false },
      { name: 'visible2', hubVisible: true },
    ];
    const procs: HubProcInfo[] = [
      { name: 'visible1', status: 'online' },
      { name: 'visible2', status: 'stopped' },
    ];
    const host = buildHubHost({
      ...baseInput,
      feishuBots,
      procs,
      sessionCountByBot: { visible1: 5, visible2: 0 },
    });
    expect(host.visibleBots.map((b) => b.name)).toEqual(['visible1', 'visible2']);
    expect(host.hiddenBotCount).toBe(2);
    expect(host.online).toBe(true);
    expect(host.hostId).toBe('machine-a');
    expect(host.visibleBots[0].sessions).toBe(5);
  });

  it('returns hiddenBotCount=0 when every bot is visible', () => {
    const host = buildHubHost({
      ...baseInput,
      feishuBots: [{ name: 'a', hubVisible: true }, { name: 'b', hubVisible: true }],
      procs:      [],
      sessionCountByBot: {},
    });
    expect(host.hiddenBotCount).toBe(0);
    expect(host.visibleBots).toHaveLength(2);
  });

  it('never leaks env / feishuAppSecret values onto the visible bot view', () => {
    // Cast through unknown so a HubBotInput can carry the secret fields the
    // aggregator is supposed to drop on the floor.
    const dirtyBot = {
      name:            'a',
      hubVisible:      true,
      feishuAppSecret: 'super-secret-value',
      env:             { ANTHROPIC_API_KEY: 'sk-leak-me' },
    } as unknown as HubBotInput;
    const host = buildHubHost({
      ...baseInput,
      feishuBots: [dirtyBot],
      procs:      [],
      sessionCountByBot: {},
    });
    const visibleBot = host.visibleBots[0];
    expect(Object.keys(visibleBot)).not.toContain('feishuAppSecret');
    expect(Object.keys(visibleBot)).not.toContain('env');
    const serialised = JSON.stringify(visibleBot);
    expect(serialised).not.toMatch(/super-secret-value/);
    expect(serialised).not.toMatch(/sk-leak-me/);
    expect(visibleBot.hiddenFields).toEqual(['feishuAppSecret', 'env']);
  });
});

describe('hubAccessAllowListUnion', () => {
  it('unions accessAllowOpenIds only across hubVisible bots', () => {
    const feishuBots: HubBotInput[] = [
      { name: 'a', hubVisible: true,  accessAllowOpenIds: ['ou_1', 'ou_2'] },
      { name: 'b', hubVisible: true,  accessAllowOpenIds: ['ou_2', 'ou_3'] },
      { name: 'c', hubVisible: false, accessAllowOpenIds: ['ou_999'] },
      { name: 'd', hubVisible: true },
    ];
    const out = hubAccessAllowListUnion(feishuBots);
    expect(out.sort()).toEqual(['ou_1', 'ou_2', 'ou_3']);
  });

  it('returns empty array when no hubVisible bot has an allowlist', () => {
    const out = hubAccessAllowListUnion([
      { name: 'a', hubVisible: true },
      { name: 'b', hubVisible: false, accessAllowOpenIds: ['ou_x'] },
    ]);
    expect(out).toEqual([]);
  });
});
