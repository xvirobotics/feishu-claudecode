# Goal Loops

Set a goal condition; MetaBot keeps Claude working across turns until the goal is met.

## What It Does

`/goal` lets you hand Claude an objective rather than a single instruction. The agent keeps pursuing the goal across **multiple turns** — checking, retrying, waiting on external state — and reports back when the condition is satisfied (or when you tell it to stop).

The Feishu card shows a persistent `🎯 Goal: <condition>` badge across turns, so you always know what the agent is chasing.

## Usage

Send `/goal` followed by the condition you want satisfied:

```
/goal The CI for PR #123 is green and the deploy completes successfully.
Check every 10 minutes and report back when done.
```

```
/goal All open Linear tickets in the INGEST project are either resolved
or assigned to a human. Recheck every 30 minutes.
```

Other forms:

| Command | Effect |
|---------|--------|
| `/goal <condition>` | Set or replace the active goal |
| `/goal` | Query the current goal (no mutation) |
| `/goal clear` (or `stop` / `off` / `reset` / `none` / `cancel`) | Clear the active goal |

## How It Works

`/goal` is a **Claude Code native command** — the loop machinery lives inside Claude Code itself:

1. Claude registers a session-scoped **Stop hook** when the goal is set.
2. When a turn finishes, the Stop hook runs a fast-model evaluator against the goal condition.
3. If the goal is **not yet met**, the evaluator queues another turn automatically. If it **is** met, the loop ends and Claude reports the result.

MetaBot's contribution is the runtime that makes this work over Feishu:

- The **persistent Claude process per chat** (one long-lived SDK session per `chatId`) is what keeps the Stop hook alive between user turns. Without it, every turn spawned a fresh subprocess and killed any in-flight hooks. This runs by default — no configuration needed.
- The Feishu card mirrors the goal condition into a persistent badge so the user can see what's being pursued.

## Limits

- Auto-driven turns count toward the bot's token budget (`maxBudgetUsd`) and turn limit (`maxTurns`) just like manual turns.
- One active goal per chat session. Setting a new goal replaces the previous one.
- Use `/stop` to abort the current turn; use `/goal clear` to stop the loop entirely.
- Goals are scoped to a single chat (`chatId`); they don't persist after `/reset`.

## See Also

- [Agent Teams](agent-teams.md) — combine a goal with parallel teammates
- [Chat Commands](../usage/chat-commands.md) — full command reference
