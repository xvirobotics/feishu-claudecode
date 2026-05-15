# Skill Hub

Federated skill sharing for MetaBot instances. Bots can publish local skills, discover skills from peers, and install them into Claude/Codex workdirs.

## Overview

Skill Hub stores each skill as:

- `SKILL.md`
- optional `references/` bundle
- metadata: author, owner instance, visibility, version, content hash, timestamps

Local skills are stored in SQLite with FTS5 search. Peer skills are discovered through the same peer federation used for bots.

## Discovery

```bash
mb skills
mb skills search lark
```

Results include local skills and healthy peer skills. Peer entries carry `peerName` / `peerUrl`; local entries carry owner metadata:

- `ownerInstanceId`
- `ownerInstanceName`
- `visibility`
- `contentHash`

These fields are the foundation for source display, update checks, and future signature verification.

## Publishing

Publish a skill from a bot workdir:

```bash
mb skills publish metabot lark-doc
```

MetaBot looks under:

```text
<workdir>/.claude/skills/<name>/SKILL.md
<workdir>/.codex/skills/<name>/SKILL.md
```

Published skills default to `visibility: published`.

## Installing

Install a local skill:

```bash
mb skills install lark-doc metabot
```

Install from a peer:

```bash
mb skills install lark-doc metabot peer:alice
```

Installed peer skills are copied locally, so they continue to work if the peer later goes offline.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/skills` | List skills, including peers unless called by a peer |
| `GET` | `/api/skills/search?q=` | Search local and peer skills |
| `GET` | `/api/skills/:name` | Get full skill content; falls back to peer match |
| `POST` | `/api/skills` | Publish skill content directly |
| `POST` | `/api/skills/:name/publish-from-bot` | Publish from a bot workdir |
| `POST` | `/api/skills/:name/install` | Install skill into a bot workdir |
| `DELETE` | `/api/skills/:name` | Remove a local skill |

## Federation Notes

Skill Hub is designed to be P2P-friendly:

- The owner instance stores the source copy.
- Other instances cache summaries through peer polling.
- Installing creates a local copy.
- `contentHash` lets future update checks detect changes.
- Owner metadata lets UIs show where a skill came from.
