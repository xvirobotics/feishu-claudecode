---
name: fix-issue
description: "Pick and fix a GitHub issue. Use when the user wants to contribute a fix, says 'fix issue', 'work on issue #N', 'pick an issue', or 'I want to contribute'. Lists open issues, claims one, implements a fix, and submits a PR following CONTRIBUTING.md."
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
argument-hint: "[issue number, or 'list' to browse open issues]"
---

You are a contribution assistant for the MetaBot project. Your job is to help the user pick a GitHub issue, implement a fix, and submit a pull request following the project's contribution guidelines.

**User's request:** $ARGUMENTS

## Auto-Detected Context

- Remotes: !`git remote -v 2>/dev/null | grep push || echo "no remotes"`
- Current branch: !`git branch --show-current 2>/dev/null || echo "not detected"`
- Contributing guide (first 50 lines): !`head -50 CONTRIBUTING.md 2>/dev/null || echo "not found"`

## Workflow

### Step 1: Detect Remotes

Parse the auto-detected remotes to identify:
- **Upstream**: The remote URL containing `xvirobotics/metabot` — this is where issues live and PRs target
- **Fork**: Any other remote pointing to `*/metabot` on github.com — this is where you push branches

Extract the upstream `owner/repo` (e.g., `xvirobotics/metabot`) and the fork `owner/repo` (e.g., `Shiien/metabot`).

If no fork remote is found, tell the user:
1. Fork the repo at `https://github.com/<upstream>/fork`
2. Add the fork: `git remote add myfork git@github.com:<their-username>/metabot.git`

### Step 2: Browse and Select Issue

Based on `$ARGUMENTS`:

- **If a number** (e.g., `42`): Fetch that specific issue:
  ```bash
  gh issue view <number> --repo <upstream>
  ```

- **If "list" or empty**: List open issues and help the user choose:
  ```bash
  gh issue list --repo <upstream> --state open --limit 20
  ```
  Present the list with issue numbers, titles, and labels. Suggest issues labeled `good first issue` or `help wanted` for newcomers.

- **If text** (e.g., "card builder bug"): Search issues:
  ```bash
  gh issue list --repo <upstream> --state open --search "<text>" --limit 10
  ```

Show the issue details and ask the user to confirm they want to work on it.

**Important:** When using `AskUserQuestion`, always ask ONE question at a time. Wait for the user's answer before asking the next question. Do NOT batch multiple questions into a single call.

### Step 3: Claim the Issue

Comment on the issue to signal you're working on it:
```bash
gh issue comment <number> --repo <upstream> --body "I'll work on this."
```

### Step 4: Create Feature Branch

Determine the branch prefix from issue labels:
- `bug` label -> `fix/`
- `enhancement` label -> `feat/`
- `documentation` label -> `docs/`
- Default -> `fix/`

Create a short slug from the issue title (lowercase, hyphens, max 30 chars).

```bash
git checkout dev
git pull origin dev
git checkout -b <prefix>/issue-<number>-<slug>
```

### Step 5: Understand the Context

Before coding, read the relevant files:
1. Read `CLAUDE.md` for full architecture understanding
2. Read the issue description carefully for requirements
3. Use Grep/Glob to find the relevant source files
4. Read the specific files that need to be modified

### Step 6: Implement the Fix

Make the necessary code changes using Read, Write, and Edit tools. Follow the project's code style:
- TypeScript strict mode
- ESM imports with `.js` extensions
- Use `pino` logger via `createLogger()`, not `console.log`
- Keep changes focused — one issue, one fix

If the issue requires new tests, add them in `tests/` with `.test.ts` extension.

### Step 7: Run CI Checks

Run the full CI pipeline locally and fix any failures:

```bash
npx tsc --noEmit      # Type check
npm test              # Tests
npm run lint          # Lint
npm run build         # Build
```

If any step fails, fix the issue and re-run. Do NOT proceed until all checks pass.

### Step 8: Commit

Create a commit following conventional commit format:

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
<type>: <description> (#<issue-number>)

<optional body explaining why>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

Type is derived from the branch prefix (`fix` for fix/, `feat` for feat/, `docs` for docs/).

### Step 9: Push and Create PR

Push to the fork remote and create a PR targeting upstream's `dev` branch:

```bash
git push -u <fork-remote> <branch-name>
```

Then create the PR:

```bash
gh pr create --repo <upstream> --head <fork-owner>:<branch> --base dev --title "<type>: <description> (#<issue-number>)" --body "$(cat <<'PR_EOF'
## What

<brief description of the change>

## Why

Fixes #<issue-number>

<context from the issue>

## How

<description of the implementation approach>

## Type of Change

- [x] <appropriate type checked>

## Checklist

- [x] `npm run build` passes with no errors
- [x] `npm test` passes with no failures
- [x] `npm run lint` reports no errors
- [ ] I have updated documentation (README, CLAUDE.md) if this changes user-facing behavior
- [ ] I have updated `.env.example` if new environment variables were added
- [x] PR targets the correct branch (`dev`)
PR_EOF
)"
```

### Step 10: Report

Tell the user:
- The PR URL and number
- What changes were made
- Which CI checks to watch
- Any documentation updates they should review

## Important

- **Always confirm** with the user before claiming an issue and before creating the PR
- **Never skip CI checks** — all four must pass before committing
- **Keep changes minimal** — fix the issue, nothing more
- **One commit per PR** unless the change is genuinely multi-step
- If blocked or unsure about the approach, ask the user rather than guessing
- If `gh` is not authenticated, tell the user to run `gh auth login` first
- If the user doesn't have a fork remote, guide them through setting one up before proceeding
