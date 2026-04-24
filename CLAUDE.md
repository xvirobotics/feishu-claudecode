# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MetaBot — A bridge service that connects IM bots (Feishu/Lark) to the Claude Code Agent SDK. Users chat with Claude Code from Feishu (including mobile), with real-time streaming updates via interactive cards. Runs Claude in `bypassPermissions` mode since there's no terminal for interactive approval.

## Commands

```bash
npm run dev          # Development with tsx (hot reload)
npm run build        # TypeScript compile + build web frontend to dist/
npm run build:web    # Build web frontend only (Vite → dist/web/)
npm start            # Run compiled output (dist/index.js)
```

```bash
npm test             # Run tests (vitest)
npm run lint         # ESLint check
npm run format       # Prettier format
```

## Architecture

The app is a TypeScript ESM project (`"type": "module"`, all imports use `.js` extensions). It connects to Feishu via WebSocket (long connection, no public IP needed) and calls Claude via the `@anthropic-ai/claude-agent-sdk`.

### Message Flow

```
Feishu WSClient → EventHandler (parse, @mention filter) → MessageBridge → ClaudeExecutor → StreamProcessor → Feishu card updates
Web Browser → WebSocket (/ws) → ws-server.ts → MessageBridge.executeApiTask(onUpdate) → WebSocket push → React UI
```

### Key Modules

- **`src/index.ts`** — Entrypoint. Creates Feishu WS client, fetches bot info for @mention detection, wires up the event dispatcher and bridge, handles graceful shutdown.
- **`src/config.ts`** — Loads config. `BotConfig` is the per-bot type; `AppConfig` wraps `{ bots, log }`. `loadAppConfig()` reads `BOTS_CONFIG` JSON file or falls back to single-bot mode from env vars.
- **`src/feishu/event-handler.ts`** — Registers `im.message.receive_v1` on the Lark `EventDispatcher`. Handles text/image parsing, @mention stripping, group chat filtering (only responds when @mentioned, except in 2-member groups which are treated like DMs). Exports `IncomingMessage` type.
- **`src/bridge/message-bridge.ts`** — Core orchestrator. Routes commands (`/reset`, `/stop`, `/status`, `/help`, `/memory`), manages running tasks per chat (one task at a time per `chatId`), executes Claude queries with streaming card updates, handles image input/output, enforces 1-hour timeout.
- **`src/memory/memory-client.ts`** — Lightweight HTTP client for the MetaMemory server. Used by `/memory` commands (list, search, status) for quick Feishu responses without spawning Claude.
- **`src/claude/executor.ts`** — Wraps `query()` from the Agent SDK as an async generator yielding `SDKMessage`. Configures permissionMode, allowedTools, MCP settings, session resume.
- **`src/claude/stream-processor.ts`** — Transforms the raw SDK message stream into `CardState` objects for display. Tracks tool calls, response text, session ID, cost/duration. Also extracts image file paths and plan file paths from tool outputs.
- **`src/feishu/doc-reader.ts`** — Reads Feishu documents (docx/wiki) and converts Feishu blocks back to Markdown. Reverse of `markdown-to-blocks.ts`. Used by the `lark-doc` skill.
- **`src/claude/session-manager.ts`** — In-memory sessions keyed by `chatId`. Each session has a fixed working directory (from bot config) and Claude session ID. Sessions expire after 24 hours.
- **`src/feishu/card-builder.ts`** — Builds Feishu interactive card JSON. Cards have color-coded headers (blue=thinking/running, green=complete, red=error), tool call lists, markdown response content, and stats (cost/duration). Content truncated at 28KB.
- **`src/feishu/message-sender.ts`** — Feishu API wrapper for sending/updating cards, uploading/downloading images, sending text.
- **`src/bridge/rate-limiter.ts`** — Throttles card updates to avoid Feishu API rate limits (default 1.5s interval). Keeps only the latest pending update.
- **`src/api/peer-manager.ts`** — Manages cross-instance bot discovery and task forwarding. Polls peer MetaBot instances every 30s, caches their bot lists, supports qualified name routing (`peerName/botName`). Anti-loop via `X-MetaBot-Origin` header.
- **`src/web/ws-server.ts`** — WebSocket server for the Web UI. Handles upgrade on `/ws`, token auth via `?token=`, heartbeat, and routes `chat`/`stop`/`answer` messages. Also serves static files from `dist/web/` for the SPA.

