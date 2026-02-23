# MetaBot

[![CI](https://github.com/xvirobotics/metabot/actions/workflows/ci.yml/badge.svg)](https://github.com/xvirobotics/metabot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=social)](https://github.com/xvirobotics/metabot)

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

MetaBot — A bridge service connecting IM bots (Feishu/Lark, Telegram) to Claude Code Agent SDK. Chat with Claude Code from any device (including mobile), with real-time streaming updates. One command to install, one bot to rule them all.

> *"一生二，二生三，三生万物"* — The Genesis Bot can create more bots from chat. MetaBot lives up to its "meta" name.

### One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

The installer interactively walks you through:
- Platform selection (Feishu, Telegram, or both)
- IM bot credentials
- Claude AI authentication (subscription, Anthropic API key, or third-party providers like Kimi/DeepSeek/GLM)
- Working directory, API secret, MetaMemory setup
- Automatic PM2 deployment

Re-running the installer on an existing install does `git pull` and preserves your `.env` / `bots.json`.

### Features

- **One-command install** - `curl | bash` gets you from zero to running in minutes
- **Multi-platform** - Supports both Feishu/Lark and Telegram, run them side by side in a single process
- **Self-replication** - Genesis Bot creates new bots from chat via `POST /api/bots` — PM2 auto-restarts to activate
- **Third-party AI providers** - Use Kimi/Moonshot, DeepSeek, GLM/Zhipu, or any Anthropic-compatible API
- **Remote access** - Use Claude Code from any device, including mobile
- **Streaming updates** - Real-time execution progress via message updates (Feishu interactive cards / Telegram editMessageText)
- **Multi-bot support** - Run multiple bots in one process, each bound to a different project directory
- **Multi-user parallel** - Independent sessions per chat (each group/DM has its own session)
- **Multi-turn conversations** - Automatic context persistence across messages
- **Image support** - Send images to Claude for analysis; Claude-generated images are sent back
- **File output** - Claude-produced files (PDFs, docs, archives) are automatically sent to chat
- **MCP integration** - Automatically loads MCP server configs from Claude Code settings
- **Status cards** - Color-coded status, tool call tracking, cost/duration stats
- **HTTP API** - Inter-bot task delegation via REST API; Claude calls other bots with `curl`
- **Bot CRUD API** - Create, inspect, and remove bots at runtime via REST
- **Task Scheduler** - Schedule future tasks ("check back in 2 hours") with persistence and auto-retry
- **MetaMemory** - Shared knowledge base with full-text search, Web UI, and Claude autonomous read/write

### Prerequisites

- **Node.js 18+**
- **Claude Code CLI** - `npm install -g @anthropic-ai/claude-code`
- **Claude AI authentication** - one of:
  - Claude Pro/Max subscription: `claude login`
  - Anthropic API key: `ANTHROPIC_API_KEY=sk-ant-...`
  - Third-party provider (see [Third-Party Providers](#third-party-providers))
- **Feishu Open Platform account** and/or **Telegram Bot Token** (from [@BotFather](https://t.me/BotFather))

### Third-Party Providers

MetaBot supports any Anthropic-compatible API. Set these environment variables in `.env`:

**Kimi / Moonshot**
```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=your-moonshot-api-key
```

**DeepSeek**
```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=your-deepseek-api-key
ANTHROPIC_MODEL=deepseek-chat
ANTHROPIC_SMALL_FAST_MODEL=deepseek-chat
API_TIMEOUT_MS=600000
```

**GLM / Zhipu**
```bash
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your-zhipu-api-key
ANTHROPIC_MODEL=glm-4.5
```

**Custom provider** — any API that implements the Anthropic messages endpoint:
```bash
ANTHROPIC_BASE_URL=https://your-provider.com/anthropic
ANTHROPIC_AUTH_TOKEN=your-api-key
ANTHROPIC_MODEL=model-name          # optional
ANTHROPIC_SMALL_FAST_MODEL=model    # optional
```

> **Note:** `ANTHROPIC_AUTH_TOKEN` (sent as Bearer token) and `ANTHROPIC_API_KEY` (sent as `x-api-key` header) are mutually exclusive. Most third-party providers use `ANTHROPIC_AUTH_TOKEN`.

The `install.sh` installer will prompt you to choose a provider and configure these automatically.

### Feishu Bot Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn/) and create an enterprise app
2. Go to **App Capabilities** → Add **Bot**
3. Go to **Permissions** and enable:
   - `im:message` - Send and receive messages
   - `im:message:readonly` - Read messages
   - `im:resource` - Upload images and files (required for sending output files back to chat)
4. **Start the service first** (`npm run dev` or `pm2 start ecosystem.config.cjs`), then configure events:
   - Go to **Events & Callbacks** → **Event Configuration**
   - Select **"Use persistent connection to receive events"** (WebSocket mode, no public IP needed)
   - Feishu validates the WebSocket connection on save, so the service must be running
   - Add event: `im.message.receive_v1`
5. Publish the app version and get approval

### Telegram Bot Setup

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts to set a name and username
3. Copy the **bot token** (e.g. `123456:ABC-DEF...`)
4. Add it to `.env` as `TELEGRAM_BOT_TOKEN` or to `bots.json` (see below)

No webhooks needed. MetaBot uses **long polling**, so no public IP is required.

### Quick Start

**Option A: One-command installer (recommended)**

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

**Option B: Manual setup**

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot
npm install
cp bots.example.json bots.json   # edit with your bot configs
cp .env.example .env              # edit global settings
npm run dev                       # start in dev mode
```

### Configuration

**`bots.json`** — defines bots for one or both platforms (see `bots.example.json`):

```json
{
  "feishuBots": [
    { "name": "genesis", "feishuAppId": "cli_xxx", "feishuAppSecret": "...", "defaultWorkingDirectory": "/home/user/project" }
  ],
  "telegramBots": [
    { "name": "tg-bot", "telegramBotToken": "123456:ABC...", "defaultWorkingDirectory": "/home/user/project" }
  ]
}
```

> **Backward compatible:** If `bots.json` is a plain array (old format), all entries are treated as Feishu bots.

**Bot config fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | - | Bot identifier (used in logs) |
| `feishuAppId` / `feishuAppSecret` | For Feishu | - | Feishu App credentials |
| `telegramBotToken` | For Telegram | - | Telegram bot token |
| `defaultWorkingDirectory` | Yes | - | Fixed working directory for this bot |
| `authorizedUserIds` | No | (allow all) | Array of user IDs |
| `authorizedChatIds` | No | (allow all) | Array of chat IDs |
| `allowedTools` | No | Read,Edit,Write,Glob,Grep,Bash | Allowed Claude tools |
| `maxTurns` | No | unlimited | Max conversation turns per query |
| `maxBudgetUsd` | No | unlimited | Max cost per query (USD) |
| `model` | No | SDK default | Claude model |

**`.env`** — global settings:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOTS_CONFIG` | No | - | Path to `bots.json`. If unset, falls back to single-bot env vars |
| `API_PORT` | No | 9100 | HTTP API server port |
| `API_SECRET` | No | - | If set, listens on 0.0.0.0 with Bearer token auth; if empty, localhost only |
| `MEMORY_SERVER_URL` | No | http://localhost:8100 | MetaMemory server URL |
| `LOG_LEVEL` | No | info | Log level |
| `ANTHROPIC_API_KEY` | No | - | Anthropic API key (alternative to OAuth login) |
| `ANTHROPIC_BASE_URL` | No | - | Third-party API base URL |
| `ANTHROPIC_AUTH_TOKEN` | No | - | Third-party API key (Bearer token) |

<details>
<summary>Single-bot mode (env var config)</summary>

If `BOTS_CONFIG` is not set, bots are configured from env vars. You can run Feishu, Telegram, or both:

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_APP_ID` | For Feishu | Feishu App ID |
| `FEISHU_APP_SECRET` | For Feishu | Feishu App Secret |
| `TELEGRAM_BOT_TOKEN` | For Telegram | Telegram bot token from BotFather |
| `CLAUDE_DEFAULT_WORKING_DIRECTORY` | Yes | Working directory |
| `AUTHORIZED_USER_IDS` | No | Feishu user open_ids (comma-separated) |
| `TELEGRAM_AUTHORIZED_USER_IDS` | No | Telegram user IDs (comma-separated) |
| `CLAUDE_ALLOWED_TOOLS` | No | Comma-separated tools |
| `CLAUDE_MAX_TURNS` | No | Max turns (unlimited if unset) |
| `CLAUDE_MAX_BUDGET_USD` | No | Max budget (unlimited if unset) |
| `CLAUDE_MODEL` | No | Claude model |

</details>

### Usage

```bash
# Development (hot reload)
npm run dev

# Production (PM2 — auto-restart on crash & code changes)
pm2 start ecosystem.config.cjs

# PM2 common commands
pm2 status              # View process status
pm2 logs metabot        # Tail logs in real-time
pm2 restart metabot     # Manual restart
pm2 stop metabot        # Stop service
```

To enable auto-start on server reboot:

```bash
pm2 startup             # Follow the printed sudo command
pm2 save                # Save current process list
```

### Chat Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session, start fresh |
| `/stop` | Abort current running task |
| `/status` | Show current session info |
| `/memory` | Memory document commands (list, search, status) |
| `/help` | Show help message |

### Self-Replication (Bot CRUD)

The Genesis Bot can create new bots at runtime. When `BOTS_CONFIG` is set, the API supports:

```bash
# Create a new Feishu bot
curl -X POST localhost:9100/api/bots \
  -H 'Content-Type: application/json' \
  -d '{
    "platform": "feishu",
    "name": "project-alpha",
    "feishuAppId": "cli_xxx",
    "feishuAppSecret": "secret",
    "defaultWorkingDirectory": "/home/user/alpha",
    "installSkills": true
  }'

# Create a new Telegram bot
curl -X POST localhost:9100/api/bots \
  -H 'Content-Type: application/json' \
  -d '{
    "platform": "telegram",
    "name": "tg-beta",
    "telegramBotToken": "123456:ABC...",
    "defaultWorkingDirectory": "/home/user/beta",
    "installSkills": true
  }'

# Get bot details
curl localhost:9100/api/bots/project-alpha

# Remove a bot
curl -X DELETE localhost:9100/api/bots/project-alpha
```

**How it works:** `POST /api/bots` writes the new entry to `bots.json` → PM2 watches the file → auto-restarts the process → new bot is live within seconds. No complex hot-reload needed.

When `installSkills: true` is set, the metaskill and metamemory skills are automatically copied to the new bot's working directory.

Claude itself knows about these APIs (they're injected into the system prompt), so you can ask your Genesis Bot in chat: *"Create a new Telegram bot called project-x for /home/user/project-x"* and it will do it.

### HTTP API & Task Scheduler

MetaBot includes a built-in HTTP API server for inter-bot communication, bot management, and task scheduling. Claude uses these features autonomously via `curl` — the API docs are injected into Claude's system prompt.

**API Server** — Starts automatically on `localhost:9100` (configurable via `API_PORT`). If `API_SECRET` is set, listens on `0.0.0.0` with Bearer token auth.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service health (uptime, bot count, scheduled tasks) |
| `GET` | `/api/bots` | List registered bots (name, platform, workingDir, tools) |
| `POST` | `/api/bots` | Create a new bot (writes bots.json, PM2 restarts) |
| `GET` | `/api/bots/:name` | Get bot details |
| `DELETE` | `/api/bots/:name` | Remove a bot |
| `POST` | `/api/tasks` | Submit a task to a bot (sync, returns result) |
| `POST` | `/api/schedule` | Schedule a future task |
| `GET` | `/api/schedule` | List pending scheduled tasks |
| `PATCH` | `/api/schedule/:id` | Update a pending task |
| `DELETE` | `/api/schedule/:id` | Cancel a scheduled task |

**Task scheduling examples:**

```bash
# Delegate a task to another bot
curl -X POST localhost:9100/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"botName":"alice","chatId":"oc_xxx","prompt":"check test results"}'

# Schedule a task for 1 hour later
curl -X POST localhost:9100/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"botName":"alice","chatId":"oc_xxx","prompt":"check experiment","delaySeconds":3600,"label":"experiment check"}'
```

**Task Scheduler** — Persists to `~/.metabot/scheduled-tasks.json`. On startup, pending tasks are restored. If the target chat is busy, retries every 30s (max 5 times). Tasks overdue by >24h are skipped as stale.

### Image & File Support

**Send images to Claude:** Send an image in chat, and Claude will analyze it (both Feishu and Telegram).

**Receive images from Claude:** When Claude generates or writes image files, they are automatically uploaded and sent back to chat.

**File output:** When Claude produces files (PDFs, docs, archives, etc.), they are automatically sent. Claude is instructed to place output files in a per-chat temp directory that the bridge scans after execution.

Supported image formats: PNG, JPEG, GIF, WEBP, BMP, SVG, TIFF (max 10MB for Feishu, 50MB for Telegram).

### MetaMemory (Shared Knowledge Base)

MetaMemory is a document server for persistent shared memory. Claude autonomously reads/writes documents via the `metamemory` skill, and humans can browse via a Web UI.

**How it works:**
- A separate MetaMemory server (FastAPI + SQLite) stores documents as Markdown in a folder tree with full-text search
- Claude uses the `metamemory` skill to create/read/update documents via the server API
- The `/memory` commands provide quick access to folder listings and search results
- A Web UI at `http://localhost:8100` lets you browse and manage documents

**Commands:**
```
/memory list          — Show folder tree
/memory search query  — Search documents
/memory status        — Server health check
```

**Configuration:** Set `MEMORY_SERVER_URL` in `.env` (default: `http://localhost:8100`). Run the MetaMemory server via Docker: see `xvirobotics/metamemory`.

### MCP Server Configuration

MCP servers are loaded from Claude Code's standard config files — no extra setup needed:

- **Global (all projects):** `~/.claude/settings.json`
- **Per-project:** `<working-directory>/.claude/settings.json`

Example config:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

The bot loads MCP servers based on the bot's configured working directory. If you already have MCP servers configured for Claude Code CLI, they work automatically.

### Security Note

This service runs Claude Code in **`bypassPermissions` mode** — Claude can read, write, and execute commands without interactive approval, since there is no terminal for user confirmation in a chat bot context.

**Make sure you understand the implications before deploying:**

- Claude has full read/write access to the working directory
- Claude can execute arbitrary shell commands if `Bash` is in the allowed tools
- Use `CLAUDE_ALLOWED_TOOLS` to restrict capabilities (e.g. remove `Bash` for read-only use)
- Use `maxBudgetUsd` in bot config to cap per-request cost
- Use `authorizedUserIds` in bot config to restrict who can access the bot
- **Never point the bot at directories containing sensitive data without proper access controls**

### Architecture

```
Feishu User                          Telegram User
  → [WSClient] WebSocket               → [grammY] Long Polling
  → [Event Handler]                     → [Telegram Bot Handler]
  → [FeishuSenderAdapter]               → [TelegramSender]
       ↘                               ↙
        [Message Bridge] (shared, platform-agnostic)
          → Claude Code Agent SDK
          → Stream Processor → throttled updates (1.5s)
          → Session Manager, Rate Limiter, Outputs Manager

        [Bot Registry] ← registers all bots at startup
             ↕
        [HTTP API Server] :9100
          → POST /api/bots      (self-replication — create/remove bots)
          → POST /api/tasks     (inter-bot delegation)
          → POST /api/schedule  (future task scheduling)
             ↕
        [Task Scheduler] → fires tasks → Message Bridge
          → persists to ~/.metabot/scheduled-tasks.json
             ↕
        [bots.json] ← API writes → PM2 file-watch → auto-restart
```

---

<a id="中文"></a>

## 中文

MetaBot — 多平台 IM Bot 连接 Claude Code 的桥接服务。支持飞书和 Telegram，在手机端通过聊天远程控制本机的 Claude Code，实时查看执行过程和结果。一条命令安装，一个 Bot 生万物。

> *"一生二，二生三，三生万物"* — Genesis Bot 可以在聊天中创建更多 Bot。MetaBot 名副其实。

### 一条命令安装

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

安装器会引导你完成：
- 平台选择（飞书、Telegram、或两者都选）
- IM Bot 凭证配置
- Claude AI 认证（订阅登录、Anthropic API Key、或第三方服务商如 Kimi/DeepSeek/GLM）
- 工作目录、API 密钥、MetaMemory 配置
- 自动 PM2 部署

在已有安装上重新运行安装器会执行 `git pull`，并保留现有的 `.env` / `bots.json`。

### 功能特性

- **一键安装** - `curl | bash` 几分钟从零到运行
- **多平台支持** - 同时支持飞书（Feishu/Lark）和 Telegram，可在单进程中并行运行
- **自我复制** - Genesis Bot 通过 `POST /api/bots` 在聊天中创建新 Bot —— PM2 自动重启激活
- **第三方 AI 服务** - 支持 Kimi/Moonshot、DeepSeek、GLM/智谱、或任何 Anthropic 兼容 API
- **远程访问** - 在任意设备上使用 Claude Code，手机也能写代码
- **流式更新** - 实时展示执行进度（飞书交互卡片 / Telegram 消息编辑）
- **多机器人支持** - 单进程运行多个 Bot，每个 Bot 绑定不同项目目录
- **多用户并行** - 每个会话（群聊/私聊）独立会话，互不干扰
- **多轮对话** - 自动维护对话上下文，支持连续交互
- **图片支持** - 发图片给 Claude 分析；Claude 生成的图片自动回传
- **文件输出** - Claude 产出的文件（PDF、文档、压缩包等）自动发送到聊天
- **MCP 集成** - 自动加载 Claude Code 配置文件中的 MCP 服务器
- **状态卡片** - 颜色标识状态、工具调用追踪、费用/耗时统计
- **HTTP API** - Bot 间任务委派，Claude 通过 `curl` 调用其他 Bot
- **Bot CRUD API** - 运行时通过 REST API 创建、查看、删除 Bot
- **定时任务** - 支持延时任务调度（"2小时后检查一下"），持久化存储，自动重试
- **MetaMemory** - 共享知识库，全文搜索，Web UI，Claude 自主读写

### 前置条件

- **Node.js 18+**
- **Claude Code CLI** - `npm install -g @anthropic-ai/claude-code`
- **Claude AI 认证** - 以下三种方式任选其一：
  - Claude Pro/Max 订阅：`claude login`
  - Anthropic API Key：`ANTHROPIC_API_KEY=sk-ant-...`
  - 第三方服务商（见下文）
- **飞书开放平台账号**（飞书 Bot）和/或 **Telegram Bot Token**（从 [@BotFather](https://t.me/BotFather) 获取）

### 第三方 AI 服务商

MetaBot 支持任何 Anthropic 兼容 API。在 `.env` 中设置以下环境变量：

**Kimi / Moonshot（月之暗面）**
```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=你的moonshot-api-key
```

**DeepSeek（深度求索）**
```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=你的deepseek-api-key
ANTHROPIC_MODEL=deepseek-chat
ANTHROPIC_SMALL_FAST_MODEL=deepseek-chat
API_TIMEOUT_MS=600000
```

**GLM / 智谱**
```bash
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=你的zhipu-api-key
ANTHROPIC_MODEL=glm-4.5
```

**自定义服务商** — 任何实现 Anthropic Messages 接口的 API：
```bash
ANTHROPIC_BASE_URL=https://你的服务商.com/anthropic
ANTHROPIC_AUTH_TOKEN=你的api-key
ANTHROPIC_MODEL=模型名              # 可选
ANTHROPIC_SMALL_FAST_MODEL=模型名    # 可选
```

> **注意：** `ANTHROPIC_AUTH_TOKEN`（Bearer token）和 `ANTHROPIC_API_KEY`（x-api-key header）互斥，只能设一个。大多数第三方服务商使用 `ANTHROPIC_AUTH_TOKEN`。

`install.sh` 安装器会引导你选择服务商并自动配置这些变量。

---

### 第一步：创建 IM 机器人

#### 飞书机器人配置

1. 打开 [飞书开放平台](https://open.feishu.cn/)，登录后点击「创建企业自建应用」
2. 填写应用名称（如 `Claude Code Bot`）和描述，点击创建
3. 进入应用详情页 →「凭证与基础信息」→ 记录 **App ID** 和 **App Secret**
4. 左侧菜单 →「应用能力」→ 添加「机器人」能力
5. 左侧菜单 →「权限管理」→ 搜索并开通：
   - `im:message` - 获取与发送单聊、群组消息
   - `im:message:readonly` - 读取消息
   - `im:resource` - 上传图片和文件
6. **先启动服务**（见第二步），再配置事件订阅：
   - 左侧菜单 →「事件与回调」→ 订阅方式选「使用长连接接收事件」
   - 点击保存（飞书会验证 WebSocket 连接）
   - 添加事件：`接收消息 im.message.receive_v1`
7. 创建版本并发布

> **提示**：飞书使用 WebSocket 长连接，不需要公网 IP，本地即可运行。

#### Telegram 机器人配置（可选）

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示设置名称和用户名
3. 复制 **bot token**（格式如 `123456:ABC-DEF...`）
4. 写入 `.env` 的 `TELEGRAM_BOT_TOKEN` 或加到 `bots.json`

无需 Webhook，MetaBot 使用**长轮询**模式，不需要公网 IP。

---

### 第二步：安装部署

**方式一：一条命令安装（推荐）**

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

安装器会引导你完成所有配置，包括 Claude AI 认证方式选择：

```
Claude AI Authentication:
  1) Claude Code Subscription (OAuth login via 'claude login')
  2) Anthropic API Key (ANTHROPIC_API_KEY=sk-ant-...)
  3) Third-party provider (Kimi/Moonshot, DeepSeek, GLM, etc.)
```

选择第三方服务商后，会进一步引导选择具体提供商和配置 API Key/Model。

**方式二：手动配置**

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot
npm install
cp bots.example.json bots.json   # 编辑 Bot 配置
cp .env.example .env              # 编辑全局设置
```

---

### 第三步：配置

**`bots.json`** — 定义一个或多个 Bot，支持飞书和 Telegram 混合配置：

```json
{
  "feishuBots": [
    {
      "name": "genesis",
      "feishuAppId": "cli_xxx",
      "feishuAppSecret": "xxxxxxxxxx",
      "defaultWorkingDirectory": "/home/user/project",
      "authorizedUserIds": ["ou_xxxx"]
    }
  ],
  "telegramBots": [
    {
      "name": "tg-bot",
      "telegramBotToken": "123456:ABC-DEF...",
      "defaultWorkingDirectory": "/home/user/project",
      "authorizedUserIds": ["12345678"]
    }
  ]
}
```

> **向后兼容**：如果 `bots.json` 是数组格式（旧格式），所有条目作为飞书 Bot 处理。

**Bot 配置字段：**

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | - | Bot 标识名（用于日志区分） |
| `feishuAppId` / `feishuAppSecret` | 飞书必填 | - | 飞书应用凭证 |
| `telegramBotToken` | Telegram 必填 | - | Telegram Bot Token |
| `defaultWorkingDirectory` | 是 | - | 固定工作目录 |
| `authorizedUserIds` | 否 | 不限制 | 允许使用的用户 ID 数组 |
| `authorizedChatIds` | 否 | 不限制 | 允许使用的 chat ID 数组 |
| `allowedTools` | 否 | Read,Edit,Write,Glob,Grep,Bash | Claude 可用工具 |
| `maxTurns` | 否 | 不限制 | 每次请求最大对话轮数 |
| `maxBudgetUsd` | 否 | 不限制 | 每次请求最大花费（美元） |
| `model` | 否 | SDK 默认 | 指定 Claude 模型 |

**`.env`** — 全局设置：

```bash
# 指向 Bot 配置文件
BOTS_CONFIG=./bots.json

# HTTP API（Bot 间通信、Bot 管理、定时任务）
API_PORT=9100
# API_SECRET=xxx   # 设置后监听 0.0.0.0 并启用 Bearer 认证；不设则仅监听 localhost

# Claude AI 认证（三选一）
# ANTHROPIC_API_KEY=sk-ant-...              # Anthropic API Key
# ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic  # 第三方服务商
# ANTHROPIC_AUTH_TOKEN=your-key             # 第三方 API Key

# 日志级别
LOG_LEVEL=info
```

---

### 第四步：启动服务

#### 开发模式（推荐先用这个测试）

```bash
npm run dev
```

#### 生产模式（PM2）

```bash
# 安装 PM2（如未安装）
npm install -g pm2

# 启动服务
pm2 start ecosystem.config.cjs
```

PM2 常用命令：

```bash
pm2 status              # 查看进程状态
pm2 logs metabot        # 实时查看日志
pm2 restart metabot     # 手动重启
pm2 stop metabot        # 停止服务
```

设置开机自启：

```bash
pm2 startup             # 按照提示执行打印出的 sudo 命令
pm2 save                # 保存当前进程列表
```

看到类似以下日志表示启动成功：

```
[INFO] All bots started — bots: ["genesis"]
[ws] ws client ready
```

---

### 第五步：开始使用

#### 基本流程

1. 在飞书或 Telegram 中找到你的机器人（私聊或拉入群组）
2. 直接发送消息开始和 Claude Code 对话（工作目录已在配置中固定）
3. 消息会实时更新执行进度，完成后显示最终结果

#### 可用命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除对话历史，重新开始 |
| `/stop` | 中止当前正在执行的任务 |
| `/status` | 查看当前会话状态 |
| `/memory` | 知识文档命令（list、search、status） |
| `/help` | 显示帮助信息 |

#### 使用示例

```
你：帮我看看这个项目的结构，有哪些主要模块
Bot：🔵 Thinking... → 🔵 Running... → 🟢 Complete
    （卡片实时更新，展示 Claude 正在读取哪些文件、分析结果等）

你：给 utils.ts 加上单元测试
Bot：（Claude 会读取文件、编写测试、运行测试，全程卡片更新）

你：帮我创建一个新的 Telegram Bot，名叫 project-x，工作目录 /home/user/project-x
Bot：（Genesis Bot 调用 POST /api/bots 创建新 Bot，PM2 自动重启激活）

你：/reset
Bot：✅ Session Reset - 开始新对话
```

---

### 自我复制（Bot CRUD）

Genesis Bot 可以在运行时创建新 Bot。当设置了 `BOTS_CONFIG` 时，API 支持：

```bash
# 创建飞书 Bot
curl -X POST localhost:9100/api/bots \
  -H 'Content-Type: application/json' \
  -d '{
    "platform": "feishu",
    "name": "project-alpha",
    "feishuAppId": "cli_xxx",
    "feishuAppSecret": "secret",
    "defaultWorkingDirectory": "/home/user/alpha",
    "installSkills": true
  }'

# 创建 Telegram Bot
curl -X POST localhost:9100/api/bots \
  -H 'Content-Type: application/json' \
  -d '{
    "platform": "telegram",
    "name": "tg-beta",
    "telegramBotToken": "123456:ABC...",
    "defaultWorkingDirectory": "/home/user/beta",
    "installSkills": true
  }'

# 查看 Bot 详情
curl localhost:9100/api/bots/project-alpha

# 删除 Bot
curl -X DELETE localhost:9100/api/bots/project-alpha
```

**原理：** `POST /api/bots` 将新条目写入 `bots.json` → PM2 监听文件变化 → 自动重启进程 → 新 Bot 几秒内上线。无需复杂的热重载机制。

设置 `installSkills: true` 会自动将 metaskill 和 metamemory 技能复制到新 Bot 的工作目录。

Claude 本身了解这些 API（已注入系统提示词），所以你可以在聊天中直接告诉 Genesis Bot：*"帮我创建一个 Telegram Bot，叫 project-x，工作目录 /home/user/project-x"*，它会自动完成。

---

### HTTP API 与定时任务

MetaBot 内置 HTTP API 服务器，支持 Bot 管理、任务委派和定时任务调度。Claude 通过 `curl` 自主使用这些功能。

**接口一览：**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 服务健康检查 |
| `GET` | `/api/bots` | 列出所有 Bot |
| `POST` | `/api/bots` | 创建新 Bot（写入 bots.json，PM2 重启） |
| `GET` | `/api/bots/:name` | 查看 Bot 详情 |
| `DELETE` | `/api/bots/:name` | 删除 Bot |
| `POST` | `/api/tasks` | 向指定 Bot 提交任务（同步） |
| `POST` | `/api/schedule` | 创建定时任务 |
| `GET` | `/api/schedule` | 查看定时任务列表 |
| `PATCH` | `/api/schedule/:id` | 更新定时任务 |
| `DELETE` | `/api/schedule/:id` | 取消定时任务 |

**定时任务示例：**

```bash
# 委派任务给其他 Bot
curl -X POST localhost:9100/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"botName":"alice","chatId":"oc_xxx","prompt":"检查测试结果"}'

# 1 小时后执行定时任务
curl -X POST localhost:9100/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"botName":"alice","chatId":"oc_xxx","prompt":"检查实验结果","delaySeconds":3600,"label":"实验检查"}'
```

**定时任务调度器** — 持久化存储在 `~/.metabot/scheduled-tasks.json`，服务重启后自动恢复。目标聊天忙时每 30 秒重试（最多 5 次），超过 24 小时未执行的任务视为过期跳过。

---

### 卡片状态说明

| 颜色 | 状态 | 含义 |
|------|------|------|
| 🔵 蓝色 | Thinking | Claude 正在思考 |
| 🔵 蓝色 | Running | 正在执行工具（读文件、写代码、运行命令等） |
| 🟢 绿色 | Complete | 执行完成 |
| 🔴 红色 | Error | 执行出错 |

卡片底部会显示：耗时、API 花费等统计信息。

---

### 图片与文件支持

**发送图片给 Claude：** 在飞书或 Telegram 中直接发送图片，Claude 会自动分析图片内容。

**接收 Claude 生成的图片：** 当 Claude 生成图片文件时，自动上传并发送到聊天中。

**文件输出：** Claude 产出的文件（PDF、文档、压缩包等）自动发送。Claude 会将输出文件放入每次执行的临时目录，Bridge 执行后自动扫描发送。

支持格式：PNG、JPEG、GIF、WEBP、BMP、SVG、TIFF（飞书最大 10MB，Telegram 最大 50MB）。

---

### MetaMemory（共享知识库）

MetaMemory 是一个文档服务器，提供持久化共享记忆。Claude 通过 `metamemory` skill 自主读写文档，人通过 Web UI 浏览。

**工作原理：**
- 独立的 MetaMemory 服务器（FastAPI + SQLite）以文件夹树形式存储 Markdown 文档，支持全文搜索
- Claude 通过 `metamemory` skill 自动调用服务器 API 创建/读取/更新文档
- `/memory` 命令提供快速查询
- Web UI `http://localhost:8100` 支持浏览和管理文档

