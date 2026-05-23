# metabot-cloud deploy

This document covers deploying the cloud-side relay to the public host on port
**18443**. The cloud relay is the public entry point for MetaBot transcripts
and the Hub UI; user-side data still lives on local instances and is fetched
over the reverse WebSocket channel.

## Target

| Field | Value |
|---|---|
| Host | `.191` — `172.31.21.191` |
| DNS | `teamclaude.xvirobotics.com` |
| Public port | **`18443`** |
| Container name | `metabot-cloud` |
| TLS cert source | `/etc/letsencrypt/live/teamclaude.xvirobotics.com/` |

> **Do not touch port 443.** The Anthropic proxy in `teamclaude-gateway`
> owns it; binding 443 from this stack will take that service down.

## Prerequisites on .191

* Docker + Docker Compose v2.
* The metabot repo cloned at `/home/master/workspace/metabot/` (or similar).
* Let's Encrypt cert for `teamclaude.xvirobotics.com` already issued by
  certbot. We do not provision new certs here — `teamclaude-gateway`
  already maintains them.
* The container runs as `node` (UID `1000`) and needs read on the cert
  files (which are root-owned by default).

## Granting cert read access

Run this once on `.191`:

```bash
sudo setfacl -m u:1000:rx /etc/letsencrypt/live/teamclaude.xvirobotics.com
sudo setfacl -m u:1000:rx /etc/letsencrypt/archive/teamclaude.xvirobotics.com
sudo setfacl -m u:1000:r  /etc/letsencrypt/live/teamclaude.xvirobotics.com/*.pem
sudo setfacl -m u:1000:r  /etc/letsencrypt/archive/teamclaude.xvirobotics.com/*.pem
```

The cert files inside `live/` are symlinks into `archive/` — both directory
entries need the ACL.

## Surviving cert renewals

certbot rewrites the files in `archive/` whenever the cert is renewed, which
wipes the ACLs. Install a deploy hook so it gets reapplied automatically:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/metabot-cloud.sh >/dev/null <<'HOOK'
#!/bin/bash
set -e
setfacl -m u:1000:rx /etc/letsencrypt/live/teamclaude.xvirobotics.com
setfacl -m u:1000:rx /etc/letsencrypt/archive/teamclaude.xvirobotics.com
setfacl -m u:1000:r  /etc/letsencrypt/live/teamclaude.xvirobotics.com/*.pem
setfacl -m u:1000:r  /etc/letsencrypt/archive/teamclaude.xvirobotics.com/*.pem
docker restart metabot-cloud >/dev/null 2>&1 || true
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/metabot-cloud.sh
```

## Environment

Create `cloud/.env` (or set in the shell where `docker compose` runs):

```dotenv
METABOT_SESSION_SECRET=<64-char hex from openssl rand -hex 32>
```

`METABOT_CLOUD_BASE_URL`, `METABOT_CLOUD_TLS_CERT`, and `METABOT_CLOUD_TLS_KEY`
are already pinned in `docker-compose.yml` and do not need to be set in `.env`.

## Build + run

The build context must be the repo root (npm workspaces resolve from there).
`docker-compose.yml` already uses `context: ..` to handle this:

```bash
cd /path/to/metabot
docker compose -f cloud/docker-compose.yml up metabot-cloud -d --build
docker compose -f cloud/docker-compose.yml logs -f metabot-cloud
```

## Smoke test

```bash
# health endpoint (TLS uses LE certs, no -k needed; -k tolerated during testing)
curl -sS https://teamclaude.xvirobotics.com:18443/healthz
# → {"ok":true,"ts":1700000000000}

# root redirects to /web/hub/
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  https://teamclaude.xvirobotics.com:18443/

# WebSocket handshake reachable (expects 4xx because no upgrade headers)
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://teamclaude.xvirobotics.com:18443/ws/instance
```

For a real WS smoke from a workstation that has `wscat` installed:

```bash
wscat -c wss://teamclaude.xvirobotics.com:18443/ws/instance
> {"type":"register","instanceId":"smoke-1","publicKey":"pk","bots":[],"version":"0.0.0","signature":"sig","nonce":"n"}
# expect: {"type":"register_ack","assignedBaseUrl":"https://teamclaude.xvirobotics.com:18443/i/smoke-1","sessionExpiresAt":...}
```

## Operations

* Restart only this service: `docker compose -f cloud/docker-compose.yml restart metabot-cloud`
* Tail logs: `docker compose -f cloud/docker-compose.yml logs -f metabot-cloud`
* Rebuild after a code change: `docker compose -f cloud/docker-compose.yml up metabot-cloud -d --build`

## Rollback

The cloud relay is stateless (no on-disk DB; the instance registry is in
memory). To roll back:

```bash
docker compose -f cloud/docker-compose.yml down metabot-cloud
git checkout <previous-sha>
docker compose -f cloud/docker-compose.yml up metabot-cloud -d --build
```

Connected local instances will reconnect automatically (PR-4 wires the
reconnect loop on the local side).

## What is NOT in this PR

This is PR-3 — the skeleton only. The following still come later:

* PR-4: local-side `cloudClient` (the other end of the WS, with ed25519 signing).
* PR-5: `/i/:instanceId/api/transcript/:chatId` routing and the transcript SPA.
* PR-6: Hub UI at `/web/hub/` with the real data routes.
