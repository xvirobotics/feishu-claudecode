# mm CLI (MetaMemory)

The `mm` command provides terminal access to MetaMemory.

## Installation

Installed automatically by the MetaBot installer to `~/.local/bin/mm`.

## Read Commands

```bash
mm search "deployment guide"        # full-text search
mm list                             # list documents
mm folders                          # folder tree
mm path /projects/my-doc            # get document by path
```

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
