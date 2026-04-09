# Environment Variables

All configuration is via `.env` file or system environment variables. Copy `.env.example` to `.env` to get started.

## MetaBot Core

| Variable | Default | Description |
|----------|---------|-------------|
| `BOTS_CONFIG` | — | Path to `bots.json` for multi-bot mode |
| `FEISHU_APP_ID` | — | Feishu app ID (single-bot mode) |
| `FEISHU_APP_SECRET` | — | Feishu app secret (single-bot mode) |
| `API_PORT` | `9100` | HTTP API port |
| `API_SECRET` | — | Bearer token auth for API and MetaMemory. Generate one with `openssl rand -hex 32` |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |

## Claude Code

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_WORKING_DIRECTORY` | — | Working directory for Claude (single-bot mode) |
| `CLAUDE_MAX_TURNS` | unlimited | Max turns per request |
| `CLAUDE_MAX_BUDGET_USD` | unlimited | Max cost per request (USD) |
| `CLAUDE_MODEL` | SDK default | Claude model to use |
| `CLAUDE_EXECUTABLE_PATH` | auto-detect | Path to `claude` binary |

## MetaMemory

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable embedded MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory port |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory auth (legacy) |
| `MEMORY_ADMIN_TOKEN` | — | Admin token (full access) |
| `MEMORY_TOKEN` | — | Reader token (shared folders only) |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory URL (for CLI remote access) |

## Feishu Service App

| Variable | Default | Description |
|----------|---------|-------------|
| `FEISHU_SERVICE_APP_ID` | — | Dedicated app for wiki sync & doc reader |
| `FEISHU_SERVICE_APP_SECRET` | — | Service app secret |

Falls back to the first Feishu bot's credentials if not set.

## Wiki Sync

| Variable | Default | Description |
|----------|---------|-------------|
| `WIKI_SYNC_ENABLED` | `true` | Enable MetaMemory → Wiki sync |
| `WIKI_SPACE_ID` | — | Feishu Wiki space ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | Wiki space name |
| `WIKI_AUTO_SYNC` | `true` | Auto-sync on changes |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | Debounce delay |
| `WIKI_SYNC_THROTTLE_MS` | `300` | Delay between API calls |

## Peers Federation

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOT_PEERS` | — | Comma-separated peer URLs. Prefer HTTPS for internet-reachable peers; use plain HTTP only for localhost or a private overlay network |
| `METABOT_PEER_SECRETS` | — | Comma-separated peer secrets (positional match) |
| `METABOT_PEER_NAMES` | auto | Comma-separated peer names |
| `METABOT_PEER_POLL_INTERVAL_MS` | `30000` | Peer poll interval |

## Remote Access

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOT_URL` | `http://localhost:9100` | MetaBot API URL for CLI. The default is local HTTP; for remote access prefer an HTTPS reverse proxy or a private-network address |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory URL for CLI. The default is local HTTP; for remote access prefer an HTTPS reverse proxy or a private-network address |

## Voice

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLCENGINE_TTS_APPID` | — | Doubao STT + TTS (recommended) |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | Doubao STT + TTS (recommended) |
| `VOLCENGINE_TTS_RESOURCE_ID` | `volc.service_type.10029` | Doubao TTS resource ID |
| `OPENAI_API_KEY` | — | Fallback for Whisper STT + OpenAI TTS |
| `ELEVENLABS_API_KEY` | — | ElevenLabs TTS |
| `VOICE_MODEL` | — | Override Claude model for voice mode |

## Third-Party AI Providers

MetaBot supports any Anthropic-compatible API:

```bash
# Kimi/Moonshot
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=your-key

# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=your-key

# GLM/Zhipu
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your-key
```
