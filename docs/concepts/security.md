# Security

MetaBot runs Claude Code in `bypassPermissions` mode — no interactive approval. Understand the implications.

## Permission Model

Claude has **full read/write/execute access** to the working directory configured for each bot. There is no interactive terminal for permission prompts, so all tool calls are automatically approved.

## Access Control

Control who can interact with your bots:

- **Feishu** — Use app visibility settings, group membership, and organization-level controls in the Feishu Developer Console
- **Telegram** — Configure bot privacy mode and group access

## Cost Limits

Use `maxBudgetUsd` (per bot in `bots.json` or via `CLAUDE_MAX_BUDGET_USD` env var) to cap the cost of each individual request. This prevents runaway spending from a single query.

## API Authentication

Set `API_SECRET` in `.env` to enable Bearer token authentication on both the HTTP API server and MetaMemory. Generate a strong random secret first:

```bash
openssl rand -hex 32
```

Then put the generated value in `.env`:

```bash
API_SECRET=your-secret-token
```

All API requests must then include:
```
Authorization: Bearer your-secret-token
```

## MetaMemory Access Control

MetaMemory supports **folder-level ACL** plus instance-scoped namespace writes:

| Token | Access |
|-------|--------|
| `MEMORY_ADMIN_TOKEN` | Full access — sees all folders (private and shared) |
| `MEMORY_TOKEN` | Reader access — only sees folders with `visibility: shared` |
| `MEMORY_INSTANCE_TOKEN` | Instance access — writes `METABOT_MEMORY_NAMESPACE`, reads shared folders |

Instance scoped tokens are intended for LAN/federated deployments where each MetaBot instance owns:

```text
/instances/<instanceId>
```

The instance token cannot write another instance namespace. Use the admin token for migration and maintenance.

Lock a folder:
```bash
curl -X PUT http://localhost:8100/api/folders/:id \
  -H "Authorization: Bearer $MEMORY_ADMIN_TOKEN" \
  -d '{"visibility": "private"}'
```

## Recommendations

1. **Limit working directories** — Give each bot access only to the directories it needs
2. **Use `maxBudgetUsd`** — Set reasonable cost limits per request
3. **Enable `API_SECRET`** — Always set this in production
4. **Review agent activity** — Streaming cards show every tool call in real-time
5. **Use MetaMemory ACL** — Lock sensitive knowledge folders as private, and give normal instances scoped namespace tokens instead of admin tokens
