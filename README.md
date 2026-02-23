# MetaBot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=social)](https://github.com/xvirobotics/metabot)

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

**MetaBot is an operating system for AI agent companies.** It gives every agent a Claude Code brain, persistent memory, the ability to create new agents, and a communication bus — all accessible from a chat message on your phone.

One command. One process. From zero to an agent-native organization.

> *"一生二，二生三，三生万物"* — One creates two, two creates three, three creates everything.

### The Big Picture

```
┌─────────────────────────────────────────────────────────┐
│                      MetaBot                            │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
│  │ MetaSkill│  │MetaMemory│  │ IM Bridge│  │Scheduler│  │
│  │ Agent    │  │ Knowledge│  │ Feishu + │  │ Delayed  │  │
│  │ Factory  │  │ Store    │  │ Telegram │  │ Tasks    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘  │
│       └──────────────┴─────────────┴─────────────┘       │
│                        ↕                                 │
│             Claude Code Agent SDK                        │
│          (bypassPermissions, streaming)                  │
│                        ↕                                 │
│              HTTP API (:9100) — agent bus                │
│         task delegation · bot CRUD · scheduling          │
└─────────────────────────────────────────────────────────┘
```

### Core Components

| Component | What it does |
|-----------|-------------|
| **Claude Code Kernel** | Every bot is a full Claude Code instance — read, write, execute, search, browse the web. Runs in `bypassPermissions` mode for autonomous operation. |
| **MetaSkill** | The meta-skill: `/metaskill ios app` generates a complete `.claude/` agent team (tech-lead, specialists, reviewer). Can also create individual agents or custom skills. |
| **MetaMemory** | Embedded SQLite knowledge store with full-text search and Web UI. Agents read and write Markdown documents across sessions. No Python dependency — runs inside the MetaBot process on port 8100. |
| **IM Bridge** | Chat with any agent from Feishu or Telegram (including mobile). Real-time streaming cards show what the agent is doing. |
| **HTTP API & Agent Bus** | REST API on port 9100. Agents delegate tasks to each other via `curl`. Create/remove bots at runtime. Schedule tasks for the future. |
| **Task Scheduler** | Agents can schedule future work — "check back in 2 hours". Persists across restarts, auto-retries on busy. |

### What You Can Build

- **A solo AI developer** — one bot bound to your project, full Claude Code from your phone
- **A multi-agent team** — frontend bot, backend bot, infra bot, each with their own workspace, talking to each other via the API
- **A self-growing organization** — a manager bot that creates new agent bots on demand, assigns them tasks, and schedules follow-ups
- **An autonomous research pipeline** — agents that search, analyze, save findings to MetaMemory, and schedule next steps

### One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

The installer walks you through: working directory → Claude auth → IM platform credentials → auto-start with PM2. Re-running on an existing install does `git pull` and preserves your config.

### Quick Start (Manual)

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot
npm install
cp bots.example.json bots.json   # edit with your bot configs
cp .env.example .env              # edit global settings
npm run dev                       # start in dev mode
```

### How MetaSkill Works

MetaSkill is an agent factory. It researches best practices, then generates a complete `.claude/` directory:

```
/metaskill ios app
```

→ Researches iOS agent team patterns, SwiftUI best practices, relevant MCP servers
→ Creates a project folder with:
  - `CLAUDE.md` — orchestration hub with agent routing table
  - `.claude/agents/` — tech-lead (Opus) + specialists (Sonnet) + code-reviewer
  - `.claude/skills/` — workflow automation skills
  - `.claude/rules/` — coding standards
  - `.mcp.json` — MCP server configuration

Also works for single agents (`/metaskill a security reviewer`) and single skills (`/metaskill a deploy skill`).

### How MetaMemory Works

MetaMemory is an embedded knowledge store. Agents autonomously save and retrieve knowledge across sessions.

```bash
# Agents use curl to read/write (via the metamemory skill)
curl -s -H "Authorization: Bearer $MEMORY_SECRET" localhost:8100/api/search?q=project+architecture
curl -s -X POST localhost:8100/api/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MEMORY_SECRET" \
  -d '{"title":"Sprint Review","content":"# Findings...","tags":["review"]}'