### Outputs Directory Pattern

When Claude produces output files (images, PDFs, documents, etc.), they are automatically sent to the user in Feishu:

1. **Per-chat outputs directory** — Before each execution, a fresh directory is created at `/tmp/metabot-outputs/<chatId>/`.
2. **System prompt injection** — Claude is told about the directory via `systemPrompt.append`, instructing it to `cp` output files there.
3. **Post-execution scan** — After execution completes, the bridge scans the directory and sends all files found.
4. **File type routing** — Images (png/jpg/gif/etc.) are sent via `im.v1.image.create`, other files (pdf/docx/zip/etc.) via `im.v1.file.create`.
5. **Size limits** — Images up to 10MB, other files up to 30MB (Feishu API limits).
6. **Fallback** — The old image detection (Write tool file_path tracking + response text regex) still works as a fallback for images not placed in the outputs directory.

Key module: **`src/bridge/outputs-manager.ts`** — Encapsulates the outputs dir lifecycle (prepare, scan, cleanup, file type mapping).

### Wiki Sync (MetaMemory → Feishu Wiki)

One-way sync from MetaMemory documents to a Feishu Wiki space. The folder tree in MetaMemory maps to wiki nodes; each document becomes a Feishu docx page. Content change detection uses hash comparison for incremental sync.

**Key modules:**
- **`src/sync/doc-sync.ts`** — Core sync service. `DocSync` class with `syncAll()` (full sync), `syncDocument(docId)` (incremental), and `startAutoSync()` (event-driven). Manages wiki space creation, folder node hierarchy, document content writing via docx block API.
- **`src/sync/sync-store.ts`** — SQLite persistence for sync mappings (MetaMemory path ↔ Feishu node token). Tables: `sync_config`, `document_mappings`, `folder_mappings`.
- **`src/sync/markdown-to-blocks.ts`** — Converts Markdown to Feishu document block structures. Handles headings, code blocks, lists, tables, quotes, todos, inline formatting.
- **`src/memory/memory-events.ts`** — EventEmitter singleton (`memoryEvents`) that emits change events when MetaMemory documents/folders are created, updated, or deleted. Used by `DocSync.startAutoSync()` to trigger automatic wiki sync.

**Auto-sync:** When MetaMemory content changes, wiki sync triggers automatically (5-second debounce). Multiple rapid changes are coalesced. Incremental sync for 1-10 docs, full sync fallback for bulk changes or folder structure changes. Manual `/sync` still available.

**Feishu commands:** `/sync` (trigger full sync), `/sync status` (show stats).

**API endpoints:** `POST /api/sync` (trigger), `GET /api/sync` (status), `POST /api/sync/document` (single doc sync), `GET /api/feishu/document` (read Feishu doc).

**Environment variables:**
- `FEISHU_SERVICE_APP_ID` / `FEISHU_SERVICE_APP_SECRET` — Dedicated Feishu app for wiki sync & doc reader (falls back to first Feishu bot if not set)
- `WIKI_SYNC_ENABLED` — Set to `false` to disable (default: enabled when service app or Feishu bots exist)
- `WIKI_SPACE_NAME` — Wiki space name (default: `MetaMemory`)
- `WIKI_SYNC_THROTTLE_MS` — Delay between API calls (default: 300ms)
- `WIKI_AUTO_SYNC` — Set to `false` to disable auto-sync (default: enabled when wiki sync is configured)
- `WIKI_AUTO_SYNC_DEBOUNCE_MS` — Debounce delay for auto-sync (default: 5000ms)

**Required Feishu permissions:** `wiki:wiki`, `docx:document`, `docx:document:readonly`, `drive:drive` — must be added in the Feishu Developer Console.

### Feishu Document Reading

Read Feishu documents (standalone docx and wiki pages) and convert them to Markdown. Now handled by the `lark-doc` skill via lark-cli.

**Key module:** `src/feishu/doc-reader.ts` — `FeishuDocReader` class that fetches blocks via `docx.v1.documentBlock.list` and converts them to Markdown (reverse of `markdown-to-blocks.ts`).

### Voice API & Call Mode

`POST /api/voice` — Server-side STT + Agent execution + optional TTS. Accepts raw audio body (m4a, wav, webm, mp3, ogg — max 100 MB). Config via query params: `botName`, `chatId`, `language`, `stt` (doubao/whisper), `tts` (doubao/openai/elevenlabs), `ttsVoice`, `sendCards`, `voiceMode`. Defaults to Doubao for both STT and TTS when Volcengine keys are configured.