**命令：**
```
/memory list          — 显示文件夹树
/memory search 关键词  — 搜索文档
/memory status        — 服务器健康检查
```

**配置：** 在 `.env` 中设置 `MEMORY_SERVER_URL`（默认 `http://localhost:8100`）。通过 Docker 运行：见 `xvirobotics/metamemory`。

---

### MCP 服务器配置

MCP 服务器配置直接复用 Claude Code 的标准配置文件，无需额外设置：

- **全局配置：** `~/.claude/settings.json`
- **项目配置：** `<工作目录>/.claude/settings.json`

Bot 会根据配置中的工作目录加载对应的 MCP 配置。如果你已经为 Claude Code CLI 配置过 MCP 服务器，它们会自动生效。

---

### 架构概览

```
飞书用户                              Telegram 用户
  → [WSClient 长连接]                    → [grammY 长轮询]
  → [Event Handler]                     → [Telegram Bot Handler]
  → [FeishuSenderAdapter]               → [TelegramSender]
       ↘                               ↙
        [Message Bridge] 共享核心（平台无关）
          → Claude Code Agent SDK
          → 流式处理 → 节流更新（1.5s 间隔）
          → 会话管理、限流、输出文件管理

        [Bot Registry] ← 启动时注册所有 Bot
             ↕
        [HTTP API Server] :9100
          → POST /api/bots      (自我复制 — 创建/删除 Bot)
          → POST /api/tasks     (Bot 间任务委派)
          → POST /api/schedule  (定时任务调度)
             ↕
        [Task Scheduler] → 触发任务 → Message Bridge
          → 持久化存储 ~/.metabot/scheduled-tasks.json
             ↕
        [bots.json] ← API 写入 → PM2 文件监听 → 自动重启
```

