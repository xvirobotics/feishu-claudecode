import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig, type SlackBotConfig } from '../src/config.js';
import { isSlackEventsRoute, slackEventToIncomingMessage, verifySlackSignature } from '../src/slack/slack-bot.js';

const signingSecret = 'slack-signing-secret';

function signature(rawBody: string, timestamp: string): string {
  return `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

function slackConfig(overrides: Partial<SlackBotConfig> = {}): SlackBotConfig {
  return {
    name: 'slack-codex',
    slack: {
      botToken: 'xoxb-test',
      signingSecret,
      botUserId: 'U999',
    },
    claude: {
      defaultWorkingDirectory: '/workspace',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: 'claude-fable-5',
      apiKey: undefined,
      outputsBaseDir: '/tmp/out',
      downloadsDir: '/tmp/down',
      backend: 'pty',
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Slack Events API support', () => {
  it('recognizes the public Slack event route without treating other API routes as Slack', () => {
    expect(isSlackEventsRoute('POST', '/api/slack/events/slack-codex')).toBe(true);
    expect(isSlackEventsRoute('POST', '/api/slack/events?bot=slack-codex')).toBe(true);
    expect(isSlackEventsRoute('GET', '/api/slack/events/slack-codex')).toBe(false);
    expect(isSlackEventsRoute('POST', '/api/talk')).toBe(false);
  });

  it('verifies Slack request signatures and rejects stale or mismatched bodies', () => {
    const raw = JSON.stringify({ type: 'event_callback' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signature(raw, timestamp);

    expect(verifySlackSignature(signingSecret, raw, timestamp, sig)).toBe(true);
    expect(verifySlackSignature(signingSecret, `${raw}\n`, timestamp, sig)).toBe(false);
    expect(verifySlackSignature(signingSecret, raw, '100', sig)).toBe(false);
  });

  it('routes Slack DM text into the shared IncomingMessage shape', () => {
    const msg = slackEventToIncomingMessage(
      {
        type: 'message',
        channel_type: 'im',
        channel: 'D123',
        user: 'U123',
        text: 'fix install',
        ts: '1800000000.123',
        client_msg_id: 'client-1',
      },
      slackConfig(),
    );

    expect(msg).toMatchObject({
      messageId: 'client-1',
      chatId: 'D123',
      chatType: 'im',
      userId: 'U123',
      text: 'fix install',
    });
  });

  it('routes channel app mentions and strips the bot mention', () => {
    const msg = slackEventToIncomingMessage(
      {
        type: 'app_mention',
        channel_type: 'channel',
        channel: 'C123',
        user: 'U123',
        text: '<@U999> please summarize',
        ts: '1800000000.123',
      },
      slackConfig(),
    );

    expect(msg).toMatchObject({
      chatId: 'C123',
      chatType: 'channel',
      text: 'please summarize',
    });
  });

  it('ignores unmentioned channel messages by default but allows explicit all-message mode', () => {
    const event = {
      type: 'message',
      channel_type: 'channel',
      channel: 'C123',
      user: 'U123',
      text: 'ambient chatter',
      ts: '1800000000.123',
    };

    expect(slackEventToIncomingMessage(event, slackConfig())).toBeUndefined();
    expect(slackEventToIncomingMessage(event, slackConfig({ groupNoMention: true }))).toMatchObject({
      text: 'ambient chatter',
    });
  });

  it('maps Slack image/file events for the existing media download path', () => {
    const image = slackEventToIncomingMessage(
      {
        type: 'message',
        channel_type: 'im',
        channel: 'D123',
        user: 'U123',
        text: '',
        files: [
          { name: 'photo.png', mimetype: 'image/png', url_private_download: 'https://files.slack.test/photo.png' },
        ],
        ts: '1800000000.123',
      },
      slackConfig(),
    );
    expect(image).toMatchObject({
      text: '请分析这张图片',
      imageKey: 'https://files.slack.test/photo.png',
      fileName: 'photo.png',
    });

    const file = slackEventToIncomingMessage(
      {
        type: 'message',
        channel_type: 'im',
        channel: 'D123',
        user: 'U123',
        text: '',
        files: [{ name: 'notes.txt', mimetype: 'text/plain', id: 'F123' }],
        ts: '1800000000.123',
      },
      slackConfig(),
    );
    expect(file).toMatchObject({
      text: '请分析这个文件',
      fileKey: 'F123',
      fileName: 'notes.txt',
    });
  });

  it('loads slackBots from bots.json with engine and workspace settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-slack-config-'));
    const configPath = path.join(dir, 'bots.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        slackBots: [
          {
            name: 'slack-codex',
            engine: 'codex',
            slackBotToken: 'xoxb-test',
            slackSigningSecret: signingSecret,
            slackBotUserId: 'U999',
            defaultWorkingDirectory: '.',
            codex: { approvalPolicy: 'never', sandbox: 'workspace-write' },
          },
        ],
      }),
    );
    vi.stubEnv('BOTS_CONFIG', configPath);

    const cfg = loadAppConfig();

    expect(cfg.slackBots).toHaveLength(1);
    expect(cfg.slackBots[0].name).toBe('slack-codex');
    expect(cfg.slackBots[0].slack.botUserId).toBe('U999');
    expect(path.isAbsolute(cfg.slackBots[0].claude.defaultWorkingDirectory)).toBe(true);
    expect(cfg.feishuBots).toHaveLength(0);
  });
});
