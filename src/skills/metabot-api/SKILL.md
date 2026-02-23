---
name: metabot-api
description: "MetaBot HTTP API for agent collaboration: delegate tasks to other bots, schedule future tasks, manage bots. Use when the user wants to schedule tasks, delegate work to another bot, create/remove bots, or check scheduled tasks."
---

## MetaBot API

MetaBot exposes an HTTP API for agent-to-agent collaboration, task scheduling, and bot management.

### Connection Info

Base URL: !`echo http://localhost:${METABOT_API_PORT:-9100}`
Auth header: !`echo ${METABOT_API_SECRET:+Authorization: Bearer $METABOT_API_SECRET}`

Your bot name and chat ID are provided in the system prompt (look for "You are running as bot ... in chat ..."). Use those values for `botName` and `chatId` in the API calls below.

All requests below require the auth header if shown above.

### Task Delegation (Agent Bus)

Delegate a task to another bot synchronously:

```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/tasks \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<target-bot>","chatId":"<chatId>","prompt":"<task description>","sendCards":false}'
```

- `sendCards: false` — bot works silently and returns result
- `sendCards: true` — bot also posts streaming cards to chat

### Discover Available Bots

```bash
curl -s http://localhost:${METABOT_API_PORT:-9100}/api/bots \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

### Task Scheduling

Schedule a task to run after a delay:

```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/schedule \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<your-bot-name>","chatId":"<your-chat-id>","prompt":"check on experiment results","delaySeconds":3600,"label":"optional label"}'
```

List pending scheduled tasks:

```bash
curl -s http://localhost:${METABOT_API_PORT:-9100}/api/schedule \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

Update a pending task:

```bash
curl -s -X PATCH http://localhost:${METABOT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"updated prompt","delaySeconds":7200}'
```

Cancel a scheduled task:

```bash
curl -s -X DELETE http://localhost:${METABOT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

### Bot Management (Self-Replication)

Create a new bot (auto-activates via PM2 restart):

```bash
# Feishu bot
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/bots \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"feishu","name":"<name>","feishuAppId":"...","feishuAppSecret":"...","defaultWorkingDirectory":"/path","installSkills":true}'

# Telegram bot
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/bots \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"platform":"telegram","name":"<name>","telegramBotToken":"...","defaultWorkingDirectory":"/path","installSkills":true}'
```

Get bot details:

```bash
curl -s http://localhost:${METABOT_API_PORT:-9100}/api/bots/<name> \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

Remove a bot:

```bash
curl -s -X DELETE http://localhost:${METABOT_API_PORT:-9100}/api/bots/<name> \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

When asked to create a bot:
1. Ask user for platform + credentials + project name + working directory
2. POST /api/bots with installSkills:true
3. Report success — new bot activates within ~3 seconds via PM2 file-watch

### Health Check

```bash
curl -s http://localhost:${METABOT_API_PORT:-9100}/api/health
```
