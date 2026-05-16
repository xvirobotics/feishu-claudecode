# MetaBot Workspace

This workspace is managed by **MetaBot** — an AI assistant accessible via Feishu/Telegram that runs the Claude Code, Kimi, or Codex agent engine with full tool access. The bot's engine is configured per-bot in `bots.json` (`engine: "claude" | "kimi" | "codex"`).

## Available Skills

### /metamemory — Shared Knowledge Store
Read and write persistent memory documents across sessions. Use the `mm` shell shortcut for quick operations:

```bash
mm search <query>       # Search documents
mm get <doc_id>         # Get document by ID
mm list [folder_id]     # List documents
mm folders              # Browse folder tree
```

For full API (create with tags, update, delete), use the `/metamemory` skill.

### /metabot — Agent Bus & Bot Management
Use the `mb` shell shortcut for quick operations:

```bash
mb bots                                    # List all bots (local + peer)
mb talk <botName> <chatId> <prompt>        # Delegate task to a bot
mb peers                                   # List peers and their status
mb skills                                  # Shared skills (Skill Hub)
mb health                                  # Health check
```

For full API (create bots, sendCards, Skill Hub publish/install), use the `/metabot` skill.

### Scheduling (Claude Code native)

Prefer Claude Code's built-in scheduling tools for ad-hoc, session-scoped tasks — no MetaBot server hop, runs in-process, stops when the session ends:

- **`CronCreate`** — fire a prompt on a cron schedule (recurring or one-shot). Pass `durable: true` to persist across restarts. Example use cases: "remind me at 3pm", "every weekday at 9am summarize my inbox".
- **`/loop [interval] <prompt>`** — turn any task into a self-paced loop. Examples: `/loop 5m check the deploy`, `/loop check every PR` (dynamic mode — you pace yourself).

For **persistent server-side scheduling** that outlives the Claude session, is visible to other bots, and lives in MetaBot's PM2 process, install the optional `/metaschedule` skill (not installed by default). Copy `<METABOT_HOME>/src/skills/metaschedule/SKILL.md` into `~/.claude/skills/metaschedule/` (or the bot's `.claude/skills/`).

### /metaskill — AI Agent Team Generator (optional)

Not installed by default. Generates portable agent teams, individual agents, or custom skills (`CLAUDE.md` / `AGENTS.md` + SKILL files). Enable it by copying `<METABOT_HOME>/src/skills/metaskill/` into `~/.claude/skills/` (or the bot's `.claude/skills/`). Once installed:

```
/metaskill ios app          → generates a portable agent team
/metaskill a security agent → creates a single agent
/metaskill a deploy skill   → creates a custom skill
```

### Feishu / Lark CLI (Feishu bots only)

`lark-cli` is the official Feishu CLI tool with 200+ commands covering 11 business domains. It is pre-installed and configured for Feishu bots.

```bash
lark-cli docs +create --title "..." --markdown "..."    # Create document
lark-cli docs +fetch --doc "<url>"                       # Read document
lark-cli im +messages-send --chat-id oc_xxx --text "Hi"  # Send message
lark-cli calendar +agenda --as user                      # View calendar
lark-cli base records list ...                           # Query bitable
```

19 AI Agent Skills are installed (lark-doc, lark-im, lark-calendar, lark-sheets, lark-base, lark-task, lark-drive, lark-mail, lark-wiki, etc.) providing structured guidance for each domain. Claude/Kimi discover these under `.claude/skills`; Codex discovers the mirrored copies under `.codex/skills`.

## Guidelines

- **Search before creating** — always check if a file or document already exists before creating new ones.
- **Use metamemory** — when you discover important knowledge, project patterns, or user preferences, save them to memory so future sessions can benefit.
- **Output files** — when generating files the user needs (images, PDFs, reports), copy them to the outputs directory provided in the system prompt so they get sent to the chat automatically.
- **Be concise in chat** — responses appear as Feishu/Telegram cards with limited space. Keep answers focused and use markdown formatting.
