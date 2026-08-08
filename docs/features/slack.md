# Slack

MetaBot can receive Slack DM and mention events through Slack Events API, then
reply through Slack Web API using the same Bridge pipeline as other channels.

## Slack app setup

1. Create a Slack app for your workspace.
2. Add bot token scopes:
   - `chat:write`
   - `files:read`
   - `files:write`
   - `app_mentions:read`
   - `im:history`
   - `channels:history` or the private-channel equivalents you need
3. Install the app and copy the bot token (`xoxb-...`).
4. Copy the app Signing Secret.
5. In Event Subscriptions, set the Request URL to:

   ```text
   https://<your-bridge-host>/api/slack/events/<botName>
   ```

6. Subscribe to bot events:
   - `app_mention`
   - `message.im`
   - `message.channels` / `message.groups` only if you want channel mention routing

## bots.json

```json
{
  "slackBots": [
    {
      "name": "codex-slack",
      "engine": "codex",
      "slackBotToken": "xoxb-...",
      "slackSigningSecret": "...",
      "defaultWorkingDirectory": "/home/me/project"
    }
  ]
}
```

Optional fields:

- `slackBotUserId`: bot user ID (`U...`). If omitted, MetaBot tries Slack
  `auth.test` at startup.
- `groupNoMention`: when `true`, route all channel messages to the bot. The
  safer default is mention-only.

## Single-bot environment mode

```bash
METABOT_ENGINE=codex
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

Set `SLACK_BOT_USER_ID=U...` when startup cannot call Slack `auth.test`.

## Security notes

Slack event delivery is public HTTP, so the Bridge verifies
`X-Slack-Signature` and rejects stale timestamps. Keep `API_HOST` on loopback
unless your Bridge is behind your own HTTPS reverse proxy; expose only the
Slack event path you intentionally route.
