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

Status: **Pragmatic v1** — read path gated by folder visibility (default `shared`); per-instance token grants `write` on `/instances/<self>` only. Principal+grants for fine-grained read ACL deferred to Phase 7; revisit when namespace-level revoke or cross-VLAN trust becomes a requirement.

Add scoped memory tokens tied to instance identity:

```text
/instances/<instanceId>/...
/shared/...
/teams/<teamId>/...
```

Policy (Pragmatic v1):

- An instance token can write `/instances/<self>/...`.
- It can read all folders with `visibility !== 'private'` (i.e. `shared`).
- It cannot write another instance namespace.
- Private folders remain readable only to the owning instance's admin token.
- Known peers (after auto-handshake) read via Pragmatic v1 reader principal — they get the same folder-visibility gate, no grants needed.

Required changes (shipped):

- Extend memory auth from role-only (`admin`/`reader`) to principal + grants. Initial support added with `MEMORY_INSTANCE_TOKEN`.
- Add namespace-aware checks in folder/document create/update/delete. Initial write checks are in place for instance namespaces.
- Make the metamemory skill default writes to `METABOT_MEMORY_NAMESPACE`.
- Peer auto-handshake exchanges reader tokens so cross-instance reads work zero-config on the LAN (`POST /api/peer-handshake`, `peerTokenLookup` in memory-server).
- Add migration guidance for existing root-level documents.

The `hasNamespaceGrant(...)` read branch in `memory-storage.ts` is intentionally a no-op under Pragmatic v1 — kept as the placeholder Phase 7 will switch on.

## Phase 3: Federated Discovery

Status: bootstrap URL partially implemented.

Discovery sources should merge in this order:

1. Static config: `METABOT_PEERS`, `bots.json`.
2. Cluster registry: `METABOT_CLUSTER_URL`. Initial support adds this URL as a direct peer when discovery is not `off`.
3. LAN discovery: mDNS service `_metabot._tcp.local`.
4. Standalone self-advertise when no cluster is found.

The cluster registry is a directory, not the source of truth. It stores peer manifests and short-lived leases.

Install behavior:

- Reuse existing identity on reinstall.
- If no identity exists, generate one.
- If a cluster is found, register and write `~/.metabot/cluster.json`.
- If no cluster is found, run standalone and advertise locally.

## Phase 4: Federated Skill Hub

Status: metadata foundation partially implemented.

Make Skill Hub operate on namespaced artifact identity:

```text
local skill: lark-doc
peer skill: alice/lark-doc
team skill: team/lark-doc
```

Add metadata:

- owner instance id. Initial local publish support added.
- owner instance name. Initial local publish support added.
- source peer
- content sha256. Initial storage/list/search support added.
- signature, once signing is enabled
- visibility: private/published/shared. Initial storage/list/search support added.

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

## Phase 7: Fine-Grained Read ACL (Deferred)

Status: **deferred** — current Pragmatic v1 (Phase 2 status above) is sufficient for trusted-LAN cluster deployments. Resume this work only when one of the trigger conditions below fires.

Goal: replace the folder-visibility default with full principal+grant-based read ACL so individual peers can be granted or revoked at namespace granularity (e.g. *Alice can read `/teams/infra/*`, but not `/teams/sales/*`; revoke Alice without rotating every other peer's token*).

Trigger conditions (any one is enough to revisit):

1. **Namespace-level revoke** — a user asks for "revoke Alice's read access to `/drafts`" without rotating Bob's token. Today this requires rotating the central reader; Phase 7 would attach grants to individual peer principals so a revoke is one DB row.
2. **Cross-VLAN / multi-tenant** — deployment crosses a trust boundary (different VLAN, different tenant, untrusted network). LAN trust assumption breaks; folder-visibility default is no longer "good enough".
3. **Per-principal audit log** — Phase 6 audit log adds a "who read what" requirement. Pragmatic v1 reader principals are typed by `instanceId` but share a folder-visibility gate; full attribution requires per-principal grant evaluation.

What Phase 7 should re-touch:

- `memory-storage.ts` `canReadFolder` — replace the visibility short-circuit with grant lookup for non-admin principals.
- `hasNamespaceGrant(..., 'read')` — the already-present no-op becomes load-bearing.
- Peer handshake response — extend with a list of namespace grants the peer is offered (`grants: [{ namespace: '/teams/infra', access: 'read' }]`).
- Storage migration for existing folders' `visibility` field (or a parallel `acl` table indexed by principal).

Rejected alternatives (relitigate at your peril):

- Folder-visibility plus per-instance write token. *That is Pragmatic v1 — already shipped.*
- Token-rotation as substitute for revoke. Operationally noisy and forces every peer to re-exchange tokens.
- Mutual TLS at the transport layer. Solves identity but not namespace-level granularity; orthogonal to this phase.

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
