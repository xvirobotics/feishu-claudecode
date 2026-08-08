# Multi-Bot Mode

Run multiple Feishu/Lark, Telegram, Slack, and WeChat bots in one MetaBot Bridge.
Each bot has its own channel credentials, engine, workspace, sessions, and
per-group reply settings.

## Setup

Set `BOTS_CONFIG=./bots.json` in `.env`:

```json
{
  "feishuBots": [
    {
      "name": "codex-dev",
      "engine": "codex",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/me/project-a",
      "codex": {
        "reasoningEffort": "high"
      }
    },
    {
      "name": "kimi-reviewer",
      "engine": "kimi",
      "feishuAppId": "cli_yyy",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/me/project-b",
      "kimi": {
        "thinking": true
      }
    }
  ],
  "telegramBots": [
    {
      "name": "personal-codex",
      "engine": "codex",
      "telegramBotToken": "123456:ABC...",
      "defaultWorkingDirectory": "/home/me/personal"
    }
  ],
  "slackBots": [
    {
      "name": "slack-codex",
      "engine": "codex",
      "slackBotToken": "xoxb-...",
      "slackSigningSecret": "...",
      "defaultWorkingDirectory": "/home/me/slack-workspace"
    }
  ]
}
```

## Shared Bot Fields

| Field                       | Required | Default                  | Description                                                 |
| --------------------------- | -------- | ------------------------ | ----------------------------------------------------------- |
| `name`                      | Yes      | —                        | Stable bot identifier                                       |
| `defaultWorkingDirectory`   | Yes      | —                        | Workspace available to the agent                            |
| `engine`                    | No       | `"codex"`                | `"codex"`, `"kimi"`, or compatibility `"claude"`            |
| `model`                     | No       | Engine default           | Session model override                                      |
| `visible`                   | No       | `true`                   | Register the bot for Agent Bus discovery                    |
| `memoryPublic`              | No       | sticky/default policy    | Pin the bot's default memory visibility when explicitly set |
| `maxTurns` / `maxBudgetUsd` | No       | unlimited                | Claude compatibility limits                                 |
| `outputsBaseDir`            | No       | temporary user directory | Files automatically returned to chat                        |

Channel-specific credentials:

| Channel     | Fields                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------- |
| Feishu/Lark | `feishuAppId`, `feishuAppSecret`, optional `groupNoMention`                                 |
| Telegram    | `telegramBotToken`                                                                          |
| WeChat      | optional `wechatBotToken`; omit it for QR login                                             |
| Slack       | `slackBotToken`, `slackSigningSecret`, optional `slackBotUserId`, optional `groupNoMention` |

## Codex Options

```json
{
  "engine": "codex",
  "codex": {
    "model": "gpt-5.6-sol",
    "profile": "personal",
    "reasoningEffort": "high",
    "approvalPolicy": "never",
    "sandbox": "workspace-write"
  }
}
```

Common fields are `model`, `profile`, `apiKey`, `baseUrl`, `reasoningEffort`,
`approvalPolicy`, `sandbox`, `executable`, `extraArgs`, and `env`. Normal
subscription use only needs `codex login`.

The public adapter currently runs `codex exec --json` and resumes with
`codex exec resume`. Codex app-server and native mid-turn steering are not part
of the current public behavior.

## Kimi Code Options {#kimi-code-options}

```json
{
  "engine": "kimi",
  "kimi": {
    "model": "kimi-code/k3",
    "thinking": true,
    "permissionMode": "auto",
    "serverUrl": "http://127.0.0.1:58627"
  }
}
```

| Field                 | Default                  | Description                                                               |
| --------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `kimi.model`          | Kimi Code config default | Model ID or configured short alias                                        |
| `kimi.thinking`       | Kimi Code config default | Thinking override                                                         |
| `kimi.permissionMode` | `auto`                   | Tool permission policy; `yolo` requires explicit trusted-workspace opt-in |
| `kimi.executable`     | `kimi` from `PATH`       | Kimi Code executable                                                      |
| `kimi.serverUrl`      | `http://127.0.0.1:58627` | Existing loopback Server origin; otherwise started on demand              |
| `kimi.contextWindow`  | current Kimi default     | Display/context override                                                  |

Kimi requires Kimi Code 0.27+:

```bash
npm install -g @moonshot-ai/kimi-code@latest
kimi login
```

MetaBot uses the official local Server API shared with Kimi's web frontend.
It provides durable Sessions, live snapshots, questions, cancellation, usage,
tools, subagents, and goals. Feishu mid-turn steering is not exposed in this
release. The legacy Python `kimi-cli --wire --work-dir` protocol is not used.

`permissionMode` defaults to `auto`. `yolo` is available only as an explicit
opt-in for a workspace you trust; the personal edition never enables it by default.

## Claude Code Compatibility

Existing bots can set `"engine": "claude"` and continue using Claude login,
Anthropic-compatible providers, `.claude/skills/`, and `CLAUDE.md`. New
personal-edition bots default to Codex when `engine` is omitted.

## Runtime Behavior

- Each bot owns an independent channel connection and workspace.
- Sessions are isolated per bot and `chatId`.
- A chat can switch engine/model with `/model`; this does not rename the bot.
- Feishu reply modes persist per bot and group.
- Agent Teams and the Agent Bus can coordinate bots running different engines.
- Environment variables provide defaults; explicit `bots.json` fields win.

When `BOTS_CONFIG` is set, single-bot channel environment variables are ignored.

## Single-Bot Mode

Without `BOTS_CONFIG`, configure one bot through environment variables:

```bash
METABOT_ENGINE=codex
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

For Slack single-bot mode:

```bash
METABOT_ENGINE=codex
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

`CLAUDE_DEFAULT_WORKING_DIRECTORY` keeps its historical name but supplies the
workspace for every engine.

See [Environment Variables](environment-variables.md) for the full list.
