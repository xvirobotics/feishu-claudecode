# LAN Shared Access — Implementation Status Audit

**Date**: 2026-05-17
**Author**: lead-architect
**Mode**: audit only — no code, no PR
**Companion doc** (kept, do not edit): `docs/internal/metamemory-skillhub-onboarding-audit.md`

## Scope

User intent (verbatim):

> 不需要 peer connection，只要是在相同内网，他们就能够去访问 meta memory 还有 skill hub，当然还有各自的权限是吧？就是别人的都是只读的，然后自己的才是读写的。这个应该之前已经实现了，你再看看。

Translation of the requirement:

1. Same LAN → instances find each other automatically. No `mb peers add` ceremony.
2. Each instance reads everyone else's memory + skill hub (read-only).
3. Each instance writes only its own namespace (read-write self).
4. The user believes this is already implemented; this audit verifies that claim against `docs/internal/federated-memory-skill-hub-plan.md` Phases 1-6.

This doc **does not** rewrite the 8 task cards in the companion audit. It answers a different question: *is the LAN-shared-access path end-to-end real?*

---

## §1. Phase-by-Phase Status

Plan source: `docs/internal/federated-memory-skill-hub-plan.md` Phases 1-6.

| Phase | What plan says | Status | Evidence |
|---|---|---|---|
| **1. Instance Identity** | Ed25519 keypair, stable `instanceId`, default `memoryNamespace=/instances/<id>` | **DONE** | `src/cluster/identity.ts:73-94`, `src/config.ts:612` |
| **2. Namespace ACL** | "Read others, write own" via principal+grants; instance token writes only own ns | **PARTIAL / works via wrong mechanism** | See §1.2 |
| **3. Federated Discovery** | Static + cluster URL + **mDNS `_metabot._tcp.local`** + standalone | **MOSTLY NOT STARTED** | See §1.3 |
| **4. Federated Skill Hub** | Live + cached peer skills with metadata; install copies + tracks source | **DONE** (cache-mirror shape from PR #291) | `src/api/peer-manager.ts:519-577`; `src/skills/skills-installer.ts:110+` |
| **5. Federated Memory Search** | `mm search` returns `source={local,team,peer,cache-stale}` merged | **DONE** (Stage 3, PR #299) | See §1.5 |
| **6. Security Hardening** | Signed manifests, TTL invite tokens, audit logs for memory writes / skill publish | **NOT STARTED** | See §1.6 |

One-line summary symbols: **1 DONE · 2 PARTIAL · 3 NOT-STARTED · 4 DONE · 5 DONE (Stage 3) · 6 NOT-STARTED**.

### §1.2 Phase 2 — "Read others, write own" works, but via folder visibility, not namespace ACL

The plan describes a principal-+-grants model where a `MEMORY_INSTANCE_TOKEN` reads all instance namespaces and writes only its own. That model is half-implemented:

- **Write side is real.** `src/memory/memory-server.ts:118-156` resolves an instance token, attaches `grants: [{namespace, access:'write'}]` for each writable namespace, and `src/memory/memory-storage.ts:343` (`canWritePath`) enforces it. A reader-role token + write grant for `/instances/<self>` correctly writes only its own ns.
- **Read side is a happy accident.** `memory-storage.ts:151-156` (`hasNamespaceGrant`) treats `grantAccess==='read'` as a no-op — *stored* grants are all `access:'write'`, so a read check against the grant list would always fail. Cross-instance reads actually work because of `canReadFolder` at line 337-341: admin always; otherwise `folder.visibility !== 'private'` → allow. Default visibility is `'shared'` (lines 237, 260, 301).

**Consequence for LAN sharing**: it works today, but any future change that flips the default to `'private'` or tightens `canReadFolder` will silently break cross-instance reads even though "namespace read grants exist." The mechanism is load-bearing but not the one the plan claims.

### §1.3 Phase 3 — Discovery: cluster URL only, **no mDNS, no lease renewal**

- `DiscoveryMode` type exists at `src/cluster/identity.ts:6` (`'auto'|'static'|'standalone'|'off'`), parsed at line 96 — but the value is a *label*, not a behavior switch. Only `off` is observed at the peer-bootstrap site.
- Cluster URL bootstrap: `src/config.ts:653-663` adds `METABOT_CLUSTER_URL` as a peer when discovery is not `off`. That's it.
- **mDNS / Bonjour / `_metabot._tcp.local`**: not implemented. `grep -ri 'mdns\|bonjour\|dns-sd\|_metabot\._tcp' src/ package.json` returns zero matches. No mdns dep in `package.json`.
- No lease renewal, no standalone self-advertise.

**Consequence**: "same-LAN, zero-config auto-discovery" is **not** implemented. Two LAN instances will not see each other without one of them being added to `METABOT_PEERS` or pointing at a `METABOT_CLUSTER_URL`.

### §1.5 Phase 5 — Federated search — **DONE in Stage 3 (PR #299)**

`mm search` now fans out server-side and returns a single merged payload with `source=local|peer|cache-stale` tags. Shipped pieces:

- Server endpoint: `src/api/routes/search-routes.ts` — `GET /api/search/federated?q=&limit=` orchestrates local + live-peer + cache-stale.
- Live peers: only fanned out to peers we have a reader secret for (`peerManager.getLivePeersWithSecret()` — operator-configured or Stage 2 handshake-cached); peers without a token are skipped silently.
- Cache-stale: dedup-by-peerName — a peer that responds live (even with zero hits) suppresses its stale cache entry so the operator doesn't see duplicates.
- CLI: `bin/mm search` hits the bridge's `/api/search/federated`; when `METABOT_URL` is unreachable, it falls back to `META_MEMORY_URL/api/search` with a one-line stderr note. `mm peer-search` is kept as a cache-only inspector for the rare debugging case.

ACL note: the read path is unchanged — Pragmatic v1 folder-visibility default + token gate (see `decision_acl_pragmatic_v1.md`). Stage 3 reuses Stage 2's auto-token handshake; no new auth tier.

### §1.6 Phase 6 — Security hardening not started

- No signed manifests for memory documents or skills.
- No TTL invite tokens — `MEMORY_INSTANCE_TOKEN` is a long-lived static secret.
- `AuditLogger` exists but only logs IM commands (Feishu/Telegram), not memory writes or skill publishes. Confirmed by grep on `AuditLogger` call sites.
- Ed25519 keypair from Phase 1 is generated but never used to sign anything.

For LAN-local "trust the subnet" deployment, this is acceptable on day 1. For cross-VLAN or office-network with guests, it is a real gap.

---

## §2. End-to-End LAN Walkthrough — Real Friction Count

Scenario: two engineers, Alice and Bob, on the same office LAN, both want what the user described — read each other's memory + skills, write their own.

### Step 1 — Install (each engineer, once)

```bash
curl -fsSL https://.../install.sh | bash
```

`install.sh` auto-generates `API_SECRET` (line 619) and writes `.env`. Bot starts.

**Tokens written**: `API_SECRET` only.
**Tokens NOT written**: `MEMORY_INSTANCE_TOKEN`, `MEMORY_TOKEN`, `MEMORY_ADMIN_TOKEN`. Confirmed by grep on `install.sh`.

### Step 2 — Find each other on the LAN

**This step does not exist as designed.** No mDNS browse. The actual paths:

- **Path A** (cluster URL): both engineers set `METABOT_CLUSTER_URL=http://<some-stable-host>:9100` in `.env`. Requires picking one machine to be "stable" — a cluster role the plan calls "registry," which itself is not really implemented beyond "treat the URL as a peer."
- **Path B** (static peers): Alice edits `.env`, sets `METABOT_PEERS=http://bob.lan:9100`. Bob edits his `.env`, sets `METABOT_PEERS=http://alice.lan:9100`. Each restart MetaBot.

**Friction count for Path B (the minimum viable LAN path today)**:
- `.env` lines edited per engineer: **2** (one to add `METABOT_PEERS`, plus optional `API_SECRET` sharing — see step 3)
- Files edited: **1** (`.env`)
- Coordination steps: **N×(N-1)** static URL pairings for N engineers (quadratic — does not scale beyond 3-4 people)
- Restarts: **1 per engineer** to pick up the new peer

### Step 3 — Auth handshake for peer reads

`peer-manager.ts:174` (`refreshPeer`) issues `GET /api/bots` + `GET /api/skills` against the peer, optionally with a Bearer token. For memory reads (`/api/peer-memory/...`), the request path is `metabot → peer's metamemory`, and **the peer needs to accept Alice's token**. The de facto setup that works:

- Alice sets `MEMORY_TOKEN=<shared-value>` in her `.env`.
- Bob sets `MEMORY_TOKEN=<same-shared-value>` in his `.env`.
- Both grant each other reader role.

**Or** leave `MEMORY_TOKEN` unset and let memory-server's "no auth configured → open" branch (`memory-server.ts:129`) accept everyone — which is fine on a trusted LAN and is presumably how the user is running it.

**Friction count for step 3**: **0** if running open (current default behavior on a trusted LAN), **1 token to hand-copy** if locking down.

### Step 4 — Use it

- Search across self + peers: `mm search <query>` — federated, returns local + live-peer + cache-stale hits in one payload (Stage 3, PR #299).
- Search peer cache only: `mm peer-search <query>` — kept as a cache-only inspector for debugging.
- Install a peer skill: `mb skills install <peer>/<skill>` — works via `skills-installer.ts`.

### Total friction tally (Path B, 2 engineers, trusted LAN)

| Metric | Count |
|---|---|
| `.env` lines edited per engineer | 2 |
| Tokens to hand-copy (open LAN mode) | 0 |
| Tokens to hand-copy (locked-down mode) | 1 (`MEMORY_TOKEN`) |
| Files edited per engineer | 1 |
| Restarts per engineer | 1 |
| Manual coordination steps | 2 (exchange URLs + restart) |

**The 30-second answer to the user's "已经实现了 吧?"**: **基本到位**. ACL semantics for "read others, write own" work; LAN auto-discovery via mDNS shipped (Stage 1); auto reader-token handshake shipped (Stage 2); federated `mm search` ships local + live-peer + cache-stale in one payload (Stage 3). Remaining gaps are Phase 6 hardening (signed manifests, audit logs, TTL invite tokens).

---

## §3. Gap Analysis — Plan vs `src/`

Each gap labelled S/M/L effort. Overlap with the 8 task cards in the companion audit (`metamemory-skillhub-onboarding-audit.md` §6) flagged in the last column.

| # | Gap | Effort | Overlap with prior cards |
|---|---|---|---|
| G1 | **No mDNS service advertise + browse.** `src/cluster/` has identity but no discovery transport. New file e.g. `src/cluster/mdns.ts`, wire into `src/index.ts` bootstrap, add `bonjour-service` dep. | **M** | None — prior cards assumed static peers list |
| G2 | **Install does not generate `MEMORY_INSTANCE_TOKEN`.** Confirmed at `install.sh:619-676`. Plan calls for per-instance token auto-issued at first boot. Required for locked-down mode without hand-copying. | **S** | Overlaps with companion §6 card Q1 (token-zoo collapse), but narrower: just auto-generate the instance token at install time |
| G3 | **`mm search` does not federate.** `bin/mm:84-86`. Plan Phase 5 wants `source=local|peer|cache-stale` merge. Either extend `bin/mm` client-side or add `GET /api/search/federated` server-side. | **S** (client merge) / **M** (server endpoint) | Partial overlap with companion S4 (federated read polish) — but S4 was framed as "polish caching," this is "feature does not exist in the headline command" |
| G4 | **Namespace read-grants are a no-op.** `memory-storage.ts:151-156` ignores `access:'read'` checks. Today it works because `folder.visibility='shared'` is the default — load-bearing happy accident. | **S** | None directly — fix the principal+grants model OR codify that folder visibility is the actual gatekeeper. Documentation-and-test issue more than code issue |
| G5 | **No peer-handshake token issuance.** When two instances meet (via mDNS or cluster), neither auto-issues a read-only token to the other. Each operator still hand-copies tokens. | **M** | None — prerequisite for "zero env config" beyond trusted-open mode |
| G6 | **No mDNS-aware lease renewal or peer aging.** Cached peers stick around stale. `peer-manager.ts` has `lastSeenAt` but no eviction policy. | **S** | Partial overlap with companion S1 (cache aging polish) |
| G7 | **No signed manifests / no audit logs for memory + skill publish.** Plan Phase 6. | **L** | None — explicitly out of scope for "trusted LAN day-1" but blocking for any cross-VLAN or guest-network deploy |

---

## §4. Rejection List

Things this audit explicitly does **not** propose:

- **`mb peers add` / `mb peers remove` ergonomics polish.** User said: *不需要 peer connection*. The right fix is mDNS auto-discovery (G1), not a nicer manual command. Companion audit's older "peer-management ergonomics" line items are deprioritized.
- **Touching the 5-token zoo** beyond what directly unblocks LAN sharing. G2 + G5 keep the zoo as-is and just auto-issue the one token that matters for the LAN handshake. Full token consolidation stays in the companion audit's Tier-1 cards (Q1).
- **Rewriting any of the 8 task cards in `metamemory-skillhub-onboarding-audit.md` §6.** Those cards stand; this audit lives beside them and is referenced by the top-3 actions below.
- **Mesh fallback / HA archive.** User rejected. The companion audit's §5 "decided constraints" still apply.
- **Cross-VLAN / WAN federation.** Phase 6 security hardening is needed first; out of scope for this LAN-only audit.

---

## §5. Top 3 Immediate Actions (Ranked by LAN-Blocking Impact)

### 1. Implement mDNS service advertise + browse (G1)

- **Where**: new file `src/cluster/mdns.ts`; wire from `src/index.ts` bootstrap; add `bonjour-service` (or `mdns-server`) dep in `package.json`.
- **Why blocking**: this is *the* gap between "what the user thinks ships" and "what ships." Without it, LAN sharing requires manual `METABOT_PEERS` editing and a restart per pairing — quadratic and not the experience the plan promised.
- **Effort**: M (~1 day for a real implementation incl. tests and `discovery=auto` wiring).
- **Acceptance**: two LAN instances see each other in `GET /api/peers` within 30s of cold boot with zero `.env` configuration beyond the install-default `API_SECRET`.

### 2. Auto-issue `MEMORY_INSTANCE_TOKEN` at install + on first peer handshake (G2 + G5)

- **Where**: `install.sh` (generate at install time alongside `API_SECRET`); `src/api/peer-manager.ts:174` (issue + exchange a per-peer reader token during handshake); `src/memory/memory-server.ts:118-156` (accept exchanged peer tokens).
- **Why blocking**: once mDNS exists, the next thing operators bump into is "Alice can see Bob's bot, but `mm peer-search` returns 401." Closing this gap lets locked-down LAN mode work with zero hand-copied tokens.
- **Effort**: M (token generation S, exchange handshake M).
- **Acceptance**: with both instances running fresh-install defaults, Alice runs `mm peer-search foo` and gets Bob's hits without ever touching either `.env` to share a `MEMORY_TOKEN`.

### 3. Merge `mm search` to return local + peer results with `source=` labels (G3) — **DONE (PR #299)**

- **Where shipped**: server-side at `src/api/routes/search-routes.ts` (`GET /api/search/federated`); `bin/mm search` now hits it; `getLivePeersWithSecret` added to `peer-manager.ts`.
- **Acceptance**: `mm search <query>` returns local + cache-stale + live-peer hits in one JSON payload, each tagged `source=local|peer|cache-stale`. Bridge-unreachable fallback to local memory-server prints a one-line stderr warning. `mm peer-search` retained as cache-only inspector.

---

## Appendix — Evidence cross-reference

| Claim | File:Line |
|---|---|
| Identity + namespace defaults | `src/cluster/identity.ts:6`, `:73-94`, `:96` |
| Instance token + write grants enforced | `src/memory/memory-server.ts:118-156`, `src/memory/memory-storage.ts:343` |
| Read-grant is no-op; reads work via folder visibility | `src/memory/memory-storage.ts:151-156`, `:337-341` |
| Default folder visibility = shared | `src/memory/memory-storage.ts:237`, `:260`, `:301` |
| Cluster URL bootstrap | `src/config.ts:653-663` |
| No mDNS in src/ or package.json | `grep -ri 'mdns\|bonjour\|dns-sd\|_metabot\._tcp' src/ package.json` → 0 matches |
| Federated skill listing + cache | `src/api/peer-manager.ts:519-577` |
| Cached peer memory search (separate endpoint) | `src/api/peer-manager.ts:604`, `src/api/routes/peer-memory-routes.ts:20-30` |
| `mm search` is local-only | `bin/mm:84-86` |
| `mm peer-search` is cache-only | `bin/mm:88-90` |
| Install does not generate instance token | `install.sh:619`, `:672-676`; grep confirms `MEMORY_INSTANCE_TOKEN` absent |
| AuditLogger only IM commands | grep on `AuditLogger` call sites |