---

### 安全说明

本服务以 **`bypassPermissions`（跳过权限确认）模式** 运行 Claude Code —— Claude 可以直接读写文件和执行命令，无需交互式确认。

**部署前请确保你了解以下影响：**

- Claude 对工作目录拥有完整的读写权限
- 如果允许工具列表中包含 `Bash`，Claude 可以执行任意 Shell 命令
- 通过 `allowedTools` 限制可用工具（例如去掉 `Bash` 实现只读模式）
- 通过 `maxBudgetUsd` 限制单次请求的最大花费
- 通过 `authorizedUserIds` 限制谁可以使用机器人
- **不要将机器人指向包含敏感数据的目录，除非已做好访问控制**

---

### 常见问题

**Q: 需要公网 IP 吗？**

不需要。飞书使用 WebSocket 长连接，Telegram 使用长轮询，两者都只需能访问外网即可。

**Q: 可以用国产大模型吗？**

可以。MetaBot 支持任何 Anthropic 兼容 API，包括 Kimi/Moonshot、DeepSeek、GLM/智谱等。运行 `install.sh` 时选择「Third-party provider」，或手动在 `.env` 中配置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`。

**Q: 如何获取用户的 open_id？**

发送 `/status` 命令，卡片中会显示当前用户的 open_id。

**Q: 如何让 Bot 创建其他 Bot？**

确保设置了 `BOTS_CONFIG=./bots.json`，然后在聊天中告诉 Bot："帮我创建一个新的 Telegram Bot，叫 xxx，工作目录 /path/to/project"。Bot 会通过 API 自动完成。也可以直接调用 `POST /api/bots`。

**Q: Claude 执行超时了怎么办？**

默认 10 分钟超时。可以拆分为多个小任务，也可以用 `/stop` 手动中止后重试。

---

## License

[MIT](LICENSE)
