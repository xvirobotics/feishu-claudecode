# Peers Federation

Cross-instance bot discovery and task routing. Connect multiple MetaBot instances — on the same machine or across remote servers.

## Overview

Peers enables a **federated architecture** where multiple MetaBot instances discover each other's bots and route tasks automatically. This is useful when:

- Multiple users on the same machine run separate MetaBot instances
- Teams deploy MetaBot on different servers
- You want to share specialized bots across environments

## How It Works

1. **Identity** — Each instance has a stable identity in `~/.metabot/identity.json`
2. **LAN auto-discovery** — Two instances on the same LAN find each other automatically via mDNS (`_metabot._tcp.local`). No configuration needed.
3. **Discovery polling** — Each instance periodically polls its peers' `GET /api/bots` and `GET /api/skills` endpoints (every 30 seconds)
4. **Caching** — Bot and skill lists are cached locally for fast lookups
5. **Routing** — When a bot name isn't found locally, the request is forwarded to the peer that has it
6. **Anti-loop** — Forwarded requests carry `X-MetaBot-Origin` header to prevent circular delegation
7. **Anti-transitive** — Bots and skills that are themselves from a peer are filtered out (no transitive forwarding)

## LAN Auto-Discovery (mDNS)

Two MetaBot instances on the same local network find each other within ~30 seconds of startup with **zero `.env` configuration**. Each instance advertises an `_metabot._tcp.local` service whose TXT record carries `instanceId`, `instanceName`, optional `clusterId`, and a short SHA-256 fingerprint (`pubkeyFp`) of the instance's Ed25519 public key. No secrets are broadcast.

Auto-discovered peers appear in `GET /api/peers` with `source: "mdns"`. They participate in the existing handshake — Static peers configured via `METABOT_PEERS` or `bots.json` are merged in and **take precedence on URL collision** (so any pre-configured secret keeps working).

### Controlling discovery

`METABOT_DISCOVERY_MODE` (defaults to `auto`):

- `auto` — advertise + browse (default)
- `static` — browse only; do not advertise this instance
- `standalone` — do not advertise and do not browse
- `off` — same as `standalone`

To disable mDNS without touching `discoveryMode`, set `METABOT_MDNS_ENABLED=false`.

### Manual verification on two LAN machines

1. Install MetaBot on both machines and start each with the install-default `.env` (no `METABOT_PEERS`).
2. On either machine, wait ~30 seconds, then `curl http://localhost:9100/api/peers`.
3. The other instance appears with `"source": "mdns"` and `"healthy": true`.
4. `mm search "<query>"` returns results from both machines — local hits tagged `source: local`, peer hits tagged `source: peer`, with cached-only fallbacks tagged `source: cache-stale`. No manual secret exchange.

## Auto Token Handshake

When two instances discover each other (via mDNS or a manual `addDynamicPeer` call) they automatically exchange reader tokens through `POST /api/peer-handshake`. Each instance generates one stable reader token at `~/.metabot/peer-token` on first startup; that token is the only credential the peer needs to read this instance's published memory and skills.

The handshake is the only path by which fresh installs can read each other zero-config. Static peers configured via `METABOT_PEERS` or `bots.json` with an explicit `secret` field skip the handshake — the configured secret wins. If you want a static peer to still receive your reader token (e.g. for the *reverse* read direction), leave its `secret` field empty.

Reader tokens authenticate as a Pragmatic v1 **reader principal** scoped to the peer's `instanceId`. Read access is gated by folder visibility — private folders remain unreadable; shared folders are visible. Writes from peers are not allowed. See [federated-memory-skill-hub-plan.md](../internal/federated-memory-skill-hub-plan.md) Phase 2 for the full ACL model and Phase 7 for the deferred fine-grained read ACL.

### Cluster ID onboarding tip

If multiple cluster-isolated MetaBot deployments share one LAN (e.g. infra team + product team on the same office network), set `METABOT_CLUSTER_ID` to a stable label per cluster:

```bash
METABOT_CLUSTER_ID=infra-team
```

mDNS discovery only returns peers carrying the same `clusterId` TXT value, so the two teams stay isolated even on the same network. Omit the env var to join the default unscoped pool.

### Dynamic Peer Demote

Peers added at runtime (mDNS / cluster / manual) are *demoted* — dropped from the in-memory registry — if they stay unreachable for more than 5 minutes. This prevents a permanently-offline laptop from accumulating in `GET /api/peers` forever. Static peers configured by the operator are never demoted.

Override the threshold via `METABOT_DYNAMIC_PEER_DEMOTE_MS` (milliseconds).

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

### Cluster Bootstrap

For an internal LAN, point every instance at one stable MetaBot/cluster URL:

```bash
METABOT_CLUSTER_ID=xvirobotics-lan
METABOT_CLUSTER_URL=http://metabot.internal:9100
METABOT_CLUSTER_SECRET=optional-token
```

During the current bootstrap phase, `METABOT_CLUSTER_URL` is automatically added as a peer when `METABOT_DISCOVERY_MODE` is not `off`. This keeps setup low-friction while preserving the existing explicit `METABOT_PEERS` path for advanced deployments.

## Instance Manifest

Each instance exposes a low-risk manifest for federation:

```bash
curl http://localhost:9100/api/manifest
```

The manifest includes instance ID/name, public key, capability flags, endpoint paths, memory namespace, writable memory namespaces, and local/peer bot and skill counts. It intentionally does not include secrets.

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
| `GET` | `/api/manifest` | Instance identity and capability manifest |
| `GET` | `/api/bots` | List all bots (local + peer) |
| `GET` | `/api/skills` | List all skills (local + peer) |
| `POST` | `/api/talk` | Talk to a bot (auto-routes to peers) |

## CLI

```bash
mb peers                            # list peers and status
mb bots                             # list all bots (includes peer bots)
mb skills                           # list all skills (includes peer skills)
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
    "botCount": 3,
    "source": "mdns",
    "instanceId": "alice-laptop-3f9a12"
  }
]
```

The `source` field is one of `static` (from `METABOT_PEERS` or `bots.json`), `cluster` (from `METABOT_CLUSTER_URL`), `mdns` (auto-discovered on the LAN), or `manual` (added at runtime via API).

Unhealthy peers are retried on the next poll cycle. Their cached bot lists are cleared when they become unreachable.
