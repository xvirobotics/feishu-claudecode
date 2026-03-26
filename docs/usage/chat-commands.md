# Chat Commands

Commands you can send to MetaBot in Feishu or Telegram.

## Available Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session — starts a fresh conversation |
| `/stop` | Abort the currently running task |
| `/status` | Show session info (session ID, working directory) |
| `/memory list` | Browse MetaMemory knowledge tree |
| `/memory search <query>` | Search MetaMemory knowledge base |
| `/sync` | Trigger MetaMemory → Feishu Wiki sync |
| `/sync status` | Show wiki sync statistics |
| `/help` | Show available commands |
| `/metaskill ...` | Generate agent teams, agents, or skills |
| `/metabot` | Load Agent Bus docs (scheduling, bot management, cross-instance talk) |
| `/anything` | Any unrecognized command is forwarded to Claude Code as a skill |

## Notes

- In **DMs**, the bot replies to all messages
- Commands like `/memory` and `/sync` respond quickly without spawning Claude
- `/metaskill` and `/metabot` are skills that get loaded into Claude's context on demand

## Feishu Group Chat Behavior

### @mention Rules

| Scenario | @mention | Notes |
|----------|----------|-------|
| **Direct message** | Not needed | All messages go to the bot |
| **2-member group** (you + bot) | Not needed | Auto-detected as DM-like — no @ needed |
| **Multi-member group** | @Bot required | Only @mentioned messages trigger a response |

!!! tip "Recommended: 2-person group"
    Create a group with just you and the bot. You get DM-like convenience (no @mention) with group features like pinning and categorization.

### Sending Files & Images in Groups

Feishu doesn't allow @mentioning while uploading files or images (especially on mobile). MetaBot supports **upload first, @mention later**:

1. Upload files/images in the group (no @mention needed)
2. Within **5 minutes**, @Bot with your instruction
3. The bot automatically attaches your previously uploaded files

```
[upload report.pdf]            ← upload first
[upload screenshot.png]        ← multiple files ok
@MetaBot analyze these files   ← then @Bot, files auto-attached
```

In DMs and 2-person groups, just send files directly — no workaround needed.

### Smart Batching

When you send multiple files or images in quick succession (within 2 seconds), they are automatically batched into a single request. This works in all chat types.
