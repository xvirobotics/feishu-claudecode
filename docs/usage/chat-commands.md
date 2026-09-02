# Chat Commands

Commands you can send to MetaBot in Feishu or Telegram.

## Available Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session — starts a fresh conversation |
| `/stop` | Abort the currently running task |
| `/status` | Show session info (session ID, working directory) |
| `/model` | Show or switch the current engine and model. Use `/model list` for available options |
| `/effort low\|medium\|high\|xhigh\|max\|ultra` | Set the Codex reasoning effort for this chat. Use `/effort reset` to clear the override |
| `/resume` | List and switch to a previous Claude, Codex, or Kimi session; `/resume <id>` resumes a session by ID prefix |
| `/goal <condition>` | Set a goal the agent keeps pursuing across turns. `/goal clear` stops it. |
| `/background <prompt>` | Run a task in the background while you continue chatting; use `/background list\|logs <id>\|stop <id>` to manage Codex background tasks |
| `/memory list` | Browse MetaMemory knowledge tree |
| `/memory search <query>` | Search MetaMemory knowledge base |
| `/sync` | Trigger MetaMemory → Feishu Wiki sync |
| `/sync status` | Show wiki sync statistics |
| `@Bot /group-reply mention\|all\|status` | View or change this Feishu group's reply mode for the addressed bot |
| `/help` | Show available commands |
| `/metaskill ...` | Generate agent teams, agents, or skills |
| `/metabot` | Load Agent Bus docs (scheduling, bot management, cross-instance talk) |
| `/anything` | Any unrecognized command is forwarded to the current Agent engine as a skill |

## Notes

- In **DMs**, the bot replies to all messages
- Commands like `/memory` and `/sync` respond quickly without spawning Claude
- `/metaskill` and `/metabot` are skills that get loaded into Claude's context on demand

## Feishu Group Chat Behavior

### Reply Modes and @mention Routing {#group-reply-modes}

Each Feishu bot starts with these defaults:

| Scenario | Default | Notes |
|----------|---------|-------|
| **Direct message** | Reply to all | Group reply mode does not apply |
| **2-member group** (you + bot) | `all` | Auto-detected as DM-like — no @ needed |
| **Multi-member group** | `mention` | Only messages that @ this exact bot trigger a response |

The group owner can override the default for one bot in one group:

```text
@MetaBot /group-reply mention  # reply only when this bot is @mentioned
@MetaBot /group-reply all      # reply to every message in this group
@MetaBot /group-reply status   # show the effective mode and its source
```

The Chinese alias accepts the same actions: `@MetaBot /群回复 仅@`,
`@MetaBot /群回复 全部`, and `@MetaBot /群回复 状态`.

Routing is exact in groups: the command must @ the current bot. A bare
`/group-reply ...` command, or one that only @mentions another bot, is ignored
by this bot. This prevents one command from changing every MetaBot agent in a
shared group. Ordinary messages follow the selected mode; in `mention` mode,
an @mention of another user or bot does not count as mentioning this bot.

Mode changes (`mention` or `all`) are restricted to the Feishu group owner.
Any member can use `status`. MetaBot verifies ownership through the public Lark
chat API and fails closed: if the owner lookup is unavailable or the app lacks
permission, the mode is not changed. Ensure the app has
`im:chat:readonly` permission.

The setting is persisted locally per **bot and chat** and survives restarts.
An explicit setting takes precedence over both the bot's `groupNoMention`
configuration and the 2-member-group default. For example, `mention` makes
even a 2-member group require @Bot, while `all` lets a multi-member group talk
to that bot without @mentioning it.

!!! tip "Recommended: 2-person group"
    Create a group with just you and the bot. You get DM-like convenience (no @mention) with group features like pinning and categorization.

### Sending Files & Images in Groups

In `mention` mode, Feishu doesn't allow @mentioning while uploading files or
images (especially on mobile). MetaBot supports **upload first, @mention
later**:

1. Upload files/images in the group (no @mention needed)
2. Within **5 minutes**, @Bot with your instruction
3. The bot automatically attaches your previously uploaded files

```
[upload report.pdf]            ← upload first
[upload screenshot.png]        ← multiple files ok
@MetaBot analyze these files   ← then @Bot, files auto-attached
```

In `all` mode, unmentioned files and images are processed immediately. In
`mention` mode, they stay cached for the next @Bot instruction instead. DMs
also process them directly; a 2-person group does so by default unless its
explicit mode is changed to `mention`.

### Smart Batching

When you send multiple files or images in quick succession (within 2 seconds), they are automatically batched into a single request. This works in all chat types.
