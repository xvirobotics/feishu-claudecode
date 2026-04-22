# 多 Bot 模式

在单个 MetaBot 进程中运行多个飞书和 Telegram Bot。

## 配置

在 `.env` 中设置 `BOTS_CONFIG=./bots.json` 启用多 Bot 模式：

```json
{
  "feishuBots": [
    {
      "name": "metabot",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/user/project-a"
    },
    {
      "name": "backend-bot",
      "feishuAppId": "cli_yyy",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/user/project-b"
    }
  ],
  "telegramBots": [
    {
      "name": "tg-bot",
      "telegramBotToken": "123456:ABC...",
      "defaultWorkingDirectory": "/home/user/project-c"
    }
  ]
}
```

## Bot 配置字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | — | Bot 标识名 |
| `defaultWorkingDirectory` | 是 | — | Agent 工作目录 |
| `engine` | 否 | `"claude"` | Agent 引擎 — `"claude"` 或 `"kimi"` |
| `feishuAppId` / `feishuAppSecret` | 飞书 | — | 飞书应用凭证 |
| `telegramBotToken` | Telegram | — | Telegram Bot Token |
| `maxTurns` | 否 | 不限 | 每次请求最大轮次 |
| `maxBudgetUsd` | 否 | 不限 | 每次请求费用上限（仅 Claude — Kimi 走订阅） |
| `model` | 否 | SDK 默认 | 默认模型 ID（引擎相关） |
| `allowedTools` | 否 | `Read,Edit,Write,Glob,Grep,Bash` | 工具白名单（仅 Claude） |
| `outputsBaseDir` | 否 | `/tmp/metabot-outputs` | 输出文件目录 |
| `kimi` | 否 | — | Kimi 专用配置（仅当 `engine: "kimi"` 时） — 见下方 |

### Kimi 引擎选项

当 `engine: "kimi"` 时，`kimi` 对象用于配置 Kimi CLI 行为：

```json
{
  "name": "coding-bot",
  "engine": "kimi",
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "...",
  "defaultWorkingDirectory": "/home/user/project",
  "kimi": {
    "model": "kimi-for-coding",
    "thinking": true
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `kimi.model` | `kimi-for-coding` | Kimi 模型 ID |
| `kimi.thinking` | `false` | 启用思考模式（展示推理过程） |
| `kimi.executable` | (自动) | 覆盖 `kimi` CLI 二进制路径 |

Kimi 需要先执行一次 `kimi login`（安装 `uv tool install kimi-cli` 后，在另外的终端运行）。授权与 Kimi CLI 共享 — 无需 API Key。

## 工作原理

- 每个 Bot 拥有独立的飞书/Telegram 连接
- 会话按 `chatId` 隔离 — Bot 之间无冲突
- 每个 Bot 使用各自的工作目录和配置
- 环境变量作为 JSON 中未指定字段的默认值

设置 `BOTS_CONFIG` 后，`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量被忽略。

## Peers 配置

也可以在 `bots.json` 中配置 [Peers](../features/peers.md)：

```json
{
  "feishuBots": [{ "..." }],
  "peers": [
    {
      "name": "alice",
      "url": "http://localhost:9200",
      "secret": "alice-api-secret"
    }
  ]
}
```

## 单 Bot 模式

不设 `BOTS_CONFIG` 时，MetaBot 使用环境变量运行单个 Bot：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=...
DEFAULT_WORKING_DIRECTORY=/home/user/project
```
