# Architecture

← back to [CLAUDE.md](../../CLAUDE.md)

The app is a TypeScript ESM project (`"type": "module"`, all imports use `.js` extensions). It connects to Feishu via WebSocket (long connection, no public IP needed) and calls Claude via the `@anthropic-ai/claude-agent-sdk`.

## Message Flow

```
Feishu WSClient → EventHandler (parse, @mention filter) → MessageBridge → ClaudeExecutor → StreamProcessor → Feishu card updates
Web Browser → WebSocket (/ws) → ws-server.ts → MessageBridge.executeApiTask(onUpdate) → WebSocket push → React UI
```

## Key Modules

- **`src/index.ts`** — Entrypoint. Creates Feishu WS client, fetches bot info for @mention detection, wires up the event dispatcher and bridge, handles graceful shutdown.
- **`src/config.ts`** — Loads config. `BotConfig` is the per-bot type; `AppConfig` wraps bots, log, instance identity, memory, API, and peers. `loadAppConfig()` reads `BOTS_CONFIG` JSON file or falls back to single-bot mode from env vars. `METABOT_CLUSTER_URL` is added as a bootstrap peer when discovery is enabled.
- **`src/cluster/identity.ts`** — Loads or creates the stable MetaBot instance identity in `~/.metabot/identity.json` plus an Ed25519 keypair. Exposes `instanceId`, `instanceName`, cluster fields, discovery mode, and default memory namespace.
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
- **`src/api/peer-manager.ts`** — Manages cross-instance bot/skill discovery and task forwarding. Polls peer MetaBot instances every 30s, caches their bot and skill lists, supports qualified name routing (`peerName/botName`). Anti-loop via `X-MetaBot-Origin` header.
- **`src/web/ws-server.ts`** — WebSocket server for the Web UI. Handles upgrade on `/ws`, token auth via `?token=`, heartbeat, and routes `chat`/`stop`/`answer` messages. Also serves static files from `dist/web/` for the SPA.

## Outputs Directory Pattern

When Claude produces output files (images, PDFs, documents, etc.), they are automatically sent to the user in Feishu:

1. **Per-chat outputs directory** — Before each execution, a fresh directory is created at `/tmp/metabot-outputs/<chatId>/`.
2. **System prompt injection** — Claude is told about the directory via `systemPrompt.append`, instructing it to `cp` output files there.
3. **Post-execution scan** — After execution completes, the bridge scans the directory and sends all files found.
4. **File type routing** — Images (png/jpg/gif/etc.) are sent via `im.v1.image.create`, other files (pdf/docx/zip/etc.) via `im.v1.file.create`.
5. **Size limits** — Images up to 10MB, other files up to 30MB (Feishu API limits).
6. **Fallback** — The old image detection (Write tool file_path tracking + response text regex) still works as a fallback for images not placed in the outputs directory.

Key module: **`src/bridge/outputs-manager.ts`** — Encapsulates the outputs dir lifecycle (prepare, scan, cleanup, file type mapping).

## Wiki Sync (MetaMemory → Feishu Wiki)

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

## Feishu Document Reading

Read Feishu documents (standalone docx and wiki pages) and convert them to Markdown. Now handled by the `lark-doc` skill via lark-cli.

**Key module:** `src/feishu/doc-reader.ts` — `FeishuDocReader` class that fetches blocks via `docx.v1.documentBlock.list` and converts them to Markdown (reverse of `markdown-to-blocks.ts`).

## Voice API & Call Mode

`POST /api/voice` — Server-side STT + Agent execution + optional TTS. Accepts raw audio body (m4a, wav, webm, mp3, ogg — max 100 MB). Config via query params: `botName`, `chatId`, `language`, `stt` (doubao/whisper), `tts` (doubao/openai/elevenlabs), `ttsVoice`, `sendCards`, `voiceMode`. Defaults to Doubao for both STT and TTS when Volcengine keys are configured.

**Voice mode (`voiceMode=true`)**: Prepends a concise-response instruction to the prompt and limits agent execution to `maxTurns=1` for faster responses. Designed for real-time phone call interaction — responses are 1-2 spoken sentences, no tool use, no markdown.

**Web Call Mode**: The web UI (`ChatView.tsx`) includes a phone call overlay activated by the phone icon. Features:
- **Voice Activity Detection (VAD)** — Uses Web Audio API `AnalyserNode` to detect speech. Auto-stops recording after 1.8s of silence.
- **Auto-cycling** — Record → process → play response → auto-record again (like a real phone call).
- **Mobile audio playback** — Uses `AudioContext` created during user gesture (tap) to bypass iOS/Android autoplay restrictions. Falls back to HTML Audio element.
- **Status feedback** — Shows "Listening...", "Speaking..." (user detected), "Thinking...", "Speaking..." (AI response) phases.

**Key module:** `src/api/voice-handler.ts` — Doubao/Whisper transcription, agent execution via `bridge.executeApiTask()`, Doubao/OpenAI/ElevenLabs TTS.

**Environment:** `VOLCENGINE_TTS_APPID` + `VOLCENGINE_TTS_ACCESS_KEY` (for Doubao STT + TTS, recommended), `OPENAI_API_KEY` (fallback for Whisper STT + OpenAI TTS), `ELEVENLABS_API_KEY` (optional for ElevenLabs TTS), `VOICE_MODEL` (optional, override Claude model for voice mode).

## Plan Mode Display

When Claude enters plan mode and writes a plan to `.claude/plans/*.md`, the plan content is automatically sent to the Feishu user as a separate card message when `ExitPlanMode` is triggered. This is handled by `StreamProcessor` tracking plan file paths and `MessageBridge.sendPlanContent()` reading and sending the file.

## Skill Hub (Cross-Bot Skill Sharing)

A federated skill registry that allows bots to publish, discover, and install skills across MetaBot instances.

**Architecture**: SQLite + FTS5 store (same pattern as MetaMemory/SyncStore). Skills are stored with SKILL.md content + optional `references/` tar bundle plus owner instance metadata, visibility, and content hash. Cross-instance discovery via PeerManager polling.

**Key modules:**
- **`src/api/skill-hub-store.ts`** — `SkillHubStore` class with SQLite backend. FTS5 full-text search across name, description, tags, and content. Methods: `publish()` (upsert, bumps version and records content hash/owner metadata), `get()`, `list()`, `search()`, `remove()`, `getContent()`.
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

## Federated MetaMemory / Skill Hub Foundation

MetaBot keeps the user-facing names **MetaMemory** and **Skill Hub**. Internally, both are treated as markdown artifacts with metadata. The current foundation includes:

- Stable instance identity at `~/.metabot/identity.json`
- `GET /api/manifest` for instance identity, capabilities, endpoint paths, memory namespace, and local/peer counts
- `METABOT_MEMORY_NAMESPACE` defaulting to `/instances/<instanceId>`
- `MEMORY_INSTANCE_TOKEN` scoped writes to the instance namespace
- Skill owner metadata: `ownerInstanceId`, `ownerInstanceName`, `visibility`, `contentHash`
- `METABOT_CLUSTER_URL` bootstrap peer support

The detailed roadmap is in `docs/internal/federated-memory-skill-hub-plan.md`.

## Session Isolation

Sessions are keyed by `chatId` (not `userId`), so each group chat and DM gets its own independent session, working directory, and conversation history. Group chats with exactly 2 members (1 user + 1 bot) are treated like DMs — no @mention required. This lets users "fork" a bot by creating multiple small group chats, each with its own session. The member count is cached for 5 minutes to avoid excessive API calls.

## Web Platform

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
