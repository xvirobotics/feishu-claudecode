# Architecture

MetaBot is a TypeScript ESM project that connects IM platforms (Feishu, Telegram) to the Claude Code Agent SDK.

## System Overview

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

## Three Pillars

| Pillar | Component | What it does |
|--------|-----------|-------------|
| **Supervised** | IM Bridge | Real-time streaming cards show every tool call. Humans see everything agents do. Access control via Feishu/Telegram platform settings. |
| **Self-Improving** | MetaMemory | Shared knowledge store. Agents write what they learn, other agents retrieve it. The organization gets smarter every day without retraining. |
| **Agent Organization** | MetaSkill + Scheduler + Agent Bus | One command generates a full agent team. Agents delegate tasks to each other. Scheduled tasks run autonomously. Agents can create new agents. |

## Message Flow

**IM (Feishu/Telegram):**

```
IM Client → EventHandler (parse, @mention filter)
         → MessageBridge (command routing, task management)
         → ClaudeExecutor (Agent SDK query)
         → StreamProcessor (card state tracking)
         → IM card updates (streaming)
```

**Web UI:**

```
Web Browser → WebSocket (/ws?token=API_SECRET)
           → ws-server.ts
           → MessageBridge.executeApiTask(onUpdate, onQuestion)
           → streaming CardState back to browser
```

## Key Modules

| Module | Description |
|--------|-------------|
| `src/index.ts` | Entrypoint. Creates IM clients, wires up event dispatch, handles graceful shutdown. |
| `src/config.ts` | Loads config from `bots.json` or env vars. |
| `src/feishu/event-handler.ts` | Parses Feishu events, filters @mentions, handles text/image. |
| `src/bridge/message-bridge.ts` | Core orchestrator. Routes commands, manages tasks per chat, executes Claude queries with streaming. |
| `src/claude/executor.ts` | Wraps `query()` from the Agent SDK as an async generator. |
| `src/claude/stream-processor.ts` | Transforms SDK messages into card state objects for display. |
| `src/claude/session-manager.ts` | In-memory sessions keyed by `chatId`. 24-hour expiry. |
| `src/feishu/card-builder.ts` | Builds Feishu interactive card JSON with color-coded headers. |
| `src/feishu/message-sender.ts` | Feishu API wrapper for sending/updating cards, uploading images. |
| `src/bridge/rate-limiter.ts` | Throttles card updates (1.5s default) to avoid API rate limits. |
| `src/api/peer-manager.ts` | Cross-instance bot discovery and task forwarding. |
| `src/api/voice-handler.ts` | Voice API: Doubao/Whisper STT, agent execution, Doubao/OpenAI/ElevenLabs TTS. |
| `src/web/ws-server.ts` | WebSocket server for Web UI. Token auth, heartbeat, static file serving. |
| `src/bridge/outputs-manager.ts` | Output file lifecycle (prepare, scan, cleanup, type routing). |
