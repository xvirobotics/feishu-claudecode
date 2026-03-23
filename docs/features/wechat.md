# WeChat Integration

MetaBot supports WeChat personal accounts via the ClawBot plugin (iLink Bot API), allowing you to chat with Claude Code agents directly in WeChat.

!!! info "Gray Testing"
    WeChat ClawBot is currently in gray testing. Requires iPhone WeChat 8.0.70+. Android support coming soon.

## Prerequisites

- **iPhone WeChat 8.0.70+**
- Gray test access: WeChat → Me → Settings → Plugins → **ClawBot**
- MetaBot installed and ready to run

## Setup

### 1. Add WeChat Bot Config

Add a `wechatBots` section to your `bots.json`:

```json
{
  "wechatBots": [
    {
      "name": "wechat-assistant",
      "description": "WeChat AI assistant",
      "defaultWorkingDirectory": "/home/user/project"
    }
  ]
}
```

### 2. Start MetaBot

```bash
npm run dev
```

On first start, the terminal displays a QR code URL:

```
=== WeChat QR Login ===
Open this URL or scan the QR code: https://...
Waiting for scan...
```

### 3. Scan QR Code

Scan with WeChat and confirm authorization. After confirmation:

- Bot token is saved to `data/wechat-tokens.json`
- Subsequent restarts auto-restore the session
- Terminal shows `WeChat bot is running (long polling)`

### 4. Start Chatting

Send a message to ClawBot in WeChat — MetaBot handles it and replies.

## Config Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Bot identifier |
| `description` | No | — | Bot description |
| `defaultWorkingDirectory` | Yes | — | Working directory for Claude |
| `wechatBotToken` | No | — | Pre-authenticated iLink token (optional) |
| `ilinkBaseUrl` | No | `https://ilinkai.weixin.qq.com` | iLink API URL |
| `maxTurns` | No | unlimited | Max conversation turns |
| `maxBudgetUsd` | No | unlimited | Max cost per request |
| `model` | No | SDK default | Claude model |

## Environment Variable Mode

For a single WeChat bot, use env vars instead of `bots.json`:

```bash
WECHAT_ILINK_ENABLED=true
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/user/project
```

## Message Support

| Type | Receive | Send | Notes |
|------|---------|------|-------|
| Text | ✅ | ✅ | Auto-splits long text (4000 char limit) |
| Image | ✅ | ✅ | CDN encrypted transfer |
| Voice | ✅ | — | Prefers speech-to-text transcription |
| File | ✅ | ✅ | CDN encrypted transfer |
| Video | ✅ | — | Handled as file |

## Differences from Feishu/Telegram

| Feature | Feishu | Telegram | WeChat |
|---------|--------|----------|--------|
| Connection | WebSocket | Long polling | Long polling (35s) |
| Message editing | ✅ Streaming cards | ✅ Edit messages | ❌ Not supported |
| Progress display | Real-time card updates | Real-time message edits | Typing indicator + final result |
| Group chats | ✅ | ✅ | ❌ Private only |
| Public IP | Not needed | Not needed | Not needed |

!!! note "Message Updates"
    WeChat doesn't support editing sent messages. MetaBot shows a "thinking..." message with typing indicator during processing, then sends the final result as a new message.

## Troubleshooting

**Q: Nothing happens after scanning?**
Ensure ClawBot plugin is enabled in WeChat settings and you have gray test access.

**Q: Token expired?**
Delete the entry from `data/wechat-tokens.json` and restart MetaBot to re-scan.

**Q: Can't send messages?**
WeChat requires the user to message first — the bot cannot initiate conversations (context_token required).

**Q: Unstable connection?**
iLink long polling has a 35-second timeout. Auto-reconnects with exponential backoff (max 60s).
