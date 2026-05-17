---
name: metabot
description: "Talk to other MetaBot bots (`mb talk` — send a message to another bot, including cross-instance peers). Use when you want to delegate to or message another bot, e.g. 'talk to bot X', '跟其他 bot 说话', 'send message to peer bot', 'ask the deploy-bot', 'delegate to bot'. Also covers bot/peer management, skill hub, voice calls."
---

## Quickstart — Talk to another bot

Use this skill whenever you want to send a message to another MetaBot bot. The `mb` CLI is pre-installed and handles auth automatically.

```bash
# Talk to a local bot
mb talk <botName> <chatId> "<message>"

# Talk to a bot on a federated peer instance
mb talk <peerName>/<botName> <chatId> "<message>"
```

**Semantics:**
- **Asynchronous.** The target bot receives the message in its own chat/session and processes the turn there. Its reply lands in the target bot's chat (not as the return value of this command).
- **Cross-instance auto-routing.** If `<botName>` isn't on this instance, MetaBot transparently forwards to the peer that hosts it. Use `<peerName>/<botName>` to target a specific peer directly.
- **Discovery.** Run `mb bots` to list all reachable bots (local + peer). Use `mb peers` to see federated instances.

**Not the same as Agent Teams `SendMessage`:** `SendMessage` addresses teammates inside your current Agent Team session. `mb talk` addresses other bots — separate sessions, separate chats, separate users on the other side.

Your own bot name and chat ID are in the system prompt ("You are running as bot ... in chat ...") — pass those as needed.

### Examples

```bash
# Ask backend-bot to deploy something
mb talk backend-bot chat_AAA "Please deploy the latest dev branch and report when green."

# Ask a peer's research-bot to look something up
mb talk alice/research-bot chat_BBB "What does our retention dashboard say for last week?"
```

## Other `mb` Commands

The `mb` shell function wraps the MetaBot HTTP API. Talk is the headline; the rest below covers management, peers, and observability.

```bash
# Bots
mb bots                                    # List all bots (local + peer)
mb bot <name>                              # Get bot details

# Peers
mb peers                                   # List peers and their status

# Voice Call (RTC — real-time Doubao AI)
mb voice call <bot> <chatId> [prompt]      # Start voice call, wait for transcript
mb voice transcript <sessionId>            # Get call transcript
mb voice list                              # List active voice sessions
mb voice config                            # Check RTC configuration

# Skill Hub (cross-bot skill sharing)
mb skills                                  # List all shared skills (local + peer)
mb skills search <query>                   # Search skills by keyword
mb skills get <name>                       # Get skill details
mb skills publish <botName> <skillName>    # Publish a bot's skill to the hub
mb skills install <skillName> <botName>    # Install a skill to a bot
mb skills remove <name>                    # Unpublish a skill

# Monitoring
mb stats                                   # Cost & usage stats (per-bot, per-user)
mb metrics                                 # Prometheus metrics

# System
mb health                                  # Health check
```

### Scheduling (use Claude Code native tools first)

For ad-hoc scheduling within this session, prefer Claude Code's native scheduling tools instead of MetaBot's HTTP scheduler:

- **`CronCreate`** — fire a prompt at a cron-matched time (recurring or one-shot). Sessions-only by default; pass `durable: true` to persist across restarts. Ideal for "remind me in 10 minutes" and "every weekday at 9 am" inside one conversation.
- **`/loop [interval] <prompt>`** — turn a task into a self-paced loop with fixed or dynamic intervals (e.g. `/loop 5m check the deploy`). Best for "poll until done" workflows.

These run inside the current Claude session, with no MetaBot server involvement, and stop when the session ends.

If you need **persistent server-side scheduling** that survives Claude restarts and lives in MetaBot's scheduler (so other bots / your future self can list and cancel them via `mb`), invoke the optional `/metaschedule` skill — it documents the `mb schedule` / `/api/schedule` surface. The skill ships with the MetaBot source tree but is **not installed by default**; copy `src/skills/metaschedule/` into `~/.claude/skills/` (or the bot's `.claude/skills/`) to enable it.

### API Reference (for complex operations)

For operations not covered by `mb` (creating bots, sendCards option), use the API directly.
Auth header: `-H "Authorization: Bearer $METABOT_API_SECRET"`
Base URL: !`echo http://localhost:${METABOT_API_PORT:-9100}`

**Talk to a bot (primary endpoint):**
```bash
curl -s -X POST http://localhost:${METABOT_API_PORT:-9100}/api/talk \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<bot>","chatId":"<chatId>","prompt":"<message>","sendCards":true}'
```
The `botName` field supports qualified names: `"alice/backend-bot"` routes directly to the peer named "alice".

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

**List peers:**
```bash
curl -s http://localhost:${METABOT_API_PORT:-9100}/api/peers \
  -H "Authorization: Bearer $METABOT_API_SECRET"
```

When asked to create a bot:
1. Ask user for platform + credentials + project name + working directory
2. POST /api/bots with installSkills:true
3. Report success — new bot activates within ~3 seconds via PM2 file-watch
