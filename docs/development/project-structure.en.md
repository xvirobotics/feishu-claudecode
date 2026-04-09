# Project Structure

MetaBot is a TypeScript ESM project (`"type": "module"`, all imports use `.js` extensions).

## Directory Layout

```
metabot/
├── src/
│   ├── index.ts                    # Entrypoint
│   ├── config.ts                   # Configuration loader
│   ├── bridge/
│   │   ├── message-bridge.ts       # Core orchestrator
│   │   ├── rate-limiter.ts         # Card update throttling
│   │   └── outputs-manager.ts      # Output file lifecycle
│   ├── claude/
│   │   ├── executor.ts             # Agent SDK wrapper
│   │   ├── stream-processor.ts     # SDK message → card state
│   │   └── session-manager.ts      # Session store
│   ├── feishu/
│   │   ├── event-handler.ts        # Feishu event parsing
│   │   ├── card-builder.ts         # Interactive card builder
│   │   ├── message-sender.ts       # Feishu API client
│   │   └── doc-reader.ts           # Document → Markdown
│   ├── telegram/
│   │   └── ...                     # Telegram bot integration
│   ├── web/
│   │   └── ws-server.ts            # WebSocket server + static files
│   ├── api/
│   │   ├── http-server.ts          # REST API server
│   │   ├── voice-handler.ts        # Voice API (STT + Agent + TTS)
│   │   ├── bot-registry.ts         # Bot registry
│   │   └── peer-manager.ts         # Cross-instance federation
│   ├── memory/
│   │   ├── memory-client.ts        # MetaMemory HTTP client
│   │   └── memory-events.ts        # Change event emitter
│   ├── sync/
│   │   ├── doc-sync.ts             # Wiki sync service
│   │   ├── sync-store.ts           # SQLite persistence
│   │   └── markdown-to-blocks.ts   # MD → Feishu blocks
│   ├── skills/
│   │   └── metabot/
│   │       └── SKILL.md            # Agent Bus skill
│   └── utils/
│       └── logger.ts               # Logging
├── bin/
│   ├── metabot                     # Service management CLI
│   ├── mb                          # Agent Bus CLI
│   ├── mm                          # MetaMemory CLI
│   └── doubao-tts                  # Doubao TTS CLI
├── web/                            # Web UI source (React + Vite)
│   ├── src/
│   │   ├── components/             # React components
│   │   ├── hooks/                  # Custom hooks (WebSocket)
│   │   ├── store.ts                # Zustand state management
│   │   └── theme.css               # Design system
│   └── vite.config.ts
├── tests/                          # Vitest test files
├── docs/                           # Documentation (MkDocs)
├── dist/                           # Compiled output (includes dist/web/)
├── mkdocs.yml                      # MkDocs configuration
├── bots.example.json               # Multi-bot config example
├── .env.example                    # Environment config example
└── package.json
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Claude Code Agent SDK |
| `@anthropic-ai/claude-code` | Claude Code CLI (peer dependency) |
| `@larksuiteoapi/node-sdk` | Feishu/Lark SDK |
| `tsx` | TypeScript execution (dev) |
| `vitest` | Test framework |
