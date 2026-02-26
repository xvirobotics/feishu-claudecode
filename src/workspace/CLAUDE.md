# MetaBot Workspace

This workspace is managed by **MetaBot** — an AI assistant accessible via Feishu/Telegram that runs Claude Code with full tool access.

## Available Skills

### /metaskill — AI Agent Team Generator
Create AI agent teams, individual agents, or custom skills for any project.

```
/metaskill ios app          → generates full .claude/ agent team
/metaskill a security agent → creates a single agent
/metaskill a deploy skill   → creates a custom slash command
```

### /metamemory — Shared Knowledge Store
Read and write persistent memory documents across sessions. Use the `mm` shell shortcut for quick operations:

```bash
mm search <query>       # Search documents
mm get <doc_id>         # Get document by ID
mm list [folder_id]     # List documents
mm folders              # Browse folder tree
```

For full API (create with tags, update, delete), use the `/metamemory` skill.

### /metabot — Agent Bus, Scheduling & Bot Management
Use the `mb` shell shortcut for quick operations:

```bash
mb bots                                    # List all bots
mb task <botName> <chatId> <prompt>        # Delegate task
mb schedule list                           # List scheduled tasks
mb schedule add <bot> <chatId> <sec> <prompt>  # Schedule a task
mb health                                  # Health check
```

For full API (create bots, update tasks, sendCards), use the `/metabot` skill.

## Guidelines

- **Search before creating** — always check if a file or document already exists before creating new ones.
- **Use metamemory** — when you discover important knowledge, project patterns, or user preferences, save them to memory so future sessions can benefit.
- **Output files** — when generating files the user needs (images, PDFs, reports), copy them to the outputs directory provided in the system prompt so they get sent to the chat automatically.
- **Be concise in chat** — responses appear as Feishu/Telegram cards with limited space. Keep answers focused and use markdown formatting.
