# REST API Reference

MetaBot exposes a REST API on port `9100` (configurable via `API_PORT`).

## Authentication

If `API_SECRET` is set, all requests require:

```
Authorization: Bearer <API_SECRET>
```

## Endpoints

### Health & Info

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (includes bot count, peer status) |
| `GET` | `/api/stats` | Cost & usage stats (per-bot, per-user) |
| `GET` | `/api/metrics` | Prometheus metrics endpoint |

### Bots

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bots` | List all bots (local + peer) |
| `POST` | `/api/bots` | Create a bot at runtime |
| `GET` | `/api/bots/:name` | Get bot details |
| `DELETE` | `/api/bots/:name` | Remove a bot |

### Agent Talk

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/talk` | Talk to a bot (auto-routes to peers) |

**Request body:**

```json
{
  "botName": "metabot",
  "chatId": "unique-chat-id",
  "prompt": "Your message to the agent"
}
```

The `botName` field supports [qualified names](../features/peers.md#qualified-names): `peerName/botName`.

!!! note "Deprecated alias"
    `POST /api/tasks` still works but is deprecated. Use `/api/talk` instead.

### Peers

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/peers` | List peers and their health status |

### Scheduling

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/schedule` | Schedule a one-time or recurring task |
| `GET` | `/api/schedule` | List scheduled tasks |
| `PATCH` | `/api/schedule/:id` | Update a scheduled task |
| `DELETE` | `/api/schedule/:id` | Cancel a scheduled task |
| `POST` | `/api/schedule/:id/pause` | Pause a recurring task |
| `POST` | `/api/schedule/:id/resume` | Resume a paused task |

**Schedule request body:**

```json
{
  "botName": "metabot",
  "chatId": "oc_xxx",
  "prompt": "Check service health",
  "cron": "0 8 * * 1-5",
  "timezone": "Asia/Shanghai"
}
```

For one-time tasks, use `delayMs` instead of `cron`:

```json
{
  "botName": "metabot",
  "chatId": "oc_xxx",
  "prompt": "Remind me about the deployment",
  "delayMs": 1800000
}
```

### Wiki Sync

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync` | Trigger MetaMemory → Wiki sync |
| `GET` | `/api/sync` | Sync status |
| `POST` | `/api/sync/document` | Sync single document by ID |

### Text-to-Speech

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tts` | Convert text to speech (returns MP3 audio) |

**Request body:**

```json
{
  "text": "Hello world",
  "provider": "doubao",
  "voice": "zh_female_wanqudashu_moon_bigtts"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `text` | Yes | Text to convert to speech |
| `provider` | No | `doubao`, `openai`, or `elevenlabs` (auto-selects based on available keys) |
| `voice` | No | Voice/speaker ID (defaults per provider) |

**Response:** `audio/mpeg` binary with headers `X-Text-Length`, `X-Provider`, `X-Voice`.

### Feishu Documents

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/feishu/document` | Read a Feishu document as Markdown |

**Query parameters:**

- `url` — Feishu document URL, or
- `docId` — Document ID
- `botName` — Bot name (for credentials)
