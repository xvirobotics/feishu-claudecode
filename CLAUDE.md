# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A bridge service that connects Feishu (Lark) Bot to the Claude Code Agent SDK. Users chat with Claude Code from Feishu (including mobile), with real-time streaming updates via interactive cards. Runs Claude in `bypassPermissions` mode since there's no terminal for interactive approval.

## Commands

```bash
npm run dev          # Development with tsx (hot reload)
npm run build        # TypeScript compile to dist/
npm start            # Run compiled output (dist/index.js)
```

No test framework is configured. No linter is configured.

## Architecture

The app is a TypeScript ESM project (`"type": "module"`, all imports use `.js` extensions). It connects to Feishu via WebSocket (long connection, no public IP needed) and calls Claude via the `@anthropic-ai/claude-agent-sdk`.

### Message Flow

```
Feishu WSClient → EventHandler (auth, parse, @mention filter) → MessageBridge → ClaudeExecutor → StreamProcessor → Feishu card updates
```

### Key Modules

- **`src/index.ts`** — Entrypoint. Creates Feishu WS client, fetches bot info for @mention detection, wires up the event dispatcher and bridge, handles graceful shutdown.
- **`src/config.ts`** — Loads all config from env vars (`.env` via dotenv). `Config` interface is the central type.
- **`src/feishu/event-handler.ts`** — Registers `im.message.receive_v1` on the Lark `EventDispatcher`. Handles auth checks, text/image parsing, @mention stripping, group chat filtering (only responds when @mentioned). Exports `IncomingMessage` type.
- **`src/bridge/message-bridge.ts`** — Core orchestrator. Routes commands (`/cd`, `/reset`, `/stop`, `/status`, `/help`), manages running tasks per chat (one task at a time per `chatId`), executes Claude queries with streaming card updates, handles image input/output, enforces 10-minute timeout.
- **`src/claude/executor.ts`** — Wraps `query()` from the Agent SDK as an async generator yielding `SDKMessage`. Configures permissionMode, allowedTools, MCP settings, session resume.
- **`src/claude/stream-processor.ts`** — Transforms the raw SDK message stream into `CardState` objects for display. Tracks tool calls, response text, session ID, cost/duration. Also extracts image file paths from tool outputs.
- **`src/claude/session-manager.ts`** — In-memory sessions keyed by `chatId`. Each session has a working directory and Claude session ID. Sessions expire after 24 hours. Changing working directory resets the session.
- **`src/feishu/card-builder.ts`** — Builds Feishu interactive card JSON. Cards have color-coded headers (blue=thinking/running, green=complete, red=error), tool call lists, markdown response content, and stats (cost/duration). Content truncated at 28KB.
- **`src/feishu/message-sender.ts`** — Feishu API wrapper for sending/updating cards, uploading/downloading images, sending text.
- **`src/bridge/rate-limiter.ts`** — Throttles card updates to avoid Feishu API rate limits (default 1.5s interval). Keeps only the latest pending update.

### Outputs Directory Pattern

When Claude produces output files (images, PDFs, documents, etc.), they are automatically sent to the user in Feishu:

1. **Per-chat outputs directory** — Before each execution, a fresh directory is created at `/tmp/feishu-claudecode-outputs/<chatId>/`.
2. **System prompt injection** — Claude is told about the directory via `systemPrompt.append`, instructing it to `cp` output files there.
3. **Post-execution scan** — After execution completes, the bridge scans the directory and sends all files found.
4. **File type routing** — Images (png/jpg/gif/etc.) are sent via `im.v1.image.create`, other files (pdf/docx/zip/etc.) via `im.v1.file.create`.
5. **Size limits** — Images up to 10MB, other files up to 30MB (Feishu API limits).
6. **Fallback** — The old image detection (Write tool file_path tracking + response text regex) still works as a fallback for images not placed in the outputs directory.

Key module: **`src/bridge/outputs-manager.ts`** — Encapsulates the outputs dir lifecycle (prepare, scan, cleanup, file type mapping).

### Session Isolation

Sessions are keyed by `chatId` (not `userId`), so each group chat and DM gets its own independent session, working directory, and conversation history.

## Configuration

All config is via environment variables in `.env` (see `.env.example`). Required: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`. The Feishu app must have bot capability, WebSocket event mode, and `im.message.receive_v1` event subscription.

## Prerequisites

Before running the service, ensure:

1. **Node.js 18+** is installed.
2. **Claude Code CLI is installed and authenticated** — The Agent SDK spawns `claude` as a subprocess; it must be able to run independently.
   - Install: `npm install -g @anthropic-ai/claude-code`
   - Authenticate (one of):
     - **OAuth login (recommended)**: Run `claude login` in a standalone terminal and complete the browser flow.
     - **API Key**: Set `ANTHROPIC_API_KEY=sk-ant-...` in `.env` or your shell environment.
   - Verify: Run `claude --version` and `claude "hello"` in a standalone terminal to confirm it works.
   - **Important**: You cannot run `claude login` or `claude auth status` from inside a Claude Code session (nested sessions are blocked). Always use a separate terminal.
3. **Feishu app is configured** — See the setup guide below.

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
echo 'ANTHROPIC_API_KEY=sk-ant-your-key' >> /path/to/feishu-claudecode/.env
```

Then restart the service:

```bash
pkill -f "tsx src/index.ts"
cd /path/to/feishu-claudecode && npm run dev
```

### Service won't connect to Feishu

If the service starts but Feishu events don't arrive:

1. Ensure the Feishu app event subscription mode is **"persistent connection"** (WebSocket), not HTTP callback.
2. The service must be running **before** you save the event subscription config — Feishu validates the WS connection on save.
3. Check that `im.message.receive_v1` event is subscribed.
4. Ensure the app version is **published and enabled** in the Feishu dev console.

### Bot doesn't reply in group chats

The bot only responds when **@mentioned** in group chats. In DMs it replies to all messages. This is by design in `event-handler.ts`.

