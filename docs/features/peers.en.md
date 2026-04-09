# Peers Federation

Cross-instance bot discovery and task routing. Connect multiple MetaBot instances — on the same machine or across remote servers.

## Overview

Peers enables a **federated architecture** where multiple MetaBot instances discover each other's bots and route tasks automatically. This is useful when:

- Multiple users on the same machine run separate MetaBot instances
- Teams deploy MetaBot on different servers
- You want to share specialized bots across environments

## How It Works

1. **Discovery** — Each instance periodically polls its peers' `GET /api/bots` endpoint (every 30 seconds)
2. **Caching** — Bot lists are cached locally for fast lookups
3. **Routing** — When a bot name isn't found locally, the request is forwarded to the peer that has it
4. **Anti-loop** — Forwarded requests carry `X-MetaBot-Origin` header to prevent circular delegation
5. **Anti-transitive** — Bots that are themselves from a peer are filtered out (no transitive forwarding)

## Configuration

Configure peers via **either** method — or use both (they are merged and deduplicated by URL):

For peers on remote servers, prefer HTTPS URLs fronted by Caddy or another TLS reverse proxy. Plain `http://` is best kept to `localhost` or a private overlay network such as Tailscale or WireGuard.

=== "Environment Variables (.env)"

    The simplest way — just add to your `.env` file. Works with both single-bot and multi-bot mode.

    ```bash
    METABOT_PEERS=http://localhost:9200,http://192.168.1.50:9100
    METABOT_PEER_SECRETS=alice-secret,bob-secret
    METABOT_PEER_NAMES=alice,bob
    ```

    - `METABOT_PEERS` — comma-separated peer URLs (required)
    - `METABOT_PEER_SECRETS` — comma-separated secrets, positional match with URLs (optional, needed if the peer has `API_SECRET` set)
    - `METABOT_PEER_NAMES` — comma-separated display names (optional, auto-derived from URL if omitted, e.g. `localhost-9200`)

=== "bots.json"

    If you already use `bots.json` for multi-bot mode, you can add peers there for a single config file.

    ```json
    {
      "feishuBots": [{ "..." }],
      "peers": [
        {
          "name": "alice",
          "url": "http://localhost:9200",
          "secret": "alice-api-secret"
        },
        {
          "name": "bob",
          "url": "http://192.168.1.50:9100",
          "secret": "bob-api-secret"
        }
      ]
    }
    ```

    - `name` — display name for the peer (required)
    - `url` — peer's API URL (required)
    - `secret` — the peer's `API_SECRET` (optional, needed if the peer has authentication enabled)

!!! tip "You don't need bots.json"
    If you're running a single bot, just add `METABOT_PEERS` to your `.env` — no `bots.json` needed. The `bots.json` peers field is only a convenience for multi-bot setups.

## Qualified Names

Use `peerName/botName` syntax for precise routing:

```bash
# Auto-routing — searches local first, then peers in order
mb talk backend-bot chatId "fix the bug"

# Explicit peer — routes directly to alice's backend-bot
mb talk alice/backend-bot chatId "fix the bug"
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/peers` | List peers and their health status |
| `GET` | `/api/bots` | List all bots (local + peer) |
| `POST` | `/api/talk` | Talk to a bot (auto-routes to peers) |

## CLI

```bash
mb peers                            # list peers and status
mb bots                             # list all bots (includes peer bots)
mb talk alice/bot chatId "prompt"    # talk to a specific peer's bot
```

## Health Monitoring

Each peer is polled every 30 seconds. The `GET /api/peers` endpoint returns health status:

```json
[
  {
    "name": "alice",
    "url": "http://localhost:9200",
    "healthy": true,
    "lastChecked": 1710000000000,
    "lastHealthy": 1710000000000,
    "botCount": 3
  }
]
```

Unhealthy peers are retried on the next poll cycle. Their cached bot lists are cleared when they become unreachable.
