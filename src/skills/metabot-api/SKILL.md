---
name: metabot-api
description: "MetaBot HTTP API for agent collaboration: delegate tasks to other bots, schedule future tasks, manage bots. Use when the user wants to schedule tasks, delegate work to another bot, create/remove bots, or check scheduled tasks."
---

## MetaBot API

MetaBot exposes an HTTP API for agent-to-agent collaboration, task scheduling, and bot management.

Your bot name and chat ID are provided in the system prompt (look for "You are running as bot ... in chat ..."). Use those values for `botName` and `chatId` in the commands below.

### Quick Commands (mb shortcut)

The `mb` shell function is pre-installed and handles auth automatically. **Prefer `mb` over raw curl:**

```bash
# Bots
mb bots                                    # List all bots
mb bot <name>                              # Get bot details

# Task delegation
mb task <botName> <chatId> <prompt>        # Delegate task to another bot

# Scheduling
mb schedule list                           # List pending scheduled tasks
mb schedule add <bot> <chatId> <sec> <prompt>  # Schedule a future task
mb schedule cancel <id>                    # Cancel a scheduled task

# Monitoring
mb stats                                   # Cost & usage stats (per-bot, per-user)
mb metrics                                 # Prometheus metrics

# System
mb health                                  # Health check
```

### API Reference (for complex operations)

For operations not covered by `mb` (creating bots, updating tasks, sendCards option), use the API directly.
Auth header: `-H "Authorization: Bearer $METABOT_API_SECRET"`
Base URL: !`echo http://localhost:${METABOT_API_PORT:-9100}`

**Delegate task with cards:**
```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/tasks \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<bot>","chatId":"<chatId>","prompt":"<task>","sendCards":true}'
```

**Create Feishu bot:**
```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/bots \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"feishu","name":"<name>","feishuAppId":"...","feishuAppSecret":"...","defaultWorkingDirectory":"/path","installSkills":true}'
```

**Create Telegram bot:**
```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/bots \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"telegram","name":"<name>","telegramBotToken":"...","defaultWorkingDirectory":"/path","installSkills":true}'
```

**Remove bot:**
```bash
curl -s -X DELETE http://localhost:${METABOT_API_PORT:-9100}/api/bots/<name> \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

**Update scheduled task:**
```bash
curl -s -X PATCH http://localhost:${METABOT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"updated prompt","delaySeconds":7200}'
```

When asked to create a bot:
1. Ask user for platform + credentials + project name + working directory
2. POST /api/bots with installSkills:true
3. Report success — new bot activates within ~3 seconds via PM2 file-watch