```

- **SQLite + FTS5** — full-text search with ranked results
- **Web UI** — browse at `http://localhost:8100?token=YOUR_SECRET` (token saved to localStorage)
- **Bearer auth** — `MEMORY_SECRET` (defaults to `API_SECRET` if not set separately)
- **Zero dependencies** — embedded in MetaBot, no Python/FastAPI needed
- **Chat commands** — `/memory list`, `/memory search <query>`, `/memory status`

### How Agent Communication Works

Agents talk to each other through the HTTP API. Claude knows about these APIs (injected into the system prompt) and uses `curl` autonomously:

```bash
# Bot A delegates a task to Bot B (synchronous)
curl -X POST localhost:9100/api/tasks \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"run the migration"}'

# Bot A schedules a follow-up check in 1 hour
curl -X POST localhost:9100/api/schedule \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"verify migration","delaySeconds":3600}'

# Bot A creates a brand new bot at runtime
curl -X POST localhost:9100/api/bots \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"telegram","name":"data-bot","telegramBotToken":"...","defaultWorkingDirectory":"/home/user/data","installSkills":true}'
```

Communication is currently **one-directional** (requester → target). Full bidirectional agent protocols are on the roadmap.

### Configuration

**`bots.json`** — defines one or more bots:

```json
{
  "feishuBots": [
    {
      "name": "metabot",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/user/project"
    }
  ],
  "telegramBots": [
    {
      "name": "tg-bot",
      "telegramBotToken": "123456:ABC...",
      "defaultWorkingDirectory": "/home/user/project"
    }
  ]
}
```

**Bot config fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Bot identifier |
| `feishuAppId` / `feishuAppSecret` | Feishu | — | Feishu app credentials |
| `telegramBotToken` | Telegram | — | Telegram bot token |
| `defaultWorkingDirectory` | Yes | — | Working directory for this bot |
| `authorizedUserIds` | No | allow all | Access control |
| `allowedTools` | No | Read,Edit,Write,Glob,Grep,Bash | Claude tools whitelist |
| `maxTurns` / `maxBudgetUsd` | No | unlimited | Execution limits |
| `model` | No | SDK default | Claude model |

**`.env`** — global settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `BOTS_CONFIG` | — | Path to `bots.json` |
| `API_PORT` | 9100 | HTTP API port |
| `API_SECRET` | — | Bearer token auth (if set, listens on 0.0.0.0) |
| `MEMORY_SERVER_URL` | http://localhost:8100 | MetaMemory URL |
| `MEMORY_ENABLED` | true | Enable embedded MetaMemory server |
| `MEMORY_PORT` | 8100 | MetaMemory port |
| `MEMORY_DATABASE_DIR` | ./data | SQLite database directory |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory Bearer auth (defaults to `API_SECRET`) |
| `LOG_LEVEL` | info | Log level |

### Third-Party AI Providers

MetaBot supports any Anthropic-compatible API:

```bash
# Kimi / Moonshot
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=your-key

# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=your-key
ANTHROPIC_MODEL=deepseek-chat

# GLM / Zhipu
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your-key
ANTHROPIC_MODEL=glm-4.5

# Any Anthropic-compatible endpoint
ANTHROPIC_BASE_URL=https://your-provider.com/anthropic
ANTHROPIC_AUTH_TOKEN=your-key
```

### IM Bot Setup

