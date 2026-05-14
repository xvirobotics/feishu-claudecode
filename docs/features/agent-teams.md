# Agent Teams

A lead agent spawns specialist teammates in parallel, routes tasks between them, and aggregates results — all inside a single Feishu chat.

## What It Does

Agent Teams is the **runtime** team experience inside a single chat session:

- A **lead agent** receives your request and decides what specialists are needed.
- The lead spawns **teammates** (frontend, backend, reviewer, …) via the `Agent` tool. Teammates run as separate sub-agents under the same chat process.
- Teammates can be addressed across turns: the lead routes tasks via `SendMessage`, asks teammates to report back, and aggregates the results.
- Everything happens in one Feishu chat — you talk to the lead, the lead talks to the team.

This is the runtime counterpart to [MetaSkill](metaskill.md): MetaSkill *generates* an agent team configuration (CLAUDE.md / AGENTS.md + skills), while Agent Teams *runs* it.

## Usage

Prompt the lead agent to spawn teammates. You don't need a special command — just describe the team and the work:

```
Act as a lead engineer. Spawn a frontend specialist and a backend specialist
in parallel: the frontend handles the React UI changes, the backend adds the
new /api/reports endpoint, and you review both PRs before merging.
```

```
Spawn a researcher and a writer teammate. The researcher gathers everything
we have on competitor X's pricing strategy from MetaMemory and the web.
The writer turns it into a one-pager. Hand off when done.
```

If your bot already has a generated team (via `/metaskill`), the orchestrator agent in that team is your lead — just describe the goal.

## How It Works

- **Persistent process per chat.** Teammates spawned in turn 1 are still addressable in turn N hours later, because each chat has one long-lived Claude process (see [How it works in CLAUDE.md](https://github.com/xvirobotics/metabot/blob/main/CLAUDE.md#persistent-claude-process-per-chat-stage-4--opt-in)). Without this, every turn would spawn a fresh subprocess and tear down all teammates.
- **Agent tool spawns teammates.** The lead uses Claude's native `Agent` tool with a `team_name=` parameter to start a teammate. Teammates inherit the same working directory and tools.
- **Cross-agent messaging.** Teammates and the lead use `SendMessage` to exchange messages. Replies are queued and delivered when the recipient is ready.
- **Background activity surfacing.** Teammate progress between user turns shows up as a coalesced "Agent activity" card in Feishu (30-second debounce, so you don't get spammed during fast back-and-forth).

## Current Limitations

- **Team panel UX is coming soon.** A dedicated `🧑‍🤝‍🧑 Team` panel showing each teammate with a working/idle status icon and a shared task list is implemented in the card renderer, but the upstream SDK hooks that populate it (`TaskCreated` / `TaskCompleted` / `TeammateIdle`) do not fire reliably yet. Today, teammate activity surfaces in the existing **agent activity card** during the run.
- **Claude engine only.** Teammate spawning relies on Claude's native `Agent` tool. Kimi and Codex bots don't support Agent Teams yet.
- **One lead per chat.** The chat session has one process, so one lead agent. Use separate Feishu chats (or [peers](peers.md)) to run multiple independent teams.
- **Budget is shared.** All teammates run inside the same chat's token budget. Heavy parallel work counts against `maxBudgetUsd`.

## See Also

- [MetaSkill](metaskill.md) — generate a team configuration before running it
- [Goal Loops](goal-loops.md) — give the team a multi-turn objective
- [Peers](peers.md) — run teams on separate MetaBot instances and route between them
