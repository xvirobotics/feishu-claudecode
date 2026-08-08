# Architecture

MetaBot is a Node.js >= 22.19 TypeScript ESM monorepo. The Bridge connects
Feishu/Lark, Telegram, Slack, WeChat, and Web clients to an engine-neutral message
pipeline; each bot or chat can run Codex, Kimi Code, or Claude compatibility.

## System Overview

```text
Feishu/Lark · Telegram · Slack · WeChat · Web
                    │
          Event and API adapters
                    │
             MessageBridge
       commands · tasks · sessions · media
                    │
              Engine Router
          ┌─────────┼──────────┐
          │         │          │
   Codex CLI    Kimi Code    Claude Code
   exec JSONL   local Server  compatibility
   + resume     API 0.27+     CLI / SDK
          └─────────┼──────────┘
                    │
     shared stream/card event model
                    │
        channel cards and Web updates

Personal Core (:9200)        Bridge (:9100)
Agents · Memory · Skills     IM · local API · WebSocket
T5T · Teams · Chat      ↔     sessions · files · peers
```

Codex is the default engine and currently uses `codex exec --json` plus
`codex exec resume`; the public adapter does not yet use Codex app-server or
native mid-turn steering. Kimi Code 0.27+ uses its official loopback Server API
for durable Sessions, snapshots, questions, tools, subagents, goals, and
completion state. Feishu mid-turn steering is not exposed in this release.
Claude remains an explicit
compatibility engine for existing bots and workspaces.

## Three Pillars

| Pillar                 | Components                          | What they do                                                                                          |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Supervised**         | IM Bridge + Web UI                  | Stream tool activity and state so the user can monitor, stop, answer, and redirect supported engines. |
| **Self-Improving**     | MetaMemory + Skills + T5T           | Preserve reusable knowledge, workflows, and project checkpoints outside a single model session.       |
| **Agent Organization** | Agent Teams + Agent Bus + Scheduler | Coordinate durable teammates, tasks, runs, cross-agent messages, and optional recurring work.         |

## Message Flow

**IM channels:**

```text
Channel event
  → EventHandler (parse, media, exact @Bot routing)
  → MessageBridge (commands, queue, task/session state)
  → Engine.createExecutor() (Codex, Kimi, or Claude compatibility)
  → engine output translated into shared SDKMessage/CardState events
  → throttled streaming card or channel response
```

**Personal Web UI:**

```text
Browser
  → token-authenticated Core API (:9200)
  → Chat / Agents / Memory / Skills / T5T / Teams
  → registered Bridge agent
  → selected engine and workspace
```

The Core and Bridge are separate PM2 applications in the personal-edition
package. Core authentication uses the local Bearer token; Bridge channel
credentials stay with the Bridge.

## Engine Boundary

`src/engines/index.ts` resolves the configured engine, defaulting to Codex.
All adapters implement the shared `Engine` / `Executor` contract and translate
their native protocol into the event shape consumed by the Bridge and card
renderer.

| Engine               | Native protocol                     | Session behavior                                          |
| -------------------- | ----------------------------------- | --------------------------------------------------------- |
| Codex                | `codex exec --json` JSONL           | `codex exec resume` continues a saved session             |
| Kimi Code            | Official `/api/v1` local Server API | Durable Kimi Sessions and atomic frontend snapshots       |
| Claude compatibility | Claude CLI / Agent SDK              | Existing Claude sessions and persistent-executor behavior |

## Key Modules

| Module                                         | Description                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/index.ts`                                 | Entrypoint; creates channel clients, registries, stores, and shutdown handlers.       |
| `src/config.ts`                                | Loads engine, channel, Core, workspace, and per-bot configuration.                    |
| `src/bridge/message-bridge.ts`                 | Core orchestrator for commands, queues, tasks, sessions, media, and engine execution. |
| `src/engines/index.ts`                         | Engine selection and shared boundary.                                                 |
| `src/engines/codex/executor.ts`                | Spawns Codex exec/resume and translates JSONL events.                                 |
| `src/engines/kimi/daemon-client.ts`            | Starts or connects to the Kimi Code local Server API.                                 |
| `src/engines/kimi/executor.ts`                 | Drives Kimi Sessions, snapshots, steering, questions, goals, and completion.          |
| `src/engines/claude/`                          | Claude compatibility executor, session, and stream-processing code.                   |
| `src/feishu/event-handler.ts`                  | Feishu event parsing, media cache, group modes, and exact mention routing.            |
| `src/telegram/` / `src/slack/` / `src/wechat/` | Telegram, Slack, and WeChat channel adapters.                                         |
| `src/agent-teams/`                             | Durable local team, task, member, and run orchestration.                              |
| `packages/server/`                             | Personal Core HTTP backend and token authentication.                                  |
| `packages/web-ui/`                             | Personal Core browser application.                                                    |