**Voice mode (`voiceMode=true`)**: Prepends a concise-response instruction to the prompt and limits agent execution to `maxTurns=1` for faster responses. Designed for real-time phone call interaction — responses are 1-2 spoken sentences, no tool use, no markdown.

**Web Call Mode**: The web UI (`ChatView.tsx`) includes a phone call overlay activated by the phone icon. Features:
- **Voice Activity Detection (VAD)** — Uses Web Audio API `AnalyserNode` to detect speech. Auto-stops recording after 1.8s of silence.
- **Auto-cycling** — Record → process → play response → auto-record again (like a real phone call).
- **Mobile audio playback** — Uses `AudioContext` created during user gesture (tap) to bypass iOS/Android autoplay restrictions. Falls back to HTML Audio element.
- **Status feedback** — Shows "Listening...", "Speaking..." (user detected), "Thinking...", "Speaking..." (AI response) phases.

**Key module:** `src/api/voice-handler.ts` — Doubao/Whisper transcription, agent execution via `bridge.executeApiTask()`, Doubao/OpenAI/ElevenLabs TTS.

**Environment:** `VOLCENGINE_TTS_APPID` + `VOLCENGINE_TTS_ACCESS_KEY` (for Doubao STT + TTS, recommended), `OPENAI_API_KEY` (fallback for Whisper STT + OpenAI TTS), `ELEVENLABS_API_KEY` (optional for ElevenLabs TTS), `VOICE_MODEL` (optional, override Claude model for voice mode).

### Plan Mode Display

When Claude enters plan mode and writes a plan to `.claude/plans/*.md`, the plan content is automatically sent to the Feishu user as a separate card message when `ExitPlanMode` is triggered. This is handled by `StreamProcessor` tracking plan file paths and `MessageBridge.sendPlanContent()` reading and sending the file.

### Skill Hub (Cross-Bot Skill Sharing)

A centralized skill registry that allows bots to publish, discover, and install skills across MetaBot instances.

**Architecture**: SQLite + FTS5 store (same pattern as MetaMemory/SyncStore). Skills are stored with SKILL.md content + optional `references/` tar bundle. Cross-instance discovery via PeerManager polling.

**Key modules:**
- **`src/api/skill-hub-store.ts`** — `SkillHubStore` class with SQLite backend. FTS5 full-text search across name, description, tags, and content. Methods: `publish()` (upsert, bumps version), `get()`, `list()`, `search()`, `remove()`, `getContent()`.
- **`src/api/routes/skill-hub-routes.ts`** — REST API endpoints for skill CRUD, publish-from-bot, install, and search.
- **`src/api/skills-installer.ts`** — `installSkillFromHub()` writes SKILL.md + extracts references tar to a bot's `.claude/skills/` directory.
- **`src/skills/skill-hub/SKILL.md`** — Bot-facing skill for autonomous skill discovery and installation.

**API endpoints:**
- `GET /api/skills` — List all skills (local + peer)
- `GET /api/skills/search?q=` — Full-text search
- `GET /api/skills/:name` — Get skill details (falls back to peers)
- `POST /api/skills` — Publish a skill directly (with skillMd in body)
- `POST /api/skills/:name/publish-from-bot` — Publish from a bot's working directory
- `POST /api/skills/:name/install` — Install a skill to a bot
- `DELETE /api/skills/:name` — Remove a skill

**CLI (`mb` shortcut):**
```bash
mb skills                                  # List all skills
mb skills search <query>                   # Search by keyword
mb skills get <name>                       # Get skill details
mb skills publish <botName> <skillName>    # Publish a bot's skill
mb skills install <skillName> <botName>    # Install to a bot
mb skills remove <name>                    # Unpublish
```

**Cross-instance**: PeerManager fetches skills alongside bots during 30s polling. Peer skills appear in list/search results with `peerName`/`peerUrl` fields. Install from peer: `mb skills install <skill> <bot> peer:<peerName>`.

### Session Isolation

Sessions are keyed by `chatId` (not `userId`), so each group chat and DM gets its own independent session, working directory, and conversation history. Group chats with exactly 2 members (1 user + 1 bot) are treated like DMs — no @mention required. This lets users "fork" a bot by creating multiple small group chats, each with its own session. The member count is cached for 5 minutes to avoid excessive API calls.