**Feishu/Lark:**
1. Create app at [open.feishu.cn](https://open.feishu.cn/) → add Bot capability
2. Enable permissions: `im:message`, `im:message:readonly`, `im:resource`
3. Start MetaBot first, then enable "persistent connection" event mode + `im.message.receive_v1`
4. Publish the app

**Telegram:**
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Add to `bots.json` — that's it. No webhooks needed (long polling).

### Chat Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session, start fresh |
| `/stop` | Abort current task |
| `/status` | Show session info |
| `/memory list` | Show folder tree |
| `/memory search <query>` | Search knowledge base |
| `/help` | Show help |
| `/metaskill ...` | Trigger MetaSkill (passed to Claude Code) |
| `/anything` | Any unrecognized `/command` is forwarded to Claude Code as a skill trigger |

### Production Deployment

```bash
pm2 start ecosystem.config.cjs   # start with PM2
pm2 logs metabot                  # view logs
pm2 startup && pm2 save           # auto-start on reboot
```

### HTTP API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service health |
| `GET` | `/api/bots` | List bots |
| `POST` | `/api/bots` | Create bot (writes bots.json, PM2 restarts) |
| `GET` | `/api/bots/:name` | Bot details |
| `DELETE` | `/api/bots/:name` | Remove bot |
| `POST` | `/api/tasks` | Submit task to a bot (sync) |
| `POST` | `/api/schedule` | Schedule a future task |
| `GET` | `/api/schedule` | List scheduled tasks |
| `PATCH` | `/api/schedule/:id` | Update scheduled task |
| `DELETE` | `/api/schedule/:id` | Cancel scheduled task |

### Security

MetaBot runs Claude Code in **`bypassPermissions` mode** — no interactive approval. Understand what this means:

- Claude has full read/write/execute access to the working directory
- Use `allowedTools` to restrict capabilities (remove `Bash` for read-only)
- Use `maxBudgetUsd` to cap per-request cost
- Use `authorizedUserIds` to restrict access
- **Never point a bot at directories with sensitive data without access controls**
- `API_SECRET` enables Bearer token auth on both the API server and MetaMemory
- **MetaMemory Web UI** — access with `?token=SECRET` in URL (token is saved to browser)

### Prerequisites

- **Node.js 18+**
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code` + `claude login`)
- A Feishu app and/or Telegram bot token

---

<a id="中文"></a>

## 中文

**MetaBot 是 AI Agent 公司的操作系统。** 每个 Agent 都有 Claude Code 大脑、持久化记忆、创建新 Agent 的能力、以及通信总线 — 全部可以从手机聊天窗口控制。

一条命令。一个进程。从零构建一个 Agent Native 组织。

> *"一生二，二生三，三生万物"*

### 全景图

```
┌─────────────────────────────────────────────────────────┐
│                      MetaBot                            │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
│  │ MetaSkill│  │MetaMemory│  │ IM Bridge│  │ 定时任务 │  │
│  │ Agent    │  │ 知识库    │  │  飞书 +  │  │  调度器  │  │
│  │ 工厂     │  │          │  │ Telegram │  │         │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘  │
│       └──────────────┴─────────────┴─────────────┘       │
│                        ↕                                 │
│             Claude Code Agent SDK                        │
│        （bypassPermissions，流式输出）                     │
│                        ↕                                 │
│             HTTP API (:9100) — Agent 总线                │
│          任务委派 · Bot 管理 · 定时调度                    │
└─────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 功能 |
|------|------|
| **Claude Code 内核** | 每个 Bot 都是完整的 Claude Code 实例 — 读写文件、执行命令、搜索代码、浏览网页。以 `bypassPermissions` 模式运行。 |
| **MetaSkill** | Agent 工厂：`/metaskill ios app` 生成完整的 `.claude/` Agent 团队（tech-lead + 专家 + reviewer）。也可以创建单个 Agent 或自定义 Skill。 |
| **MetaMemory** | 内嵌 SQLite 知识库，全文搜索，Web UI。Agent 跨会话读写 Markdown 文档。无 Python 依赖，随 MetaBot 进程运行在 8100 端口。 |
| **IM Bridge** | 从飞书或 Telegram 聊天（含手机端）与任意 Agent 对话。实时流式卡片展示 Agent 正在做什么。 |
| **HTTP API & Agent 总线** | 9100 端口 REST API。Agent 通过 `curl` 互相委派任务。运行时创建/删除 Bot。定时任务调度。 |
| **定时任务调度器** | Agent 可以安排未来的工作 —— "2小时后检查一下"。跨重启持久化，忙时自动重试。 |

### 你可以构建什么

- **个人 AI 开发者** — 一个 Bot 绑定你的项目，手机上用飞书/Telegram 远程写代码
- **多 Agent 团队** — 前端 Bot、后端 Bot、运维 Bot，各自独立工作空间，通过 API 互相协作
- **自生长的组织** — 管理者 Bot 按需创建新 Agent Bot，分配任务，安排后续跟进
- **自主研究流水线** — Agent 搜索、分析、将发现存入 MetaMemory、安排下一步

### 一条命令安装

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

安装器引导：工作目录 → Claude 认证 → IM 平台凭证 → PM2 自动启动。重复运行会 `git pull` 更新，保留现有配置。

### 手动安装

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot
npm install
cp bots.example.json bots.json   # 编辑 Bot 配置
cp .env.example .env              # 编辑全局设置
npm run dev
```

### MetaSkill — Agent 工厂

MetaSkill 是一个 Agent 工厂。它先调研最佳实践，然后生成完整的 `.claude/` 目录：

```
/metaskill ios app
```

→ 调研 iOS Agent 团队模式、SwiftUI 最佳实践、相关 MCP 服务器
→ 创建项目目录，包含：
  - `CLAUDE.md` — 编排中枢，含 Agent 路由表
  - `.claude/agents/` — tech-lead (Opus) + 专家 (Sonnet) + code-reviewer
  - `.claude/skills/` — 工作流自动化技能
  - `.claude/rules/` — 编码规范
  - `.mcp.json` — MCP 服务器配置

也支持单个 Agent（`/metaskill 一个安全审计 agent`）和单个 Skill（`/metaskill 一个部署技能`）。

### MetaMemory — 共享知识库

MetaMemory 是内嵌的知识存储。Agent 跨会话自主保存和检索知识。

- **SQLite + FTS5** — 全文搜索，排名返回
- **Web UI** — 浏览器打开 `http://localhost:8100?token=你的密钥` 查看文档（token 自动存入浏览器）
- **Bearer 认证** — `MEMORY_SECRET`（未设置时自动复用 `API_SECRET`）
- **零依赖** — 内嵌在 MetaBot 中，不需要 Python
- **聊天命令** — `/memory list`、`/memory search 关键词`、`/memory status`

### Agent 间通信

Agent 通过 HTTP API 互相通信。Claude 知道这些 API（注入了系统提示词），自主使用 `curl`：

```bash
# Bot A 委派任务给 Bot B（同步）
curl -X POST localhost:9100/api/tasks \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"跑一下迁移脚本"}'

# Bot A 安排 1 小时后的跟进检查
curl -X POST localhost:9100/api/schedule \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"检查迁移结果","delaySeconds":3600}'

# Bot A 运行时创建新 Bot
curl -X POST localhost:9100/api/bots \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"telegram","name":"data-bot","telegramBotToken":"...","defaultWorkingDirectory":"/home/user/data","installSkills":true}'
```

通信目前是**单向的**（发起方 → 目标方）。双向 Agent 协议在规划中。

### 配置

**`bots.json`** — 定义一个或多个 Bot：

```json
{
  "feishuBots": [
    {
      "name": "metabot",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "...",
      "defaultWorkingDirectory": "/home/user/project"
    }
  ],
  "telegramBots": [
    {
      "name": "tg-bot",
      "telegramBotToken": "123456:ABC...",
      "defaultWorkingDirectory": "/home/user/project"
    }
  ]
}
```

**Bot 配置字段：**

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | — | Bot 标识名 |
| `feishuAppId` / `feishuAppSecret` | 飞书 | — | 飞书应用凭证 |
| `telegramBotToken` | Telegram | — | Telegram Bot Token |
| `defaultWorkingDirectory` | 是 | — | 工作目录 |
| `authorizedUserIds` | 否 | 不限 | 访问控制 |
| `allowedTools` | 否 | Read,Edit,Write,Glob,Grep,Bash | Claude 可用工具 |
| `maxTurns` / `maxBudgetUsd` | 否 | 不限 | 执行限制 |
| `model` | 否 | SDK 默认 | Claude 模型 |

**`.env`** — 全局设置：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTS_CONFIG` | — | bots.json 路径 |
| `API_PORT` | 9100 | HTTP API 端口 |
| `API_SECRET` | — | Bearer 认证（设置后监听 0.0.0.0） |
| `MEMORY_ENABLED` | true | 启用内嵌 MetaMemory |
| `MEMORY_PORT` | 8100 | MetaMemory 端口 |
| `MEMORY_DATABASE_DIR` | ./data | SQLite 数据库目录 |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory 认证（默认复用 `API_SECRET`） |
| `LOG_LEVEL` | info | 日志级别 |

### 第三方 AI 服务商

支持 Kimi/Moonshot、DeepSeek、GLM/智谱、或任何 Anthropic 兼容 API：

```bash
# Kimi / 月之暗面
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=你的key

# DeepSeek / 深度求索
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=你的key
ANTHROPIC_MODEL=deepseek-chat

# GLM / 智谱
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=你的key
ANTHROPIC_MODEL=glm-4.5
```

### IM 机器人配置

**飞书：**
1. [open.feishu.cn](https://open.feishu.cn/) 创建应用 → 添加「机器人」能力
2. 开通权限：`im:message`、`im:message:readonly`、`im:resource`
3. 先启动 MetaBot，再开启「长连接」事件订阅 + `im.message.receive_v1`
4. 发布应用

**Telegram：**
1. 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 复制 token
2. 写入 `bots.json` 即可。无需 Webhook（长轮询模式）。

### 聊天命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除会话 |
| `/stop` | 中止当前任务 |
| `/status` | 查看会话状态 |
| `/memory list` | 文件夹树 |
| `/memory search 关键词` | 搜索知识库 |
| `/help` | 帮助 |
| `/metaskill ...` | 触发 MetaSkill（透传给 Claude Code） |
| `/任意命令` | 非内置命令自动转发给 Claude Code，触发对应 Skill |

### 生产部署

```bash
pm2 start ecosystem.config.cjs   # PM2 启动
pm2 logs metabot                  # 查看日志
pm2 startup && pm2 save           # 开机自启
```

### 安全说明

MetaBot 以 **`bypassPermissions` 模式** 运行 Claude Code — 无交互式确认：

- Claude 对工作目录有完整读写执行权限
- 用 `allowedTools` 限制工具（去掉 `Bash` = 只读模式）
- 用 `maxBudgetUsd` 限制单次花费
- 用 `authorizedUserIds` 限制访问者
- **不要将 Bot 指向含敏感数据的目录**
- `API_SECRET` 同时保护 API 服务器和 MetaMemory
- **MetaMemory Web UI** — URL 带 `?token=密钥` 访问（token 自动存入浏览器）

### 前置条件

- **Node.js 18+**
- **Claude Code CLI** 已安装并认证（`npm install -g @anthropic-ai/claude-code` + `claude login`）
- 飞书应用 和/或 Telegram Bot Token

### FAQ

**Q: 需要公网 IP 吗？**
不需要。飞书用 WebSocket，Telegram 用长轮询。

**Q: 可以用国产大模型吗？**
可以。支持 Kimi、DeepSeek、GLM 等任何 Anthropic 兼容 API。

**Q: Agent 间通信是实时的吗？**
目前是同步请求-响应模式（`POST /api/tasks`）。异步双向通信在规划中。

---

## License

[MIT](LICENSE)
