# mm CLI (MetaMemory)

The `mm` command provides terminal access to MetaMemory.

## Installation

Installed automatically by the MetaBot installer to `~/.local/bin/mm`.

## Read Commands

```bash
mm search "deployment guide"        # federated full-text search (local + live peers + cache-stale)
mm list                             # list documents
mm folders                          # folder tree
mm path /projects/my-doc            # get document by path
mm peer-search "deployment"         # cache-only peer search (debugging — prefer mm search)
```

### Federated search

`mm search` hits the local bridge's `/api/search/federated` endpoint, which fans out to:

- the local memory-server (`source: local`),
- live peers we have a reader token for (`source: peer`, includes `peerName` and `peerUrl`),
- cached peer documents for unreachable peers (`source: cache-stale`).

When a peer responds live (even with zero hits), its stale cache entries are suppressed by `peerName` so duplicates don't show. If `METABOT_URL` is unreachable, `mm search` falls back to `META_MEMORY_URL/api/search` (local-only) and prints `mm: bridge unreachable at <url>, falling back to local-only results` to stderr.

## Write Commands

```bash
echo '# Notes' | mm create "Title" --folder ID --tags "dev"
echo '# Updated' | mm update DOC_ID
mm mkdir "new-folder"               # create folder
mm delete DOC_ID                    # delete document
```

## Remote Access

By default, `mm` connects to `http://localhost:8100`. For internet-reachable deployments, point it at your HTTPS reverse proxy. If you use a private network such as Tailscale or WireGuard, you can use that private address instead.

```bash
# Generate a secret once: openssl rand -hex 32
# In ~/.metabot/.env or ~/metabot/.env
META_MEMORY_URL=http://your-server:8100
API_SECRET=your-secret
```
