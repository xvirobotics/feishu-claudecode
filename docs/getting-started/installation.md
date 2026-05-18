# Installation

## One-Line Install

=== "Linux / macOS"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
    ```

=== "Windows (PowerShell)"

    ```powershell
    irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
    ```

The installer walks you through: working directory → Claude auth → IM credentials → auto-start with PM2.

## Update

Already installed? One command to pull, rebuild, update skills, and restart:

```bash
metabot update
```

If `lark-cli` or Feishu/Lark skills were already installed, `metabot update` updates them too and syncs them into the bot workspace.

## Manual Install

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # edit with your bot configs
cp .env.example .env              # edit global settings
npm run dev
```

## Prerequisites

1. **Node.js 20+** is installed.
2. **Claude Code CLI is installed and authenticated** — The Agent SDK spawns `claude` as a subprocess; it must be able to run independently.
    - Install: `npm install -g @anthropic-ai/claude-code`
    - Authenticate (one of):
        - **OAuth login (recommended)**: Run `claude login` in a standalone terminal and complete the browser flow.
        - **API Key**: Set `ANTHROPIC_API_KEY=sk-ant-...` in `.env` or your shell environment.
    - Verify: Run `claude --version` and `claude "hello"` in a standalone terminal to confirm it works.

    !!! warning
        You cannot run `claude login` or `claude auth status` from inside a Claude Code session (nested sessions are blocked). Always use a separate terminal.

3. **IM platform configured** — See [Quick Setup](quick-setup.md) or [Feishu App Setup](feishu-app-setup.md).

## Windows Notes

The PowerShell installer auto-detects `winget`/`choco`/`scoop` for Node.js installation. CLI tools (`mm`, `mb`, `metabot`, `fd`) are installed with `.cmd` wrappers and require [Git for Windows](https://git-scm.com) (provides Git Bash).
