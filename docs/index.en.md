# MetaBot

**Infrastructure for building a supervised, self-improving agent organization.**

[![CI](https://img.shields.io/github/actions/workflow/status/xvirobotics/metabot/ci.yml?branch=main&style=flat-square)](https://github.com/xvirobotics/metabot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=flat-square)](https://github.com/xvirobotics/metabot)

---

Claude Code is the most capable AI coding agent — but it's trapped in your laptop terminal.

MetaBot sets it free. It gives every agent a Claude Code brain, persistent shared memory, the ability to create new agents, and a communication bus. All accessible from Feishu or Telegram on your phone.

## Core Components

| Component | Description |
|-----------|-------------|
| **Claude Code Kernel** | Every bot is a full Claude Code instance — Read, Write, Edit, Bash, Glob, Grep, WebSearch, MCP, and more. `bypassPermissions` mode for autonomous operation. |
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

The installer walks you through: working directory, Claude auth, IM credentials, and auto-start with PM2.

[Get Started](getting-started/installation.md){ .md-button .md-button--primary }
[View on GitHub](https://github.com/xvirobotics/metabot){ .md-button }