### Web Platform

A full-featured React SPA served at `/web/` with real-time WebSocket streaming. No external CSS framework — hand-crafted "Midnight Luxe" design system.

**URL**: `http://server:9100/web/` — no auth required for static files; WebSocket auth via `?token=API_SECRET`.

**Architecture**: WebSocket (`/ws`) → `ws-server.ts` → `MessageBridge.executeApiTask(onUpdate, onQuestion)` → streaming CardState back to browser. Reuses existing bot registry — talk to any Feishu/Telegram bot from the web.

**Frontend stack**: React 19 + Vite + Zustand + react-markdown. Source in `web/`, builds to `dist/web/`.

**Features**: Real-time streaming chat with tool call display, Markdown + syntax highlighting, interactive pending questions, session management, MetaMemory browser, phone call mode (voice with VAD), dark/light theme, responsive design.

**Key frontend files:**
- **`web/src/store.ts`** — Zustand store (auth, sessions, bots, theme, navigation)
- **`web/src/hooks/useWebSocket.ts`** — WebSocket with auto-reconnect + exponential backoff
- **`web/src/components/ChatView.tsx`** — Main chat interface with streaming + phone call overlay (VAD, auto-cycling, Web Audio playback)
- **`web/src/components/MemoryView.tsx`** — MetaMemory document browser
- **`web/src/theme.css`** — Complete design system with CSS custom properties

**Static file serving**: Hashed assets (`/web/assets/*-<hash>.js`) get `Cache-Control: immutable` (1 year). `index.html` gets `no-cache`. Missing assets return 404 (not SPA fallback) to prevent stale-cache white-screen issues.

**Dev workflow**: Run `cd web && npm run dev` for Vite dev server (port 5173) with API/WS proxy to 9100. Production: `npm run build:web` builds to `dist/web/`, served by MetaBot's HTTP server.

## Configuration

### Single-Bot Mode (default)

All config is via environment variables in `.env` (see `.env.example`). Required: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`. The Feishu app must have bot capability, WebSocket event mode, and `im.message.receive_v1` event subscription.

### Multi-Bot Mode

Set `BOTS_CONFIG=./bots.json` (or any path) to run multiple Feishu bots in a single process. Each bot gets its own Feishu app credentials, working directory, and WebSocket connection. See `bots.example.json` for the file format.

Per-bot config fields (JSON array entries):
- **`name`** (required) — Bot identifier, used in log context
- **`feishuAppId`** / **`feishuAppSecret`** (required) — Feishu app credentials
- **`defaultWorkingDirectory`** (required) — Fixed working directory for Claude sessions
- **`allowedTools`** — Claude tools whitelist (defaults to env var or `Read,Edit,Write,Glob,Grep,Bash`)
- **`maxTurns`** / **`maxBudgetUsd`** / **`model`** — Claude execution limits (defaults from env vars)
- **`outputsBaseDir`** — Base directory for output files

When `BOTS_CONFIG` is set, `FEISHU_APP_ID` / `FEISHU_APP_SECRET` env vars are ignored. Other env vars (`CLAUDE_MAX_TURNS`, `LOG_LEVEL`, etc.) still serve as defaults for any bot field not specified in JSON.

Sessions are isolated per `chatId` with no collision between bots since each bot has its own Feishu app and receives only its own messages.

### MetaMemory Integration

Knowledge persistence is handled by an external **MetaMemory server** (FastAPI + SQLite). The server stores documents as Markdown in a folder tree with full-text search (FTS5).

- **Server URL**: Configured via `META_MEMORY_URL` env var (default: `http://localhost:8100`)
- **Claude Code Skill**: Claude autonomously reads/writes memory documents via the `metamemory` skill (installed at `~/.claude/skills/metamemory/SKILL.md`). When users say "remember this" or Claude wants to persist knowledge, it calls the memory API via curl.
- **Feishu commands**: `/memory list`, `/memory search <query>`, `/memory status` — quick queries via `MemoryClient` without spawning Claude.
- **Web UI**: Browse documents at `http://localhost:8100` — folder tree, markdown rendering, search.
- **Server repo**: `xvirobotics/metamemory` — independent project with Docker deployment.

## Prerequisites

Before running the service, ensure:

