# MetaMemory

Embedded knowledge store with full-text search. Agents read/write Markdown documents across sessions. Each MetaBot instance can write its own namespace while reading shared knowledge.

## Overview

MetaMemory is a **SQLite-based document store** (using FTS5 for full-text search) that provides persistent knowledge for all agents. It runs as an embedded server within MetaBot.

- **Documents** are Markdown files organized in a folder tree
- **Full-text search** via SQLite FTS5
- **Web UI** at `http://localhost:8100?token=YOUR_TOKEN` for browsing and searching
- **REST API** for programmatic access
- **CLI** (`mm`) for terminal access
- **Instance namespaces** for LAN/federated deployments

## How Agents Use It

Claude autonomously reads/writes memory documents via the `metamemory` skill. When users say "remember this" or Claude wants to persist knowledge, it calls the memory API.

```
Remember the deployment guide we just discussed — save it to MetaMemory
under /projects/deployment.
```

```
Search MetaMemory for our API design conventions.
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/memory list` | Browse knowledge tree |
| `/memory search <query>` | Search knowledge base |
| `/memory status` | Show MetaMemory status |

These commands get quick responses without spawning Claude — they use the `MemoryClient` HTTP client directly.

## CLI (`mm`)

```bash
# Read
mm search "deployment guide"        # full-text search
mm peer-search "deployment guide"   # search cached peer memory
mm list                             # list documents
mm folders                          # folder tree
mm path /projects/my-doc            # get doc by path
mm peer-get alice DOC_ID            # read a cached peer document

# Write
echo '# Notes' | mm create "Title" --folder ID --tags "dev"
echo '# Updated' | mm update DOC_ID
mm mkdir "new-folder"               # create folder
mm delete DOC_ID                    # delete document
```

## Web UI Access

When auth is configured (`API_SECRET`, `MEMORY_ADMIN_TOKEN`, or `MEMORY_TOKEN`), the Web UI requires a token. Pass it via URL query parameter:

```
http://localhost:8100?token=YOUR_TOKEN
```

The full URL with token is printed to logs on startup. The token is saved to `localStorage` in the browser, so you only need to pass it once. You can also set or clear the token from the settings icon in the Web UI.

## Access Control

MetaMemory supports folder-level ACL plus scoped instance tokens:

| Token | Access |
|-------|--------|
| `MEMORY_ADMIN_TOKEN` | Full access — sees all folders |
| `MEMORY_TOKEN` | Reader access — shared folders only |
| `MEMORY_INSTANCE_TOKEN` | Instance access — writes the instance namespace plus configured bot/project namespaces, reads shared folders |

Every MetaBot instance gets a stable identity from `~/.metabot/identity.json`. By default its writable namespace is:

```text
/instances/<instanceId>
```

This lets multiple developer-machine MetaBot instances share one MetaMemory service without giving every instance write access to every other instance's area. Admin tokens remain available for maintenance and migration.

See [Security](../concepts/security.md#metamemory-access-control) for details.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory port |
| `MEMORY_ADMIN_TOKEN` | — | Admin token (full access) |
| `MEMORY_TOKEN` | — | Reader token (shared only) |
| `MEMORY_INSTANCE_TOKEN` | — | Scoped token for this instance plus configured bot/project namespaces |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory URL (for CLI) |
| `METABOT_MEMORY_NAMESPACE` | `/instances/<instanceId>` | Instance fallback namespace |
| `METABOT_BOT_MEMORY_NAMESPACE` | `/bots/default` | Single-bot stable namespace override |
| `METABOT_MEMORY_PROJECT` | — | Single-bot project name; derives `/projects/<slug>` |
| `METABOT_MEMORY_WRITE_NAMESPACES` | — | Extra comma-separated writable namespaces |
| `METABOT_PEER_MEMORY_CACHE_ENABLED` | `true` | Mirror peer MetaMemory documents into local read-only cache |
| `METABOT_PEER_MEMORY_CACHE_LIMIT` | `200` | Maximum peer memory documents mirrored per peer poll |

## Stable Project Namespaces

MetaBot keeps `/instances/<instanceId>` as a safe fallback, but bot-owned knowledge should use a stable namespace that survives reinstalling a machine. In `bots.json`, set either:

```json
{
  "name": "metabot",
  "memoryProject": "metabot"
}
```

which derives `/projects/metabot`, or set an explicit namespace:

```json
{
  "name": "metabot",
  "memoryNamespace": "/projects/metabot"
}
```

If neither field is set, the bot defaults to `/bots/<botName>`. `MEMORY_INSTANCE_TOKEN` is automatically granted write access to the instance fallback plus all configured bot/project namespaces.

## Peer Mirror

When peers are configured, MetaBot mirrors readable peer MetaMemory documents into the local peer artifact cache. The mirror is read-only and keeps the owner instance as the source of truth. If a developer machine goes offline, other MetaBot instances can still search cached peer memory through:

```bash
mm peer-search "cluster bootstrap"
mm peer-get alice DOC_ID
```

The API surface is `GET /api/peer-memory/search?q=` and `GET /api/peer-memory/documents/:peerName/:docId`.

## Auto-Sync to Wiki

MetaMemory changes can automatically sync to a Feishu Wiki space. See [Wiki Sync](wiki-sync.md) for details.
