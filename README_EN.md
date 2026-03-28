# MetaBot

**Infrastructure for building a supervised, self-improving agent organization.**

[![CI](https://img.shields.io/github/actions/workflow/status/xvirobotics/metabot/ci.yml?branch=main&style=flat-square)](https://github.com/xvirobotics/metabot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=flat-square)](https://github.com/xvirobotics/metabot)

[English](#why) | [中文](README.md)

---

![MetaBot Architecture](resources/metabot.png)

## Why

Claude Code is the most capable AI coding agent — but it's trapped in your laptop terminal.

MetaBot sets it free. It gives every agent a Claude Code brain, persistent shared memory, the ability to create new agents, and a communication bus. All accessible from Feishu, Telegram, or WeChat on your phone.

We built MetaBot to run [XVI Robotics](https://xvirobotics.com) as an **agent-native company** — a small team of humans supervising an organization of self-improving AI agents. This is the infrastructure that makes it possible.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                       MetaBot                            │
│                                                          │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────┐  │
│  │ MetaSkill│ │MetaMemory │ │IM Bridge │ │ Scheduler │  │
│  │  Agent   │ │  Shared   │ │ Feishu+TG │ │   Cron    │  │
│  │ Factory  │ │ Knowledge │ │ + WeChat │ │   Tasks   │  │
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
| **Supervised** | IM Bridge | Real-time streaming cards show every tool call. Humans see everything agents do. Access control via Feishu/Telegram/WeChat platform settings. |
| **Self-Improving** | MetaMemory | Shared knowledge store. Agents write what they learn, other agents retrieve it. The organization gets smarter every day without retraining. |
| **Agent Organization** | MetaSkill + Scheduler + Agent Bus | One command generates a full agent team. Agents delegate tasks to each other. Scheduled tasks run autonomously. Agents can create new agents. |

## Core Components

| Component | Description |
|-----------|-------------|
| **Claude Code Kernel** | Every bot is a full Claude Code instance — Read, Write, Edit, Bash, Glob, Grep, WebSearch, MCP, and more. `bypassPermissions` mode for autonomous operation. |
| **MetaSkill** | Agent factory. `/metaskill ios app` generates a complete `.claude/` agent team (orchestrator + specialists + code-reviewer) after researching best practices. Uses MetaMemory for shared knowledge across agents. |
| **MetaMemory** | Embedded SQLite knowledge store with full-text search and Web UI. Agents read/write Markdown documents across sessions. Shared by all agents. Auto-syncs to Feishu Wiki when changes occur (debounced). Web UI: `http://localhost:8100?token=YOUR_TOKEN` (token shown in startup logs). |
| **Feishu Lark CLI** | Integrates the official Feishu CLI (`lark-cli`) with 200+ commands covering docs, messaging, calendar, tasks, and 8 more domains. 19 AI Agent Skills are auto-installed so Claude can read/write docs, send messages, manage calendars, and more. |
| **IM Bridge** | Chat with any agent from Feishu/Lark, Telegram, or WeChat (including mobile). Streaming cards with color-coded status and tool call tracking. WeChat integration via ClawBot plugin (iLink API). |
| **Agent Bus** | REST API on port 9100. Agents talk to each other via `mb talk`. Create/remove bots at runtime. Exposed as the `/metabot` skill — loaded on demand, not injected into every prompt. |
| **Peers** | Federation system for cross-instance bot discovery and task routing. Configure `METABOT_PEERS` to connect multiple MetaBot instances — same machine or remote. `mb talk alice/backend-bot` routes automatically. |
| **Task Scheduler** | One-time delays and recurring cron jobs. `0 8 * * 1-5` = weekday 8am news briefing. Timezone-aware (default: Asia/Shanghai). Persists across restarts, auto-retries when busy. |
| **CLI Tools** | `metabot`, `mm`, `mb` commands installed to `~/.local/bin/`. `metabot update` to pull/rebuild/restart. `mm` for MetaMemory, `mb` for Agent Bus. Feishu bots also get `lark-cli`. |

## Install

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
```

The installer walks you through: working directory → Claude auth → IM platform (Feishu/Telegram/WeChat ClawBot) → auto-start with PM2. Choose WeChat and the installer will display a QR login URL after startup — scan to bind.

**Update anytime** — already installed? One command to pull, rebuild, and restart:

```bash
metabot update
```

**Uninstall** — completely remove MetaBot, CLI tools, skills, and PM2 processes:

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/uninstall.sh | bash
```

> **Windows notes:** The PowerShell installer auto-detects `winget`/`choco`/`scoop` for Node.js installation. CLI tools (`mm`, `mb`, `metabot`, `fd`) are installed with `.cmd` wrappers and require [Git for Windows](https://git-scm.com) (provides Git Bash).

<details>
<summary><strong>Manual install</strong></summary>

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # edit with your bot configs
cp .env.example .env              # edit global settings
npm run dev
```

Prerequisites: Node.js 20+, [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated. Works on Linux, macOS, and Windows.

</details>

## Quick Setup

**Telegram** (30 seconds):
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy token
2. Add to `bots.json` → done (long polling, no webhooks)

**WeChat** (gray testing):
1. iPhone WeChat 8.0.70+ → Settings → Plugins → enable **ClawBot**
2. Run `install.sh`, pick `3) WeChat ClawBot` — after install, the QR login URL is displayed automatically; scan to bind
3. Or manually: add `wechatBots` to `bots.json` → `npm run dev` → scan QR in terminal
4. See [WeChat Setup Guide](https://xvirobotics.com/metabot/features/wechat/)

**Feishu/Lark**:
1. Create app at [open.feishu.cn](https://open.feishu.cn/) → add Bot capability
2. Enable permissions: `im:message`, `im:message:readonly`, `im:resource`, `im:chat:readonly` (for group chat detection), `docx:document:readonly`, `wiki:wiki` (for doc reading & wiki sync)
3. Start MetaBot, then enable persistent connection + `im.message.receive_v1` event
4. Publish the app

## Feishu Usage Tips

### DM vs Group Chat

| Scenario | @mention | Notes |
|----------|----------|-------|
| **Direct message** | Not needed | All messages go to the bot |
| **1-on-1 group** (you + bot, 2 members) | Not needed | Auto-detected as DM-like |
| **Multi-member group** | @Bot required | Only @mentioned messages trigger a response |

> **Tip**: Create a 2-person group with just you and the bot. No @mention needed, plus you get group features like pinning and organization.

### Sending Files & Images

**DM / 2-person group**: Send files or images directly — the bot processes them automatically. Multiple files sent within 2 seconds are batched into a single request.

**Multi-member group**: Feishu doesn't allow @mentioning while uploading files. Workaround: **upload first, @mention later**

1. Upload your files/images in the group (no @mention needed)
2. Within 5 minutes, @Bot with your instruction (e.g. "analyze these")
3. The bot automatically attaches your previously uploaded files

```
[upload report.pdf]            ← upload first
[upload screenshot.png]        ← multiple files ok
@MetaBot analyze these files   ← then @Bot, files auto-attached
```

### Supported Message Types

- **Text** — regular conversation
- **Images** — auto-analyzed (Claude multimodal)
- **Files** — PDF, code, documents, etc.
- **Rich text** — Feishu Post format (text + images)
- **Batch upload** — multiple files/images sent in quick succession are merged

## What You Can Build

- **Solo AI developer** — full Claude Code from your phone via Feishu/Telegram/WeChat, bound to your project
- **Multi-agent team** — frontend bot, backend bot, infra bot, each in their own workspace, talking via the Agent Bus
- **Self-growing organization** — a manager bot that creates new agents on demand, assigns tasks, schedules follow-ups
- **Autonomous research pipeline** — agents that search, analyze, save findings to MetaMemory, and schedule next steps
- **Voice assistant (Jarvis mode)** — "Hey Siri, Jarvis" from AirPods, hands-free voice control of any agent via iOS Shortcuts. Server-side Whisper STT for high-quality speech recognition. See [Voice Setup Guide](docs/features/voice-jarvis.md)

## Example Prompts

New to MetaBot? Here are real prompts you can send in Feishu/Telegram to unlock its advanced features.

### MetaMemory — Persistent Knowledge

```
Remember the deployment guide we just discussed — save it to MetaMemory
under /projects/deployment.
```

```
Search MetaMemory for our API design conventions.
```

```
Summarize today's code review findings and save them to MetaMemory
for the team to reference later.
```

### MetaSkill — Agent & Skill Factory

```
/metaskill Create an agent team for this React Native project —
I need a frontend specialist, a backend API specialist, and a code reviewer.
```

```
/metaskill Create a skill that reads our Jira board and summarizes
open tickets.
```

### Scheduling — Automated Tasks

```
Schedule a daily task at 9am: search Hacker News and TechCrunch for AI news,
summarize the top 5 stories, and save the summary to MetaMemory.
```

```
Remind me in 30 minutes to check if the deployment succeeded.
```

```
Set up a weekly Monday 8am task: review last week's git commits, generate
a progress report, and save it to MetaMemory under /reports.
```

### Agent-to-Agent — Task Delegation

```
Delegate this bug fix to backend-bot: "Fix the null pointer exception
in /api/users/:id endpoint, see the error log in MetaMemory /logs/errors".
```

```
Ask frontend-bot to update the dashboard UI, and at the same time
ask backend-bot to add the new API endpoint. Both should save their
progress to MetaMemory under /projects/dashboard.
```

### Combined Workflows

```
Research best practices for WebSocket authentication, create a detailed
implementation plan, then save the plan to MetaMemory under
/architecture/websocket-auth for the team to review.
```

```
Read this Feishu doc [paste URL], extract the product requirements, break
them into tasks, and schedule a daily standup summary at 6pm that tracks
progress against these requirements.
```

```
/metaskill Create a "daily-ops" agent that runs every morning at 8am:
checks service health, reviews overnight error logs, and posts a summary.
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
  }],
  "wechatBots": [{
    "name": "wechat-bot",
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
| `wechatBotToken` | WeChat (opt) | — | Pre-authenticated iLink token (omit for QR login) |
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
| `FEISHU_SERVICE_APP_ID` | — | Feishu service app for wiki sync & doc reader (falls back to first bot) |
| `FEISHU_SERVICE_APP_SECRET` | — | Feishu service app secret |
| `WIKI_SYNC_ENABLED` | true | Enable MetaMemory→Wiki sync |
| `WIKI_SPACE_ID` | — | Feishu Wiki space ID |
| `WIKI_SPACE_NAME` | MetaMemory | Feishu Wiki space name |
| `WIKI_AUTO_SYNC` | true | Auto-sync on MetaMemory changes (debounced) |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | 5000 | Debounce delay for auto-sync |
| `CLAUDE_EXECUTABLE_PATH` | auto-detect | Path to `claude` binary (resolved via `which` if not set) |
| `METABOT_URL` | `http://localhost:9100` | MetaBot API URL (for CLI remote access) |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory server URL (for CLI remote access) |
| `METABOT_PEERS` | — | Comma-separated peer MetaBot URLs for cross-instance discovery |
| `METABOT_PEER_SECRETS` | — | Comma-separated secrets for each peer (positional match) |
| `METABOT_PEER_NAMES` | auto | Comma-separated names for each peer |
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
- Control access via Feishu/Telegram/WeChat platform settings (app visibility, group membership)
- Use `maxBudgetUsd` to cap cost per request
- `API_SECRET` enables Bearer auth on both the API server and MetaMemory
- MetaMemory Web UI requires a token: open `http://localhost:8100?token=YOUR_TOKEN` in browser. The full URL with token is printed to logs on startup. The token is saved to `localStorage` so you only need to pass it once
- MetaMemory supports **folder-level ACL**: set `MEMORY_ADMIN_TOKEN` and `MEMORY_TOKEN` for dual-role access. Admin sees all folders; reader only sees folders with `visibility: shared`. Use `PUT /api/folders/:id` with `{"visibility":"private"}` to lock a folder

## Chat Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session |
| `/stop` | Abort current task |
| `/status` | Session info |
| `/memory list` | Browse knowledge tree |
| `/memory search <query>` | Search knowledge base |
| `/sync` | Sync MetaMemory to Feishu Wiki |
| `/sync status` | Show wiki sync status |
| `/help` | Show help |
| `/metaskill ...` | Generate agent teams, agents, or skills |
| `/metabot` | Agent bus, scheduling, and bot management API docs (loaded on demand) |
| `/anything` | Any unrecognized command is forwarded to Claude Code as a skill |

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/bots` | List bots (local + peer) |
| `POST` | `/api/bots` | Create bot at runtime |
| `GET` | `/api/bots/:name` | Get bot details |
| `DELETE` | `/api/bots/:name` | Remove bot |
| `POST` | `/api/talk` | Talk to a bot (auto-routes to peers, supports `peerName/botName`) |
| `GET` | `/api/peers` | List peers and their status |
| `POST` | `/api/schedule` | Schedule one-time or recurring (cron) task |
| `GET` | `/api/schedule` | List scheduled tasks (one-time + recurring) |
| `PATCH` | `/api/schedule/:id` | Update a scheduled task |
| `DELETE` | `/api/schedule/:id` | Cancel scheduled task |
| `POST` | `/api/schedule/:id/pause` | Pause a recurring task |
| `POST` | `/api/schedule/:id/resume` | Resume a paused recurring task |
| `POST` | `/api/sync` | Trigger MetaMemory → Wiki sync |
| `GET` | `/api/sync` | Wiki sync status |
| `POST` | `/api/sync/document` | Sync single document by ID |
| `GET` | `/api/feishu/document` | Read a Feishu document as Markdown |
| `GET` | `/api/stats` | Cost & usage stats (per-bot, per-user) |
| `GET` | `/api/metrics` | Prometheus metrics endpoint |
| `POST` | `/api/tts` | Text-to-speech (JSON text in, MP3 audio out) |

## CLI Tools

The installer places `metabot`, `mm`, `mb`, and `fd` (Feishu bots only) executables in `~/.local/bin/` (Linux/macOS) or `%USERPROFILE%\.local\bin\` with `.cmd` wrappers (Windows) — available immediately.

```bash
# MetaBot management
metabot update                      # pull latest, rebuild, restart
metabot start                       # start with PM2
metabot stop                        # stop
metabot restart                     # restart
metabot logs                        # view live logs
metabot status                      # PM2 process status

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

# Feishu Lark CLI (Feishu bots only, auto-installed and configured)
lark-cli docs +fetch --doc <feishu-url>                       # read document
lark-cli docs +create --title "Title" --markdown "Content"    # create document
lark-cli im +messages-send --chat-id oc_xxx --text "Hi"       # send message
lark-cli calendar +agenda --as user                           # view calendar

# Agent Bus
mb bots                             # list all bots (local + peer)
mb talk <bot> <chatId> <prompt>     # talk to a bot (auto-routes to peers)
mb talk alice/bot <chatId> <prompt> # talk to a specific peer's bot
mb peers                            # list peers and their status
mb schedule list                    # list scheduled tasks
mb schedule cron <bot> <chatId> '<cron>' <prompt>  # recurring task
mb schedule pause <id>              # pause recurring task
mb schedule resume <id>             # resume recurring task
mb stats                            # cost & usage stats
mb health                           # status check
mb update                           # pull + rebuild + restart (one command)

# Text-to-Speech
mb voice "Hello world"              # generate MP3, print file path
mb voice "Hello" --play             # generate and play audio
mb voice "Hello" -o greeting.mp3    # save to specific file
echo "Long text" | mb voice         # read from stdin
```

### Remote Access

CLI tools (`mb`, `mm`) can connect to a remote MetaBot/MetaMemory server. Add the URLs to your local `.env` file:

```bash
# In ~/.metabot/.env or ~/metabot/.env
METABOT_URL=http://your-server:9100      # mb commands target this server
META_MEMORY_URL=http://your-server:8100 # mm commands target this server
API_SECRET=your-secret                    # shared auth token
```

This allows multiple machines to share the same MetaBot and MetaMemory instance — local bots can delegate tasks to a remote agent bus, and any machine can read/write shared memory.

## Development

```bash
npm run dev          # Hot-reload dev server (tsx)
npm test             # Run tests (vitest, 155 tests)
npm run lint         # ESLint check
npm run format       # Prettier format
npm run build        # TypeScript compile to dist/
```

## Production

```bash
metabot start                       # or: pm2 start ecosystem.config.cjs
metabot update                      # pull + rebuild + restart
pm2 startup && pm2 save             # auto-start on boot
```

## FAQ

**No public IP needed?** — Correct. Feishu uses WebSocket, Telegram and WeChat use long polling.

**Non-Claude models?** — Yes. Any Anthropic-compatible API (Kimi, DeepSeek, GLM, etc.)

**Agent communication?** — Currently synchronous request-response. Async bidirectional protocols are on the roadmap.

## About

MetaBot is built by [XVI Robotics](https://xvirobotics.com), where we develop humanoid robot brains. We use MetaBot internally to run our company as an agent-native organization — a small team of humans supervising self-improving AI agents. We open-sourced it because we believe this is how companies will work in the future.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=xvirobotics/metabot&type=Date)](https://star-history.com/#xvirobotics/metabot&Date)

## License

[MIT](LICENSE)