1. **Node.js 20+** is installed.
2. **At least one engine CLI is installed and authenticated** — MetaBot spawns the selected engine's CLI as a subprocess. Install only the engine(s) you intend to use; each bot picks one via `engine` in its config.

   **Claude Code (default)** — `engine: "claude"`
   - Install: `npm install -g @anthropic-ai/claude-code`
   - Authenticate (one of):
     - **OAuth login (recommended)**: Run `claude login` in a standalone terminal and complete the browser flow.
     - **API Key**: Set `ANTHROPIC_API_KEY=sk-ant-...` in `.env` or your shell environment.
   - Verify: Run `claude --version` and `claude "hello"` in a standalone terminal.
   - **Important**: You cannot run `claude login` or `claude auth status` from inside a Claude Code session (nested sessions are blocked). Always use a separate terminal.

   **Kimi Code** — `engine: "kimi"`
   - Install: `npm install -g @moonshot-ai/kimi-code`
   - Authenticate: `kimi login` (OAuth, uses your Moonshot subscription) or set `KIMI_API_KEY` in `.env`.
   - Verify: `kimi --version`.

   **Codex CLI** — `engine: "codex"`
   - Install the Codex CLI (see the upstream project README for platform-specific binaries).
   - Authenticate: `codex login` in a standalone terminal, or configure a profile / API key in `~/.codex/config.toml`.
   - Verify: `codex exec --help`.
   - Optional per-bot overrides: `codex.model`, `codex.profile`, `codex.approvalPolicy` (`untrusted` | `on-failure` | `on-request` | `never`), `codex.sandbox` (`read-only` | `workspace-write` | `danger-full-access`), `codex.extraArgs` (extra argv passed verbatim to `codex exec`), `codex.env` (extra env vars for the subprocess). `CODEX_EXECUTABLE_PATH` env var overrides auto-detection; `CODEX_APPROVAL_POLICY` / `CODEX_SANDBOX` provide global defaults.
   - Session continuity uses `codex exec resume <thread_id>` — MetaBot stores the Codex thread id per `chatId` just like Claude sessions.
   - Interactive tool approvals (`sendAnswer` / `resolveQuestion`) are **not** supported under Codex — use `approvalPolicy: "never"` and a sandbox level you trust, since the bridge cannot surface approval prompts back to Feishu.

3. **Feishu app is configured** — See the setup guide below.

## HTTPS Setup (Required for Web Voice Mode)

The Web UI's phone call mode requires HTTPS for microphone access (`getUserMedia`). The recommended approach is [Caddy](https://caddyserver.com/) as a reverse proxy — it handles Let's Encrypt certificates automatically.

### Step 1: Install Caddy

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy
```

### Step 2: Configure DNS

Add an A record for your domain (e.g. `metabot.xvirobotics.com`) pointing to your server's public IP. Wait for DNS propagation (check with `host <domain> 1.1.1.1`).

### Step 3: Configure Caddy

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
metabot.yourdomain.com {
    reverse_proxy localhost:9100
}
EOF
sudo systemctl restart caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates. Ports 80 and 443 must be open. Check status with `sudo journalctl -u caddy` — look for "certificate obtained successfully".

### Step 4: Access

Open `https://metabot.yourdomain.com/web/` in a browser. The phone call button in Chat now has microphone access.

**Note**: WebSocket connections (`/ws`) are automatically proxied by Caddy. No additional WebSocket configuration is needed.

## Feishu App Setup Guide (飞书机器人配置)

This is the step-by-step procedure to configure a Feishu bot for this bridge service. Can be performed via browser automation or manually.

### Step 1: Create the App

1. Go to **飞书开放平台开发者控制台**: https://open.feishu.cn/app
2. Click **"Create Custom App"**
3. Fill in:
   - **Name**: e.g. "Claude Code"
   - **Description**: e.g. "Feishu to Claude Code bridge bot"
   - **Icon**: Pick any icon and color
4. Click **Create**

### Step 2: Record Credentials

1. In the app dashboard, go to **Credentials & Basic Info** (left sidebar)
2. Copy the **App ID** (e.g. `cli_xxxx`) and **App Secret**
3. These go into `.env` as `FEISHU_APP_ID` and `FEISHU_APP_SECRET`

### Step 3: Add Bot Capability

1. Go to **Add Features** (left sidebar under Features)
2. Find **Bot** and click **"+ Add"**
3. This enables the bot feature and adds a "Bot" menu in the sidebar

