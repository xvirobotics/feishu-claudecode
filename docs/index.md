# MetaBot

**Infrastructure for building a supervised, self-improving agent organization.**

[![CI](https://img.shields.io/github/actions/workflow/status/xvirobotics/metabot/ci.yml?branch=main&style=flat-square)](https://github.com/xvirobotics/metabot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=flat-square)](https://github.com/xvirobotics/metabot)

---

Claude Code and Kimi Code are the most capable AI coding agents — but they're both trapped in your laptop terminal.

MetaBot sets them free. It gives every agent a **Claude Code or Kimi Code brain** (native subscriptions work directly — no API key required), persistent shared memory, the ability to create new agents, and a communication bus. All accessible from Feishu or Telegram on your phone.

## Dual Engine: Claude Code ✕ Kimi Code

| | Claude Code (Anthropic) | Kimi Code (Moonshot) |
|---|---|---|
| **Subscription login** | ✅ `claude login` OAuth | ✅ `kimi login` OAuth |
| **API key fallback** | ✅ | ✅ |
| **Context window** | 200k (1M optional) | 256k |
| **Autonomous mode** | `bypassPermissions` | `yoloMode` (equivalent) |

Each bot picks its engine in `bots.json`. Frontend bot on Claude, backend bot on Kimi — totally fine. Cross-engine delegation through the Agent Bus is transparent to the caller. See [multi-bot config](configuration/multi-bot.md).

## Core Components

| Component | Description |
|-----------|-------------|
| **Dual Engine Kernel** | Each bot independently selects Claude Code or Kimi Code — full tool stack (Read/Write/Edit/Bash/Glob/Grep/WebSearch/MCP) in autonomous mode. |
| **MetaSkill** | Agent factory. `/metaskill ios app` generates a complete `.claude/` agent team (orchestrator + specialists + code-reviewer). |
| **MetaMemory** | Embedded SQLite knowledge store with full-text search and Web UI. Agents read/write Markdown documents across sessions. |
| **IM Bridge** | Chat with any agent from Feishu/Lark or Telegram (including mobile). Streaming cards with color-coded status. |
| **Web UI** | Browser-based chat at `/web/` with WebSocket streaming, phone call voice mode (VAD), MetaMemory browser, dark/light themes. [Learn more](features/web-ui.md) |
| **Voice Assistant** | Hands-free voice control via iOS Shortcuts (Jarvis mode) or Web UI phone call mode. Server-side STT + TTS. [Learn more](features/voice-jarvis.md) |
| **Agent Bus** | REST API on port 9100. Agents talk to each other via `mb talk`. Create/remove bots at runtime. |
| **Peers** | Federation system for cross-instance bot discovery and task routing. |
| **Task Scheduler** | One-time delays and recurring cron jobs. Timezone-aware, persists across restarts. |
| **CLI Tools** | `metabot`, `mm`, `mb` commands for management, memory, and agent bus. |

## Quick Install

=== "Linux / macOS"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
    ```

=== "Windows (PowerShell)"

    ```powershell
    irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
    ```

The installer walks you through: working directory, **engine choice (Claude / Kimi)**, subscription login, IM credentials, and auto-start with PM2.

[Get Started](getting-started/installation.md){ .md-button .md-button--primary }
[View on GitHub](https://github.com/xvirobotics/metabot){ .md-button }
