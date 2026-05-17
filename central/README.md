# MetaBot Central

Centralized memory + skill hub server. Phase 1 of the P2P→central pivot.

See [`docs/internal/central-architecture.md`](../docs/internal/central-architecture.md) for the full spec.

## Quick start (dev)

```bash
cd central
npm install --include=dev
npm run build
npm test
npm start   # listens on :8200, data in ./data, prints bootstrap admin token
```

On first start, the server auto-issues an admin credential and writes the one-time bearer token to `data/admin-bootstrap-token.txt` (mode 0600). Save it — it is never displayed again.

## Architecture

- `src/auth/` — `Credential` model + `CredentialsStore` (SQLite-backed, 60s cache for hot lookups, deferred `lastUsedAt` writes)
- `src/memory/` — `MemoryStore` (folders + documents + FTS5 search) with path-based ACL (`canReadPath` / `canWritePath`)
- `src/skills/` — `SkillStore` (publish/list/search/delete) + `publish-acl`
- `src/admin/` — issue/revoke/list credentials + read audit log
- `src/observability/audit-log.ts` — JSONL daily files at `data/audit/YYYY-MM-DD.jsonl`
- `src/server.ts` — HTTP routing + auth middleware
- `bin/central-admin` — CLI shim → `dist/admin/admin-cli.js`

All data lives in `data/central.db` (single SQLite file: `credentials`, `folders`, `documents`, `skills`). Audit entries roll daily; rotate at 100 MB.

## API

Open routes (no auth):

```
GET /health           → { ok, uptime, version }
GET /api/manifest     → { schemaVersion, instance, capabilities }
```

Authenticated routes use `Authorization: Bearer <token>`.

Admin routes (`role: 'admin'`):

```
POST   /admin/credentials/issue
POST   /admin/credentials/revoke
GET    /admin/credentials
GET    /admin/audit?date=YYYY-MM-DD[&principal=&op=]
```

Memory routes:

```
GET    /api/memory/folders[?prefix=/users/...]
GET    /api/memory/folders/tree
GET    /api/memory/folders/:idOrPath
POST   /api/memory/folders
DELETE /api/memory/folders/:idOrPath
GET    /api/memory/documents[?folder_id=|prefix=&limit=&offset=]
POST   /api/memory/documents
GET    /api/memory/documents/:idOrPath
PATCH  /api/memory/documents/:idOrPath
DELETE /api/memory/documents/:idOrPath
GET    /api/memory/search?q=&limit=
```

Skill routes:

```
GET    /api/skills
GET    /api/skills/search?q=
GET    /api/skills/:name
POST   /api/skills/:name/publish      ← requires publishSkill or admin
DELETE /api/skills/:name              ← admin only
```

Paths can be referenced as either internal id (uuid) or absolute path starting with `/`. The router URL-decodes the segment, so `/api/memory/documents/%2Fusers%2Fdkj%2Fnotes%2Fhello` resolves the document at `/users/dkj/notes/hello`.

## ACL

```ts
canRead(cred, path):
  admin → true
  /shared/* → true
  cred.readableNamespaces matches → true
  otherwise false

canWrite(cred, path):
  admin → true
  cred.writableNamespaces matches → true
  otherwise false

canPublishSkill(cred):
  admin → true
  cred.publishSkill → true
  otherwise false
```

Defaults when issuing a member:
- `writableNamespaces`: `[/users/<botName>]`
- `readableNamespaces`: `[/shared, /users/<botName>]`
- `publishSkill`: false

## Deployment

Three options:

1. **Docker compose**: `docker-compose up --build` (publishes 127.0.0.1:8200; add Caddy with `--profile tls` after editing `deploy/Caddyfile`).
2. **One-shot script for Ubuntu 22.04+**: `sudo DOMAIN=central.example.com bash deploy/install.sh` (installs Node 20 + Caddy + systemd unit; idempotent).
3. **Manual**: see the systemd unit at `deploy/central.service` and Caddyfile at `deploy/Caddyfile`.

Required env vars:

```
CENTRAL_PORT=8200                  (default)
CENTRAL_DATA_DIR=/var/lib/central
CENTRAL_AUDIT_DIR=                 (default $CENTRAL_DATA_DIR/audit)
CENTRAL_AUDIT_ENABLED=true         (default)
LOG_FORMAT=json                    (use 'pretty' for dev TTYs)
```

## CLI: `central-admin`

```
central-admin issue   --bot <name> --owner <name> [--role admin|member]
                      [--writable <ns,ns>] [--readable <ns,ns>]
                      [--publish-skill] [--notes <text>]
central-admin revoke  --id <credentialId>
central-admin list
central-admin audit   --date YYYY-MM-DD [--principal <id>] [--op <op>]
```

Auth: `CENTRAL_ADMIN_TOKEN` env or `--token <token>`. URL via `CENTRAL_URL` (default `http://localhost:8200`) or `--url`.

## Tests

`npm test` runs the full vitest suite:

- `tests/auth.test.ts` — credential issue/revoke/lookup/cache + bootstrap
- `tests/memory.test.ts` — folder + document CRUD with namespace ACL
- `tests/skills.test.ts` — publish/list/search/delete + publish-acl
- `tests/audit.test.ts` — every authed request logged JSONL
- `tests/e2e.test.ts` — full flow over real HTTP: bootstrap → issue → member writes own ns / 403 elsewhere → revoke

Each test gets a fresh tmp data dir; no fixtures shared.
