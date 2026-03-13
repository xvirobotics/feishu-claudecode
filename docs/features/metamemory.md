# MetaMemory

Embedded knowledge store with full-text search. Agents read/write Markdown documents across sessions. Shared by all agents in the organization.

## Overview

MetaMemory is a **SQLite-based document store** (using FTS5 for full-text search) that provides persistent knowledge for all agents. It runs as an embedded server within MetaBot.

- **Documents** are Markdown files organized in a folder tree
- **Full-text search** via SQLite FTS5
- **Web UI** at `http://localhost:8100?token=YOUR_TOKEN` for browsing and searching
- **REST API** for programmatic access
- **CLI** (`mm`) for terminal access

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
mm list                             # list documents
mm folders                          # folder tree
mm path /projects/my-doc            # get doc by path

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

MetaMemory supports folder-level ACL:

| Token | Access |
|-------|--------|
| `MEMORY_ADMIN_TOKEN` | Full access — sees all folders |
| `MEMORY_TOKEN` | Reader access — shared folders only |

See [Security](../concepts/security.md#metamemory-access-control) for details.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory port |
| `MEMORY_ADMIN_TOKEN` | — | Admin token (full access) |
| `MEMORY_TOKEN` | — | Reader token (shared only) |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory URL (for CLI) |

## Auto-Sync to Wiki

MetaMemory changes can automatically sync to a Feishu Wiki space. See [Wiki Sync](wiki-sync.md) for details.
