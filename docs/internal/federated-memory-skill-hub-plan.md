# Federated MetaMemory and Skill Hub Plan

## Decision

Keep the product names **MetaMemory** and **Skill Hub**. Introduce a shared internal substrate called **MetaStore** only in architecture docs/code boundaries when useful.

- MetaMemory remains the knowledge UX: search, read, remember, sync to wiki.
- Skill Hub remains the skill UX: publish, discover, install.
- MetaStore is the common model behind both: markdown artifacts with owner, namespace, metadata, hashes, permissions, and optional signatures.

Renaming the user-facing features now would add migration and documentation cost without improving the product model. The better move is to make the two features feel unified while preserving the existing names.

## Target Model

MetaBot instances form a LAN-friendly federation:

- Every instance owns a persistent identity.
- Every instance owns its private namespace.
- Other instances may read published artifacts but cannot write into the owner namespace.
- Team/shared namespaces can be hosted by a stable team node when long-lived availability matters.
- Skill discovery is federated and cacheable.
- Memory is local-first with optional team/shared promotion.

Physical storage:

- Owner copy: stored on the owning MetaBot instance.
- Reader cache: stored locally by readers as readonly cached copies.
- Team copy: stored on a team node for shared/official knowledge.

Artifact states:

- `private`: owner only.
- `published`: owner stores the source; peers can read/cache.
- `shared`: stored or mirrored to a team namespace.

## Phase 1: Instance Identity and Manifest

Status: in progress.

Add a persistent instance identity:

```text
~/.metabot/identity.json
~/.metabot/identity.key
```

Environment overrides:

```env
METABOT_HOME=~/.metabot
METABOT_IDENTITY_PATH=~/.metabot/identity.json
METABOT_INSTANCE_ID=alice-laptop-7f3a
METABOT_INSTANCE_NAME=Alice Laptop
METABOT_CLUSTER_ID=xvirobotics-lan
METABOT_CLUSTER_URL=http://metabot-registry.internal:9100
METABOT_DISCOVERY_MODE=auto
METABOT_MEMORY_NAMESPACE=/instances/alice-laptop-7f3a
```

Expose:

```http
GET /api/manifest
```

The manifest is intentionally low-risk and contains no secrets. It advertises:

- instance id/name
- cluster id
- public key
- capabilities
- endpoint paths
- local memory namespace
- local/peer skill counts

## Phase 2: Namespace ACL for MetaMemory

Status: partially implemented after Phase 1.

Add scoped memory tokens tied to instance identity:

```text
/instances/<instanceId>/...
/shared/...
/teams/<teamId>/...
```

Policy:

- An instance token can write `/instances/<self>/...`.
- It can read other published instance namespaces.
- It cannot write another instance namespace.
- Team/shared write access requires explicit grant.

Required changes:

- Extend memory auth from role-only (`admin`/`reader`) to principal + grants. Initial support added with `MEMORY_INSTANCE_TOKEN`.
- Add namespace-aware checks in folder/document create/update/delete. Initial write checks are in place for instance namespaces.
- Make the metamemory skill default writes to `METABOT_MEMORY_NAMESPACE`.
- Add migration guidance for existing root-level documents.

## Phase 3: Federated Discovery

Discovery sources should merge in this order:

1. Static config: `METABOT_PEERS`, `bots.json`.
2. Cluster registry: `METABOT_CLUSTER_URL`.
3. LAN discovery: mDNS service `_metabot._tcp.local`.
4. Standalone self-advertise when no cluster is found.

The cluster registry is a directory, not the source of truth. It stores peer manifests and short-lived leases.

Install behavior:

- Reuse existing identity on reinstall.
- If no identity exists, generate one.
- If a cluster is found, register and write `~/.metabot/cluster.json`.
- If no cluster is found, run standalone and advertise locally.

## Phase 4: Federated Skill Hub

Make Skill Hub operate on namespaced artifact identity:

```text
local skill: lark-doc
peer skill: alice/lark-doc
team skill: team/lark-doc
```

Add metadata:

- owner instance id
- owner instance name
- source peer
- content sha256
- signature, once signing is enabled
- visibility: private/published/shared

Install behavior:

- Installing a peer skill copies it into the local bot workdir.
- Installed copies keep source metadata for update checks.
- Peer unavailability does not break already-installed skills.

## Phase 5: Federated MetaMemory Search

Add search federation without making every query depend on every peer:

- Search local first.
- Search team memory if configured.
- Search healthy peers in parallel with short timeout.
- Merge results with source labels.
- Cache peer results by document hash and TTL.

Memory reads can return:

- `source=local`
- `source=team`
- `source=peer`
- `source=cache-stale`

Writes remain local/team only according to grants.

## Phase 6: Security Hardening

Move from shared secrets to instance credentials:

- Generate Ed25519 keypair per instance.
- Sign manifests and artifact metadata.
- Use short-lived registration tokens for cluster join.
- Keep read endpoints low-risk; require signed/admin calls for publish/delete/install/write.
- Add audit logs for memory writes, skill publish/install, and peer sync.

## Deployment Modes

### Standalone

No cluster. Everything remains local. Existing behavior stays compatible.

### LAN P2P

Instances discover each other and read published skills/memory directly.

### LAN Cluster

One stable internal URL provides registry and optional team memory:

```env
METABOT_CLUSTER_URL=http://metabot.internal:9100
```

This is the recommended internal team mode because it works across VLANs where mDNS may be blocked.

## Non-Goals

- Do not require a central server for local development.
- Do not make peer machines authoritative for team-critical memory unless explicitly shared/mirrored.
- Do not rename public features unless the UX genuinely changes enough to justify migration.
