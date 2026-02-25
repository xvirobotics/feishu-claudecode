# MetaBot

**Infrastructure for building a supervised, self-improving agent organization.**

[![CI](https://img.shields.io/github/actions/workflow/status/xvirobotics/metabot/ci.yml?branch=main&style=flat-square)](https://github.com/xvirobotics/metabot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=flat-square)](https://github.com/xvirobotics/metabot)

[English](#why) | [中文](README_zh.md)

---

![MetaBot Architecture](resources/metabot.png)

## Why

Claude Code is the most capable AI coding agent — but it's trapped in your laptop terminal.

MetaBot sets it free. It gives every agent a Claude Code brain, persistent shared memory, the ability to create new agents, and a communication bus. All accessible from Feishu or Telegram on your phone.

We built MetaBot to run [XVI Robotics](https://github.com/xvirobotics) as an **agent-native company** — a small team of humans supervising an organization of self-improving AI agents. This is the infrastructure that makes it possible.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                       MetaBot                            │
│                                                          │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────┐  │
│  │ MetaSkill│ │MetaMemory │ │IM Bridge │ │ Scheduler │  │
│  │  Agent   │ │  Shared   │ │ Feishu + │ │   Cron    │  │
│  │ Factory  │ │ Knowledge │ │ Telegram │ │   Tasks   │  │
│  └────┬─────┘ └─────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       └──────────────┴────────────┴─────────────┘        │
│                       ↕                                  │
│            Claude Code Agent SDK                         │
│         (bypassPermissions, streaming)                   │
│                       ↕                                  │
│             HTTP API (:9100) — Agent Bus                 │
│        task delegation · bot CRUD · scheduling           │
└──────────────────────────────────────────────────────────┘
```

**Three pillars of a self-improving agent organization:**

| Pillar | Component | What it does |
|--------|-----------|-------------|
| **Supervised** | IM Bridge + Auth | Real-time streaming cards show every tool call. Access control via user/chat allowlists. Humans see everything agents do. |
| **Self-Improving** | MetaMemory | Shared knowledge store. Agents write what they learn, other agents retrieve it. The organization gets smarter every day without retraining. |
| **Agent Organization** | MetaSkill + Scheduler + Agent Bus | One command generates a full agent team. Agents delegate tasks to each other. Scheduled tasks run autonomously. Agents can create new agents. |

## Core Components

| Component | Description |
|-----------|-------------|
| **Claude Code Kernel** | Every bot is a full Claude Code instance — Read, Write, Edit, Bash, Glob, Grep, WebSearch, MCP, and more. `bypassPermissions` mode for autonomous operation. |
| **MetaSkill** | Agent factory. `/metaskill ios app` generates a complete `.claude/` agent team (tech-lead + specialists + code-reviewer) after researching best practices. |
| **MetaMemory** | Embedded SQLite knowledge store with full-text search and Web UI. Agents read/write Markdown documents across sessions. Shared by all agents. |
| **IM Bridge** | Chat with any agent from Feishu/Lark or Telegram (including mobile). Streaming cards with color-coded status and tool call tracking. |
| **Agent Bus** | REST API on port 9100. Agents delegate tasks to each other via `curl`. Create/remove bots at runtime. Exposed as the `/metabot-api` skill — loaded on demand, not injected into every prompt. |
| **Task Scheduler** | Agents schedule future work — "check back in 2 hours". Persists across restarts, auto-retries when busy. |
| **CLI Tools** | `mm` and `mb` commands installed to `~/.local/bin/`. Manage MetaMemory and Agent Bus from any terminal — no shell sourcing required. |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

The installer walks you through: working directory → Claude auth → IM credentials → auto-start with PM2.

<details>
<summary><strong>Manual install</strong></summary>

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # edit with your bot configs
cp .env.example .env              # edit global settings
npm run dev
```

Prerequisites: Node.js 18+, [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated.

</details>

## Quick Setup

**Telegram** (30 seconds):
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy token
2. Add to `bots.json` → done (long polling, no webhooks)

**Feishu/Lark** ([detailed guide](docs/feishu-setup.md)):
1. Create app at [open.feishu.cn](https://open.feishu.cn/) → add Bot capability
2. Enable permissions: `im:message`, `im:message:readonly`, `im:resource`
3. Start MetaBot, then enable persistent connection + `im.message.receive_v1` event
4. Publish the app

## What You Can Build

- **Solo AI developer** — full Claude Code from your phone, bound to your project
- **Multi-agent team** — frontend bot, backend bot, infra bot, each in their own workspace, talking via the Agent Bus
- **Self-growing organization** — a manager bot that creates new agents on demand, assigns tasks, schedules follow-ups
- **Autonomous research pipeline** — agents that search, analyze, save findings to MetaMemory, and schedule next steps

## Agent Communication

Agents talk to each other through the HTTP API. Claude uses `curl` autonomously:

```bash
# Delegate a task to another bot
curl -X POST localhost:9100/api/tasks \
  -H "Authorization: Bearer $SECRET" \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"run the migration"}'

# Schedule a follow-up in 1 hour
curl -X POST localhost:9100/api/schedule \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"verify migration","delaySeconds":3600}'

# Create a new bot at runtime
curl -X POST localhost:9100/api/bots \
  -d '{"platform":"telegram","name":"data-bot","telegramBotToken":"...","defaultWorkingDirectory":"/data"}'
```

## Configuration

**`bots.json`** — define your bots:

```json
{
  "feishuBots": [{
    "name": "metabot",
    "feishuAppId": "cli_xxx",
    "feishuAppSecret": "...",
    "defaultWorkingDirectory": "/home/user/project"
  }],
  "telegramBots": [{
    "name": "tg-bot",
    "telegramBotToken": "123456:ABC...",
    "defaultWorkingDirectory": "/home/user/project"
  }]
}
```

<details>
<summary><strong>All bot config fields</strong></summary>

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Bot identifier |
| `defaultWorkingDirectory` | Yes | — | Working directory for Claude |
| `feishuAppId` / `feishuAppSecret` | Feishu | — | Feishu app credentials |
| `telegramBotToken` | Telegram | — | Telegram bot token |
| `allowedTools` | No | Read,Edit,Write,Glob,Grep,Bash | Claude tools whitelist |
| `maxTurns` / `maxBudgetUsd` | No | unlimited | Execution limits |
| `model` | No | SDK default | Claude model |

</details>

<details>
<summary><strong>Environment variables (.env)</strong></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `BOTS_CONFIG` | — | Path to `bots.json` |
| `API_PORT` | 9100 | HTTP API port |
| `API_SECRET` | — | Bearer token auth |
| `MEMORY_ENABLED` | true | Enable MetaMemory |
| `MEMORY_PORT` | 8100 | MetaMemory port |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory auth (legacy) |
| `MEMORY_ADMIN_TOKEN` | — | Admin token (full access, sees all folders) |
| `MEMORY_TOKEN` | — | Reader token (shared folders only) |
| `WEBHOOK_URLS` | — | Comma-separated webhook URLs for task completion notifications |
| `LOG_LEVEL` | info | Log level |

</details>

<details>
<summary><strong>Third-party AI providers</strong></summary>

MetaBot supports any Anthropic-compatible API:

```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic    # Kimi/Moonshot
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   # DeepSeek
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic       # GLM/Zhipu
ANTHROPIC_AUTH_TOKEN=your-key
```

</details>

## Security

MetaBot runs Claude Code in `bypassPermissions` mode — no interactive approval. Understand the implications:

- Claude has full read/write/execute access to the working directory
- Control access via Feishu/Telegram platform settings (app visibility, group membership)
- Use `allowedTools` to restrict capabilities (remove `Bash` for read-only)
- Use `maxBudgetUsd` to cap cost per request
- `API_SECRET` enables Bearer auth on both the API server and MetaMemory
- MetaMemory supports **folder-level ACL**: set `MEMORY_ADMIN_TOKEN` and `MEMORY_TOKEN` for dual-role access. Admin sees all folders; reader only sees folders with `visibility: shared`. Use `PUT /api/folders/:id` with `{"visibility":"private"}` to lock a folder

## Chat Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session |
| `/stop` | Abort current task |
| `/status` | Session info |
| `/memory list` | Browse knowledge tree |
| `/memory search <query>` | Search knowledge base |
| `/help` | Show help |
| `/metaskill ...` | Generate agent teams, agents, or skills |
| `/metabot-api` | Agent bus, scheduling, and bot management API docs (loaded on demand) |
| `/anything` | Any unrecognized command is forwarded to Claude Code as a skill |

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/bots` | List bots |
| `POST` | `/api/bots` | Create bot at runtime |
| `GET` | `/api/bots/:name` | Get bot details |
| `DELETE` | `/api/bots/:name` | Remove bot |
| `POST` | `/api/tasks` | Delegate task to a bot |
| `POST` | `/api/schedule` | Schedule future task |
| `GET` | `/api/schedule` | List scheduled tasks |
| `PATCH` | `/api/schedule/:id` | Update a scheduled task |
| `DELETE` | `/api/schedule/:id` | Cancel scheduled task |
| `GET` | `/api/stats` | Cost & usage stats (per-bot, per-user) |
| `GET` | `/api/metrics` | Prometheus metrics endpoint |

## CLI Tools

The installer places `mm` and `mb` executables in `~/.local/bin/` — available immediately, no `source` needed.

```bash
# MetaMemory — read
mm search "deployment guide"        # full-text search
mm list                             # list documents
mm folders                          # folder tree
mm path /projects/my-doc            # get doc by path

# MetaMemory — write
echo '# Notes' | mm create "Title" --folder ID --tags "dev"
echo '# Updated' | mm update DOC_ID
mm mkdir "new-folder"               # create folder
mm delete DOC_ID                    # delete document

# Agent Bus
mb bots                             # list all bots
mb task <bot> <chatId> <prompt>     # delegate task
mb schedule list                    # list scheduled tasks
mb stats                            # cost & usage stats
mb health                           # status check
```

## Development

```bash
npm run dev          # Hot-reload dev server (tsx)
npm test             # Run tests (vitest, 71 tests)
npm run lint         # ESLint check
npm run format       # Prettier format
npm run build        # TypeScript compile to dist/
```

## Production

```bash
pm2 start ecosystem.config.cjs
pm2 startup && pm2 save
```

## FAQ

**No public IP needed?** — Correct. Feishu uses WebSocket, Telegram uses long polling.

**Non-Claude models?** — Yes. Any Anthropic-compatible API (Kimi, DeepSeek, GLM, etc.)

**Agent communication?** — Currently synchronous request-response. Async bidirectional protocols are on the roadmap.

## About

MetaBot is built by [XVI Robotics](https://github.com/xvirobotics), where we develop humanoid robot brains. We use MetaBot internally to run our company as an agent-native organization — a small team of humans supervising self-improving AI agents. We open-sourced it because we believe this is how companies will work in the future.

## License

[MIT](LICENSE)
