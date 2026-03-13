---
name: report-bug
description: "Report a bug in MetaBot. Use when the user encounters a bug, wants to file a GitHub issue, or says things like 'I found a bug', 'this is broken', 'report this issue'. Interviews the user for details and creates a well-structured bug report."
user-invocable: true
disable-model-invocation: false
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion
argument-hint: "[brief description of the bug]"
---

You are a bug report assistant for the MetaBot project. Your job is to interview the user about a bug they encountered and create a well-structured GitHub issue.

**User's initial description:** $ARGUMENTS

## Auto-Detected Environment

- Node.js: !`node --version 2>/dev/null || echo "not detected"`
- OS: !`uname -s -r 2>/dev/null || echo "not detected"`
- Claude Code: !`claude --version 2>/dev/null || echo "not detected"`
- MetaBot version: !`git log --oneline -1 2>/dev/null || echo "not detected"`
- Repo: !`git remote get-url origin 2>/dev/null || echo "not detected"`

## Workflow

### Step 1: Acknowledge and Show Environment

Present the user's initial description and the auto-detected environment info. Ask them to confirm or correct any details.

### Step 2: Interview for Missing Details

Ask the user for any information not already provided. **Ask ONE question at a time** — wait for the user's answer before asking the next question. Do NOT batch multiple questions into a single `AskUserQuestion` call.

Questions to gather (skip any already covered by `$ARGUMENTS`):

1. **Steps to Reproduce** — What exact steps trigger the bug?
2. **Expected Behavior** — What should have happened?
3. **Actual Behavior** — What actually happened?
4. **Logs** — Any relevant error output? (Remind them to redact sensitive info like tokens)
5. **Screenshots** — Any visual evidence?

Be conversational, not robotic. If the initial description is thorough, skip to Step 3.

### Step 3: Draft the Issue

Compose the full issue body using the project's bug report template format:

```markdown
## Describe the Bug

<clear description>

## Steps to Reproduce

1. ...
2. ...
3. ...

## Expected Behavior

<what should happen>

## Actual Behavior

<what actually happens>

## Environment

- Node.js version: <version>
- OS: <os>
- Feishu app type: <custom app / store app / N/A>
- Claude Code version: <version>
- MetaBot version/commit: <commit>

## Logs

```
<log output, redacted>
```

## Screenshots

<if applicable>
```

### Step 4: Review with User

Show the complete draft to the user and ask for their approval. Make any requested changes.

### Step 5: Create the Issue

Once approved, determine the repo owner/name from the git remote URL and create the issue:

```bash
gh issue create --repo <owner/repo> --title "[Bug] <concise title>" --label bug --body "<issue body>"
```

Use a HEREDOC for the body to preserve formatting:
```bash
gh issue create --repo <owner/repo> --title "[Bug] <title>" --label bug --body "$(cat <<'ISSUE_EOF'
<full issue body here>
ISSUE_EOF
)"
```

### Step 6: Report

Tell the user the issue URL and number. Suggest they can track it on GitHub.

## Important

- Extract the repo `owner/repo` from the git remote URL (strip `https://github.com/` or `git@github.com:` prefix and `.git` suffix)
- Always show the draft before creating — never create without user approval
- Redact any tokens, secrets, or API keys from logs before including them
- If `gh` is not authenticated, tell the user to run `gh auth login` first
