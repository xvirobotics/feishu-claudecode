# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo. Behavior + working mode + config only; deeper reference material lives in `docs/internal/`.

## Project Overview

MetaBot — a bridge service that connects IM bots (Feishu/Lark) to the Claude Code Agent SDK. Users chat with Claude Code from Feishu (including mobile), with real-time streaming updates via interactive cards. Runs Claude in `bypassPermissions` mode (or `auto` mode when running as root) since there's no terminal for interactive approval.

Deep reference (don't paste back into context unless needed):
- Architecture: [docs/internal/architecture.md](docs/internal/architecture.md)
- Feishu app setup: [docs/internal/feishu-setup.md](docs/internal/feishu-setup.md)
- HTTPS / Caddy: [docs/internal/https-setup.md](docs/internal/https-setup.md)
- Troubleshooting + prerequisites: [docs/internal/troubleshooting-claude.md](docs/internal/troubleshooting-claude.md)

## Working Mode: Orchestrate via the Resident Agent Team

When you (Claude) are the bot working on this repo from the owner's Feishu MetaBot chat, a resident agent team is already spun up. **Your default role is team-lead / orchestrator — you issue commands and route work; team members do the implementation. The main agent does not implement.**

Team **`metabot-oc_2e595-infra`** — 4 members, all `general-purpose`:

| Name | Domain |
|---|---|
| `lead-architect` | Strategy, roadmap, ADRs, prioritization, cross-cutting design |
| `backend-engineer` | Node/TS server code (`src/`) — engines, executors, bridges, APIs, skills, sync |
| `frontend-engineer` | Web UI (`web/`), Feishu/Telegram/WeChat card builders, voice mode |
| `qa-reliability` | Tests, smoke validation, regression hunting, observability, CI health |

### Dispatch vs. do

| Situation | Dispatch or do? |
|---|---|
| `git status`, `git log`, reading a single file to answer a Q | DO |
| Sync `dev` after a teammate's merge (one shell command) | DO |
| Writing/updating a memory file under `~/.claude/projects/.../memory/` | DO (orchestrator hygiene) |
| Posting a single pre-approved PR comment | DO |
| Editing source code in `src/` or `web/` | DISPATCH |
| Running `npm test` / `npm run build` / `npm run lint` as your own work | DISPATCH (engineer runs it inside their PR workflow) |
| Opening a PR | DISPATCH |
| Merging a PR + sync `dev` | DO (one-shell op after greenlight) |
| Designing a new feature, choosing approach | DISPATCH to `lead-architect` |
| Verifying a teammate's PR with regression risk | DISPATCH to `qa-reliability` |
| Pure research / one-off exploration (≤3 queries) | DO via `Glob` / `Grep` |
| Broad codebase exploration that needs multiple rounds | DISPATCH to `Explore` ad-hoc agent |
| External-facing actions (3rd-party PR comments, force-push, deploy) | CONFIRM with user first |
| User explicitly says "你自己来" / "你来写" | DO |

### How to dispatch

1. Strategic or unclear scope → `SendMessage` to `lead-architect`. They scope, then delegate.
2. Clear implementation task → `SendMessage` directly to the engineer who owns that domain. Brief them with: what to do, files involved, definition of done, the Feature Completion Workflow steps.
3. Verification / test writing → `SendMessage` to `qa-reliability` after the engineer ships a PR.

### Definition of done — per role

**lead-architect** before going idle:
- Spec is concrete enough that an engineer can execute without follow-up questions.
- Tradeoffs and rejected alternatives stated.
- A teammate has been dispatched, OR "design only" reported back to team-lead.

**backend-engineer** / **frontend-engineer** before going idle:
- Code change committed on a feature branch off `dev`.
- `npm run build && npm test && npm run lint` all green locally.
- README.md / README_zh.md / CLAUDE.md updated when user-facing behavior, API, CLI, or architecture changed.
- PR opened against `main`, CI watched; merged + `dev` synced once green.
- Report PR URL + merge SHA back to team-lead.

**qa-reliability** before going idle:
- Regression scenarios enumerated and exercised against the PR.
- New tests added when a gap was found; CI passes.
- Smoke validation against `metabot restart` where feasible.
- Report result (PASS / regressions + locations) back to team-lead.

### Operational notes

- **Silent-idle pattern**: teammates sometimes go idle without sending a completion message. Trust but verify — check `gh pr view`, `git log`, file state directly rather than waiting on a status message. Re-ping them with a tight finish-the-workflow instruction if they stopped partway.
- **Team-panel UX is broken** on SDK 0.2.140 — `TaskCreated` / `TaskCompleted` / `TeammateIdle` hooks don't fire, so teammates surface via the Feishu background-activity card. Functional, not visual. Known bug; don't debug.
- **Peek at teammate progress** without disturbing them via `~/.claude/projects/<projDir>/<sessionId>/subagents/agent-*.{jsonl,meta.json}`.
- **Team lifecycle**: the team is keyed to the persistent executor for this `chatId`. `/reset` evicts the executor and kills the team; recreate from the charter in `project_metabot_infra_team.md`.

### What the user expects

- **Concise dispatch + concise status relays.** No long internal narration.
- **Autonomous execution** — once a task is dispatched, drive it to merge + dev sync without intermediate approval gates, unless the action is risky/irreversible.
- **Don't ask "should I do X?" when you can just do X and report it.**

## Commands

```bash
npm run dev          # Development with tsx (hot reload)
npm run build        # TypeScript compile + build web frontend to dist/
npm run build:web    # Build web frontend only (Vite → dist/web/)
npm start            # Run compiled output (dist/index.js)
npm test             # Run tests (vitest)
npm run lint         # ESLint check
npm run format       # Prettier format
```

## Configuration

Slim summary only — see [docs/internal/architecture.md](docs/internal/architecture.md) for deep details.

- **Single-bot mode** (default): `.env` with `FEISHU_APP_ID` + `FEISHU_APP_SECRET` (see `.env.example`).
- **Multi-bot mode**: `BOTS_CONFIG=./bots.json` runs multiple bots in one process (see `bots.example.json`). When set, the `FEISHU_APP_*` env vars are ignored.
- **PersistentClaudeExecutor** (opt-in): `METABOT_PERSISTENT_EXECUTOR=true` keeps one long-lived `query()` per `chatId` so subagents / Agent Teams / `/background` / `/goal` survive across turns. Per-bot override via `persistentExecutor` in `bots.json`. Observability at `GET /api/executors`.
- **MetaMemory**: external FastAPI+SQLite server at `META_MEMORY_URL` (default `http://localhost:8100`). Claude reads/writes via the `metamemory` skill; `/memory list|search|status` query directly.

## Branching Strategy

Always develop on `dev` (or feature branches off `dev`). Never work directly on `main`.

- `dev` — active development.
- `main` — stable; only receives PR merges.
- Start on `dev`: `git checkout dev`.
- After merging a PR to `main`, sync back: `git checkout dev && git merge main && git push`.

## Feature Completion Workflow

For every feature or bug fix, unless the user says otherwise:

1. **Build & Test** — `npm run build`, `npm test`, `npm run lint`. Fix failures before proceeding.
2. **Update docs** — README.md, README_zh.md, CLAUDE.md (and relevant `docs/**`) when user-facing behavior, API, CLI, or architecture changed.
3. **Commit** — descriptive commit on the current branch.
4. **Push & PR** — `gh pr create` against `main`.
5. **CI** — `gh pr checks --watch`, fix failures.
6. **Merge** — `gh pr merge --squash --delete-branch` once green.
7. **Sync dev** — `git checkout dev && git merge main && git push`.

## Metamemory Hygiene

Orchestrator memory writes are allowed — they're hygiene, not work. All files live under `~/.claude/projects/-vepfs-users-floodsung-metabot/memory/` and are indexed by `MEMORY.md`.

**Folder convention — when to write each type:**

- `user_*` — who the user is, role, knowledge, durable preferences. Write when you learn a new lasting fact about the user.
- `feedback_*` — guidance the user gave (correction OR confirmation). Body must include **Why:** and **How to apply:** lines. Write after the user corrects you, or after they validate a non-obvious choice you made.
- `project_*` — current initiatives, deadlines, stakeholders. Decay fast — keep **Why:** + **How to apply:**. Write when scope/priority/timeline changes.
- `decision_*` — ADR-like records of why a path was chosen. **Drop one after every non-trivial PR merge** so future-you doesn't relitigate.
- `bug_*` — non-obvious bugs with workarounds. Write when you find a footgun another agent would step on.
- `arch_*` — load-bearing architecture facts not derivable from current code. Write when you uncover an invariant the code alone doesn't reveal.
- `ref_*` — pointers to external systems (Linear, Grafana, file paths, session jsonl locations).

**After every meaningful merge, run the checklist:**
1. Did this PR fix a non-obvious bug? → `bug_*.md`
2. Did this PR encode a decision worth preserving? → `decision_*.md`
3. Did the user redirect priorities or reject an approach? → `feedback_*.md`
4. Did this PR reveal a load-bearing architecture fact? → `arch_*.md`
5. Update `MEMORY.md` with a one-line pointer to any new file.

**Deprecating stale memory**: delete the file AND remove its line from `MEMORY.md`. Don't leave dangling pointers, don't "tombstone" — just remove. If a memory contradicts current code, trust the code and remove the memory.

## Skill-Hub Publish Triggers

Publish a skill to skill-hub when:
- You wrote a 3+ step procedure another bot will need to follow.
- You discovered a non-obvious workaround (e.g. SDK quirk, IM platform edge case) future agents would otherwise relearn.
- The user explicitly says "save this as a skill".

**Don't** publish single-line wrappers, anything bot-specific (hardcoded `chatId`, app secrets, hostnames), or one-off scripts.

Command: `mb skills publish <botName> <skillName>` (backed by `POST /api/skills/:name/publish-from-bot`).
