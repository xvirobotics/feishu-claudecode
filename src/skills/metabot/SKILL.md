---
name: metabot
description: "MetaBot HTTP API for agent collaboration: talk to other bots, manage bots and peers, share skills, run voice calls. Use when the user wants to delegate work to another bot, create/remove bots, publish skills, or check peer status."
---

## MetaBot API

MetaBot exposes an HTTP API for agent-to-agent collaboration, bot management, and skill sharing.

Your bot name and chat ID are provided in the system prompt (look for "You are running as bot ... in chat ..."). Use those values for `botName` and `chatId` in the commands below.

### Quick Commands (mb shortcut)

The `mb` shell function is pre-installed and handles auth automatically. **Prefer `mb` over raw curl:**

```bash
# Bots
mb bots                                    # List all bots (local + peer)
mb bot <name>                              # Get bot details

# Agent Talk (cross-instance auto-routing)
mb talk <botName> <chatId> <prompt>        # Talk to a bot
mb talk alice/backend-bot <chatId> <prompt> # Talk to a specific peer's bot

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

### Cross-Instance Agent Talk

When you talk to a bot that isn't on the local instance, MetaBot automatically routes the request to the peer instance that hosts that bot. No special syntax is needed — just use `mb talk <botName> <chatId> <prompt>` as usual.

Use qualified names to target a specific peer: `mb talk <peerName>/<botName> <chatId> <prompt>`.

Use `mb bots` to see all available bots including those on peer instances (they will have `peerName` and `peerUrl` fields indicating which instance hosts them).

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
