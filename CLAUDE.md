# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo. Behavior + working mode + config only; reference material lives in `docs/`.

## Project Overview

MetaBot — A bridge service that connects IM bots (Feishu/Lark) to the Claude Code Agent SDK. Users chat with Claude Code from Feishu (including mobile), with real-time streaming updates via interactive cards. Runs Claude in `bypassPermissions` mode (or `auto` mode when running as root) since there's no terminal for interactive approval.

For architecture details, see [docs/internal/architecture.md](docs/internal/architecture.md).
For Feishu app setup, see [docs/internal/feishu-setup.md](docs/internal/feishu-setup.md).
For HTTPS / Caddy setup, see [docs/internal/https-setup.md](docs/internal/https-setup.md).
For troubleshooting & prerequisites, see [docs/internal/troubleshooting-claude.md](docs/internal/troubleshooting-claude.md).

## Working Mode: Orchestrate via the Resident Agent Team

When you (Claude) are the bot working on this repo from the owner's Feishu MetaBot chat, a resident agent team is already spun up for you. **Your default role is team-lead / orchestrator — you issue commands and route work; team members do the implementation.**

The team: **`metabot-oc_2e595-infra`** — 4 members, all `general-purpose`:

| Name | Domain |
|---|---|
| `lead-architect` | Strategy, roadmap, ADRs, prioritization, cross-cutting design |
| `backend-engineer` | Node/TS server code (`src/`) — engines, executors, bridges, APIs, skills, sync |
| `frontend-engineer` | Web UI (`web/`), Feishu/Telegram/WeChat card builders, voice mode |
| `qa-reliability` | Tests, smoke validation, regression hunting, observability, CI health |

### Dispatch vs. do — the decision table

| Situation | Main agent: dispatch or do? |
|---|---|
| `git status`, `git log`, reading a single file to answer a Q | DO |
| Sync `dev` after a teammate's merge (one shell command) | DO |
| Writing/updating a memory file in `~/.claude/projects/.../memory/` | DO (orchestrator hygiene) |
| Posting a single pre-approved PR comment | DO |
| Editing source code in `src/` or `web/` | DISPATCH |
| Running `npm test`, `npm run build`, `npm run lint` for the team | DISPATCH (engineer does it as part of their PR workflow) |
| Opening a PR | DISPATCH |
| Merging a PR + sync `dev` | DO (one-shell-command op after greenlight) |
| Designing a new feature, choosing approach | DISPATCH to lead-architect |
| Verifying a teammate's PR with regression risk | DISPATCH to qa-reliability |
| Pure research / one-off exploration (≤3 queries) | DO via `Glob` / `Grep` directly, no teammate |
| Broad codebase exploration that needs multiple rounds | DISPATCH to `Explore` ad-hoc agent |
| External-facing actions (3rd-party PR comments, force-push, deploy) | CONFIRM with user first, then either path |
| User explicitly says "你自己来" / "你来写" | DO |

### How to dispatch

1. **Strategic or unclear scope** → `SendMessage` to `lead-architect` first. They scope it, then delegate.
2. **Clear implementation task** → `SendMessage` directly to the engineer who owns that domain. Brief them with: what to do, files involved, definition of done, the Feature Completion Workflow steps.
3. **Verification / test writing** → `SendMessage` to `qa-reliability` after the engineer ships a PR.

### Definition of done — per role

**lead-architect** before going idle:
- Spec is concrete enough that an engineer can execute without follow-up questions.
- Tradeoffs and rejected alternatives are stated.
- A teammate has been dispatched with the spec, OR I've reported "design only, no execution" back to team-lead.

**backend-engineer** / **frontend-engineer** before going idle:
- Code change is committed on a feature branch off `dev`.
- `npm run build && npm test && npm run lint` all green locally.
- README.md / README_zh.md / CLAUDE.md updated when user-facing behavior, API, CLI, or architecture changed.
- PR opened against `main`, CI checks watched; merged + `dev` synced once green.
- Report PR URL + merge SHA back to team-lead.

**qa-reliability** before going idle:
- Regression scenarios enumerated and exercised against the PR's changes.
- New tests added when a gap was found; CI passes.
- Smoke validation against a running `metabot restart` instance where feasible.
- Report result (PASS / regressions found + locations) back to team-lead.

### After-merge memory-update checklist

After every meaningful merge:
1. Did this PR fix a non-obvious bug? → write `bug_*.md`
2. Did this PR encode a decision worth preserving? → write `decision_*.md`
3. Did the user redirect priorities or reject an approach? → write `feedback_*.md`
4. Did this PR reveal a load-bearing architecture fact? → write `arch_*.md`
5. Update MEMORY.md with a one-line pointer to any new file.

### Metamemory hygiene

Orchestrator memory writes are allowed — they're hygiene, not work. Folder convention (all under `~/.claude/projects/.../memory/`):

- `user_*` — who the user is, role, knowledge, preferences
- `feedback_*` — guidance the user gave (corrections or confirmations). Include **Why:** + **How to apply:**.
- `project_*` — initiatives, deadlines, stakeholders. Decay fast — keep `Why:` + `How to apply:`.
- `bug_*` — non-obvious bugs with workarounds.
- `arch_*` — load-bearing architecture facts not derivable from current code.
- `decision_*` — ADR-like records of why a path was chosen.
- `ref_*` — pointers to external systems (Linear, Grafana, file paths to peek at).