### Step 4: Configure Permissions

1. Go to **Permissions & Scopes** (left sidebar under Development Configuration)
2. Click **"Add permission scopes to app"** (blue button)
3. In the popup dialog, search for `im:message`
4. Check these two scopes:
   - **`im:message`** — Read and send messages in private and group chats
   - **`im:message:readonly`** — Read messages in private and group chats
   - **`im:resource`** — Upload images and files (needed to send output files back to chat)
   - **`im:chat:readonly`** — Read chat info (needed for 2-member group detection)
5. Click **"Add Scopes"**

### Step 5: Configure Events (requires running service)

> **IMPORTANT**: The subscription mode "persistent connection" requires the bot service to be running when you save. Start the service first (`npm run dev`), then configure this step.

1. Go to **Events & Callbacks** (left sidebar)
2. Click the edit icon next to **Subscription mode**
3. Select **"Receive events through persistent connection"** (Recommended)
4. Click **Save** — Feishu will validate the WebSocket connection
5. Click **"Add Events"** (now enabled)
6. Search for `im.message.receive`
7. Check **"Message received"** (`im.message.receive_v1`)
8. Click **Confirm**
9. When prompted for suggested scopes, click **"Add Scopes"** to add the recommended "Obtain private messages sent to the bot" scope

### Step 6: Publish the App

1. Click **"Create Version"** in the top banner (or go to Version Management & Release)
2. Fill in:
   - **App version**: e.g. "1.0.0"
   - **Update Notes**: e.g. "Initial release"
3. Default features should be "Bot" for both mobile and desktop
4. Click **Save**, then **Publish** in the confirmation dialog
5. If the org allows auto-approval for small apps, it goes live instantly

### Step 7: Test

1. Open Feishu Messenger
2. Search for your bot name (e.g. "Claude Code")
3. Send a test message
4. The bot should respond with a streaming card showing Claude's response

## Troubleshooting

### "Error: Claude Code process exited with code 1"

The bot starts but replies with this error when you message it. This means the Agent SDK's subprocess (`claude`) failed to launch properly.

**Cause**: Claude CLI is not authenticated. The SDK spawns `claude` as a child process — if it has no valid credentials, it exits immediately with code 1.

**Fix** (run in a **separate terminal**, not inside Claude Code):

```bash
# Option A: OAuth login
claude login

# Option B: API key — add to .env
echo 'ANTHROPIC_API_KEY=sk-ant-your-key' >> /path/to/metabot/.env
```

Then restart the service:

```bash
pkill -f "tsx src/index.ts"
cd /path/to/metabot && npm run dev
```

### Service won't connect to Feishu

If the service starts but Feishu events don't arrive:

1. Ensure the Feishu app event subscription mode is **"persistent connection"** (WebSocket), not HTTP callback.
2. The service must be running **before** you save the event subscription config — Feishu validates the WS connection on save.
3. Check that `im.message.receive_v1` event is subscribed.
4. Ensure the app version is **published and enabled** in the Feishu dev console.

### Bot doesn't reply in group chats

The bot only responds when **@mentioned** in group chats. In DMs it replies to all messages. This is by design in `event-handler.ts`.

## Branching Strategy

Always develop on the `dev` branch (or feature branches created from `dev`). Never work directly on `main`.

- **`dev`** is the active development branch. All day-to-day work happens here.
- **`main`** is the stable branch. Only receives merges from `dev` or PR merges.
- When starting work, ensure you are on `dev` (`git checkout dev`).
- After merging a PR to `main`, sync back: `git checkout dev && git merge main`.

## Feature Completion Workflow

When implementing a feature or fixing a bug, follow this end-to-end workflow unless the user says otherwise:

1. **Build & Test** — Run `npm run build`, `npm test`, `npm run lint` and fix any failures before proceeding.
2. **Update docs** — Update README.md, README_zh.md, and CLAUDE.md if the change affects user-facing behavior, API surface, CLI commands, or architecture.
3. **Commit** — Create a descriptive commit on the current branch.
4. **Push & PR** — Push the branch and create a PR to `main` via `gh pr create`.
5. **CI** — Wait for CI checks to pass (check with `gh pr checks`). Fix any failures.
6. **Merge** — Once CI is green, merge via `gh pr merge --squash --delete-branch`.
7. **Sync dev** — After merge, sync dev: `git checkout dev && git merge main && git push`.

