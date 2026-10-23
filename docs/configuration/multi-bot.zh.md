# 多 Bot 模式

在一个 MetaBot Bridge 中运行多个飞书/Lark、Telegram、Slack 和微信 Bot。每个 Bot
拥有独立的渠道凭证、引擎、工作区、会话和群回复设置。

## 配置

在 `.env` 中设置 `BOTS_CONFIG=./bots.json`：

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

## 通用 Bot 字段

| 字段                        | 必填 | 默认值        | 说明                                      |
| --------------------------- | ---- | ------------- | ----------------------------------------- |
| `name`                      | 是   | —             | 稳定的 Bot 标识                           |
| `defaultWorkingDirectory`   | 是   | —             | Agent 可访问的工作区                      |
| `engine`                    | 否   | `"codex"`     | `"codex"`、`"kimi"` 或兼容引擎 `"claude"` |
| `model`                     | 否   | 引擎默认      | Session 模型覆盖                          |
| `visible`                   | 否   | `true`        | 是否注册到 Agent Bus 供发现               |
| `memoryPublic`              | 否   | 粘性/默认策略 | 显式设置时固定 Bot 的默认 Memory 可见性   |
| `maxTurns` / `maxBudgetUsd` | 否   | 不限制        | Claude 兼容限制                           |
| `outputsBaseDir`            | 否   | 用户临时目录  | 自动回传到聊天的文件目录                  |

渠道凭证字段：

| 渠道      | 字段                                                                           |
| --------- | ------------------------------------------------------------------------------ |
| 飞书/Lark | `feishuAppId`、`feishuAppSecret`，可选 `groupNoMention`                        |
| Telegram  | `telegramBotToken`                                                             |
| 微信      | 可选 `wechatBotToken`；省略时扫码登录                                          |
| Slack     | `slackBotToken`、`slackSigningSecret`，可选 `slackBotUserId`、`groupNoMention` |

## Codex 配置

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

常用字段包括 `model`、`profile`、`apiKey`、`baseUrl`、
`reasoningEffort`、`approvalPolicy`、`sandbox`、`executable`、`extraArgs`
和 `env`。普通订阅场景只需执行 `codex login`。

默认仍使用 `codex exec --json` 和 `codex exec resume`。设置
`codex.transport: "app-server"` 并重启 MetaBot 后，可启用原生执行中插话，
沿用已配置的模型、profile、环境变量、沙箱和审批策略。

任务运行时发送 `/append 补充要求`（同义命令 `/steer`）；飞书群仅 @ 模式下
需要 @机器人。成功提示表示 Codex 已接收，指示会在可处理的执行节点生效，
不能撤销已完成的操作。普通消息仍排队；空闲、启动中、已结束或请求失败时
会明确提示，不会偷偷另起任务或排队。

该可选传输支持文字回复、命令事件、token 用量和阻塞式用户提问。
交互式命令/文件审批请求会被拒绝，其他尚未支持的服务端请求返回明确错误，
不会扩大已配置的权限。需要支持
[app-server turn/steer](https://developers.openai.com/codex/app-server/) 的 Codex CLI，
已使用 `0.163.0-alpha.11.1` 做真实集成验证。

## Kimi Code 配置 {#kimi-code-options}

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

| 字段                  | 默认值                   | 说明                                        |
| --------------------- | ------------------------ | ------------------------------------------- |
| `kimi.model`          | Kimi Code 配置默认       | 模型 ID 或已配置的短别名                    |
| `kimi.thinking`       | Kimi Code 配置默认       | Thinking 覆盖                               |
| `kimi.permissionMode` | `auto`                   | 工具权限策略；`yolo` 仅限可信工作区显式启用 |
| `kimi.executable`     | `PATH` 中的 `kimi`       | Kimi Code 可执行文件                        |
| `kimi.serverUrl`      | `http://127.0.0.1:58627` | 已有 loopback Server 地址；否则按需启动     |
| `kimi.contextWindow`  | 当前 Kimi 默认           | 展示/上下文覆盖                             |

Kimi 需要 Kimi Code 0.27+：

```bash
npm install -g @moonshot-ai/kimi-code@latest
kimi login
```

MetaBot 使用与 Kimi Web 前端同源的官方本地 Server API，支持持久 Session、
原子快照、问题交互、停止、用量、工具、子 Agent 和 Goal。本版本暂不开放
飞书执行中 steering，也不再使用旧 Python `kimi-cli --wire --work-dir` 协议。

`permissionMode` 默认是 `auto`。只有在完全可信的工作区中才应显式选择
`yolo`；个人版不会默认开启该模式。

## Claude Code 兼容

现有 Bot 可以设置 `"engine": "claude"`，继续使用 Claude 登录、Anthropic
兼容 Provider、`.claude/skills/` 和 `CLAUDE.md`。个人版新 Bot 省略
`engine` 时默认为 Codex。

## 运行行为

- 每个 Bot 拥有独立渠道连接和工作区。
- 会话按 Bot 和 `chatId` 隔离。
- Chat 可以使用 `/model` 切换引擎/模型，不会改变 Bot 身份。
- 飞书群回复模式按 Bot 和群持久化。
- Agent Teams 和 Agent Bus 可以协调不同引擎的 Bot。
- 环境变量提供默认值；显式 `bots.json` 字段优先。

设置 `BOTS_CONFIG` 后，单 Bot 的渠道环境变量会被忽略。

## 单 Bot 模式

未设置 `BOTS_CONFIG` 时，通过环境变量配置一个 Bot：

```bash
METABOT_ENGINE=codex
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

Slack 单 Bot 模式：

```bash
METABOT_ENGINE=codex
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

`CLAUDE_DEFAULT_WORKING_DIRECTORY` 保留了历史名称，但会为所有引擎提供工作区。

完整列表见[环境变量](environment-variables.md)。

### Claude Code 插话

默认的持久 PTY 后端同样支持 `/append 内容` 和 `/steer 内容`。消息送入运行中的 Claude Code 输入框，不中断当前任务；Claude 会在可处理输入的工具执行边界读取。普通消息仍排队。权限选择、问答或输入框暂不可用时会提示未接收。旧 SDK 后端或关闭持久执行器时不支持。