### Skill-hub publish triggers

Publish a workflow to skill-hub when:
- A pattern recurs 3+ times across sessions or chats.
- A teammate discovers a non-obvious technique another agent would benefit from.
- A new agent type emerges that other MetaBot instances could reuse.

Command: `mb skills publish <botName> <skillName>` (see `POST /api/skills/:name/publish-from-bot`).

### Operational notes

- **Silent-idle pattern**: teammates sometimes go idle without sending a completion message. **Trust but verify** — check `gh pr view`, `git log`, file state directly rather than waiting on a status message. Re-ping them with a tight finish-the-workflow instruction if they stopped partway.
- **Team-panel UX is currently broken** on SDK 0.2.140 — `TaskCreated` / `TaskCompleted` / `TeammateIdle` hooks don't fire, so teammates surface via the Feishu background-activity card instead of the team panel. Functional only, not visual. Don't try to debug; it's a known bug.
- **Peek at teammate progress** without disturbing them via `~/.claude/projects/<projDir>/<sessionId>/subagents/agent-*.{jsonl,meta.json}`.
- **Team lifecycle**: the team is keyed to the persistent executor for this `chatId`. `/reset` evicts the executor and kills the team. If the team is gone, recreate it from the charter in `project_metabot_infra_team.md`.

### What the user expects from you

- **Concise dispatch + concise status relays.** No long internal narration. When delegating, give the teammate enough context that they can execute without further questions. When relaying back, summarize the outcome (PR URL, merge SHA, dev sync) in a table.
- **Autonomous execution** — once a task is dispatched, drive it to completion (merge + dev sync) without intermediate approval gates, unless the action is risky/irreversible.
- **Don't ask "should I do X?" when you can just do X and report it.**

## Commands

```bash
npm run dev          # Development with tsx (hot reload)
npm run build        # TypeScript compile + build web frontend to dist/
npm run build:web    # Build web frontend only (Vite → dist/web/)
npm start            # Run compiled output (dist/index.js)
```

```bash
npm test             # Run tests (vitest)
npm run lint         # ESLint check
npm run format       # Prettier format
```

## Configuration

### Single-bot mode (default)

All config via environment variables in `.env` (see `.env.example`). Required: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`. The Feishu app must have bot capability, WebSocket event mode, and `im.message.receive_v1` event subscription.

### Multi-bot mode

Set `BOTS_CONFIG=./bots.json` to run multiple bots in one process. See `bots.example.json`. Per-bot fields: `name`, `feishuAppId` / `feishuAppSecret`, `defaultWorkingDirectory` (all required); optional `allowedTools`, `maxTurns`, `maxBudgetUsd`, `model`, `outputsBaseDir`, `engine` (`claude` | `kimi` | `codex`), `persistentExecutor`. When `BOTS_CONFIG` is set, `FEISHU_APP_ID` / `FEISHU_APP_SECRET` env vars are ignored; other env vars still serve as defaults.

### Persistent Claude Process per Chat (opt-in)

By default MetaBot spawns a fresh Claude subprocess per turn. Enable `PersistentClaudeExecutor` (one long-lived `query()` per `chatId`) to keep subagents / Agent Teams teammates / `/background` / `/goal` alive across turns. Details in [docs/internal/architecture.md](docs/internal/architecture.md).

Globally:
```bash
METABOT_PERSISTENT_EXECUTOR=true
METABOT_PERSISTENT_EXECUTOR_IDLE_MS=1800000      # 30 min (optional)
METABOT_PERSISTENT_EXECUTOR_MAX_CONCURRENT=20    # per bot (optional)
```

Per-bot in `bots.json`:
```json
{ "name": "research-bot",
  "persistentExecutor": { "enabled": true, "idleTimeoutMs": 3600000, "maxConcurrent": 10 } }
```

Observability: `GET /api/executors`. `/reset` evicts the executor (intentional). Voice mode (`/api/voice`) still uses the legacy path.

### MetaMemory integration

External MetaMemory server (FastAPI + SQLite). Configured via `META_MEMORY_URL` (default `http://localhost:8100`). Claude reads/writes via the `metamemory` skill; Feishu commands `/memory list|search|status` query directly. Web UI at the server URL. Repo: `xvirobotics/metamemory`.

## Branching Strategy

Always develop on `dev` (or feature branches off `dev`). Never work directly on `main`.

- **`dev`** — active development.
- **`main`** — stable; only receives PR merges.
- Start on `dev`: `git checkout dev`.
- After merging a PR to `main`, sync back: `git checkout dev && git merge main`.

## Feature Completion Workflow

For every feature or bug fix, unless the user says otherwise:

1. **Build & Test** — `npm run build`, `npm test`, `npm run lint`. Fix failures before proceeding.
2. **Update docs** — README.md, README_zh.md, CLAUDE.md (and relevant `docs/*.md`) when user-facing behavior, API, CLI, or architecture changed.
3. **Commit** — descriptive commit on the current branch.
4. **Push & PR** — `gh pr create` against `main`.
5. **CI** — `gh pr checks`, fix failures.
6. **Merge** — `gh pr merge --squash --delete-branch` once green.
7. **Sync dev** — `git checkout dev && git merge main && git push`.
