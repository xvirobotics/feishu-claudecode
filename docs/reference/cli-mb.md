# mb CLI (Agent Bus)

The `mb` command provides terminal access to the MetaBot Agent Bus API.

## Installation

Installed automatically by the MetaBot installer to `~/.local/bin/mb`.

## Commands

### Bot Management

```bash
mb bots                             # list all bots (local + peer)
mb bot <name>                       # get bot details
```

### Agent Talk

```bash
mb talk <bot> <chatId> <prompt>     # talk to a bot (sync, waits for result)
mb talk --async <bot> <chatId> <prompt> # fire-and-forget (returns taskId)
mb talk alice/bot <chatId> <prompt> # talk to a specific peer's bot
mb poll <taskId>                    # check async task status
mb poll <taskId> --wait             # poll every 3s until task completes
```

The bot name supports [qualified names](../features/peers.md#qualified-names) (`peerName/botName`) for cross-instance routing.

Use `--async` for fire-and-forget delegation: the command returns immediately with a `taskId`, and the task runs in the background. Use `mb poll` to check results later.

### Peers

```bash
mb peers                            # list peers and status
```

### Scheduling

```bash
mb schedule list                                              # list all tasks
mb schedule cron <bot> <chatId> '<cron>' <prompt>            # create recurring task
mb schedule add <bot> <chatId> <delayMs> <prompt>            # create one-time task
mb schedule pause <id>                                        # pause a task
mb schedule resume <id>                                       # resume a task
mb schedule cancel <id>                                       # cancel a task
```

### Stats & Health

```bash
mb stats                            # cost & usage statistics
mb health                           # health check
```

### Voice

```bash
mb voice "Hello world"              # generate MP3, print file path
mb voice "Hello" --play             # generate and play audio
mb voice "Hello" -o greeting.mp3    # save to specific file
echo "Long text" | mb voice         # read from stdin
mb voice "Hello" --provider doubao  # use specific TTS provider
mb voice "Hello" --voice nova       # use specific voice
```

| Flag | Description |
|------|-------------|
| `--play` | Play audio after generating (macOS: afplay, Linux: mpv/ffplay/play) |
| `-o FILE` | Save to specific file (default: `/tmp/mb-voice-<timestamp>.mp3`) |
| `--provider NAME` | TTS provider: `doubao`, `openai`, or `elevenlabs` |
| `--voice ID` | Voice/speaker ID (provider-specific) |

### Management

```bash
mb update                           # pull + rebuild + restart
mb help                             # show help
```

## Remote Access

By default, `mb` connects to `http://localhost:9100`. Configure remote access:

```bash
# In ~/.metabot/.env or ~/metabot/.env
METABOT_URL=http://your-server:9100
API_SECRET=your-secret
```
