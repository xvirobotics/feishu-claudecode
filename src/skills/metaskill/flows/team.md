# Flow: Create Agent Team

You are building a complete project directory with a `.claude/` agent team configuration.

## IMPORTANT: Project Folder First

You MUST create a **new project subfolder** under the current working directory, then scaffold everything inside it. This ensures the agent team is a self-contained, portable project.

**Folder naming**: Derive a short, kebab-case folder name from the team type. Examples:
- "ios app" → `ios-app-agents/`
- "fullstack web" → `fullstack-web-agents/`
- "data science" → `data-science-agents/`
- "game dev with Unity" → `unity-game-agents/`

If the user's request is empty or unclear, use `AskUserQuestion` to ask the user what type of agent team they want and what to name the project folder.

**All files are created inside this project folder:**
```
<project-folder>/
├── CLAUDE.md                          # Orchestration hub (YOU are the tech lead)
├── .mcp.json                          # MCP server config
└── .claude/
    ├── agents/
    │   ├── code-reviewer.md           # Required: quality gate
    │   ├── <specialist-1>.md
    │   └── <specialist-2>.md
    ├── skills/
    │   ├── <skill-1>/SKILL.md
    │   └── <skill-2>/SKILL.md
    └── rules/
        └── <coding-standards>.md
```

**Step 0: Create the project folder and initialize git:**
```bash
mkdir -p <project-folder>
cd <project-folder>
git init
```

### Engine Compatibility (Claude ↔ Kimi)

MetaBot supports two engines: **Claude Code** and **Kimi**. The scaffolded project should be usable by either engine. Key differences you must account for:

| Feature | Claude | Kimi |
|---------|--------|------|
| Orchestration doc | `CLAUDE.md` | `AGENTS.md` (symlink `CLAUDE.md` → `AGENTS.md`) |
| `.claude/skills/` | ✅ auto-discovered | ✅ auto-discovered (brand fallback) |
| `.claude/agents/*.md` | ✅ auto-discovered | ❌ not loaded (Kimi has only builtin `default`/`okabe`) |
| MCP config | `.mcp.json` (project-level) | `~/.kimi/mcp.json` (user-level) |

**What to do at the end of Phase 2 (before verification):**
```bash
# Create AGENTS.md symlink so Kimi reads the same CLAUDE.md
[ -f CLAUDE.md ] && [ ! -e AGENTS.md ] && ln -s CLAUDE.md AGENTS.md
```

Note in the final summary that subagents under `.claude/agents/` only take effect under the Claude engine. Users who run this team on a Kimi-backed bot should expect the orchestrator (CLAUDE.md/AGENTS.md) to do the work inline rather than delegating.

All subsequent paths in Phase 2-4 are **relative to this project folder**. You MUST `cd` into the project folder before creating any files.

---

## PHASE 1: RESEARCH

**Do this BEFORE creating any files.** Perform 3-5 web searches to gather domain knowledge, then compile a structured research brief.

### Search 1: Real-World Team Structure

Search for how real teams of the requested type are organized — roles, responsibilities, workflows, handoff patterns.

Example queries:
- "[team-type] development team structure roles responsibilities"
- "[team-type] software engineering team organization"

Extract: key roles, who owns what, typical workflow (e.g., design → implement → review → test → deploy).

### Search 2: GitHub Agent Configurations

Search for existing Claude Code or AI agent configurations for this domain.

Example queries:
- `site:github.com .claude agents [technology]`
- `claude code [team-type] agents github`
- `CLAUDE.md [technology] site:github.com`

Extract: any reusable agent definitions, patterns, or ideas.

### Search 3: MCP Servers for This Domain

Search for MCP (Model Context Protocol) servers relevant to the team type's technologies.

Example queries:
- `MCP server [technology] npm`
- `claude MCP server [technology]`
- `model context protocol servers [domain]`

Extract: server names, packages, install commands, what they provide.

### Search 4: Best Practices and Tooling

Search for current development best practices, linters, testing frameworks, CI/CD patterns specific to this domain.

Example queries:
- "[technology] development best practices 2025"
- "[technology] testing framework recommended"
- "[technology] linting code quality tools"

Extract: coding conventions, recommended tools, testing strategies.

### Search 5 (Optional): Fetch Promising GitHub Repos

If searches 2-3 found promising repos with agent configs, use WebFetch on 1-2 of them to examine their structure.

### Compile Research Brief

After all searches, write a structured summary (in your thinking, not as a file) covering:
- **Team roles identified**: list each role with responsibilities
- **Tech stack & tools**: languages, frameworks, build tools, linters, test frameworks
- **MCP servers to install**: name, package, purpose
- **Coding conventions**: style guides, naming, patterns
- **Workflow**: typical development workflow for this domain

---

## PHASE 2: BUILD

Based on your research findings combined with the embedded patterns below, create all files **inside the project folder** created in Step 0. Make sure you are `cd`'d into the project folder before writing any files. Create them in this order.

### File 1: `<project-folder>/CLAUDE.md`

Write a comprehensive `CLAUDE.md` that serves as the orchestration hub. Structure:

```markdown
# CLAUDE.md

## Project Overview
[Brief description based on detected project context + team type]

## Agent Team

**You (the main Claude session reading this CLAUDE.md) are the orchestrator / tech lead.** You analyze tasks, break them down, delegate to specialist agents, and ensure quality. You never need a separate tech-lead agent — this file IS your orchestration guide.

### Routing Table

| Task Type | Agent | When to Use |
|-----------|-------|-------------|
| [domain-specific task 1] | [specialist-1] | [specific triggers] |
| [domain-specific task 2] | [specialist-2] | [specific triggers] |
| Code review, PR review | code-reviewer | All code changes before merge |
| ... | ... | ... |

### Orchestration Protocol

1. **You are the routing authority.** When a complex task arrives, analyze it and delegate to the appropriate specialist(s) via Task tool.
2. **For multi-step tasks, delegate to specialists** — break down the work and assign each piece to the right agent.
3. **Handoff format:** When delegating, provide: (a) clear objective, (b) relevant file paths, (c) acceptance criteria, (d) which agent to hand off to next.
4. **Max 2 agents in parallel** for complex tasks to avoid conflicts.
5. **Code reviewer is the quality gate** — all code changes pass through code-reviewer before completion.

### Workflow Chains

- **New Feature**: you (plan & delegate) → [specialist] → code-reviewer
- **Bug Fix**: you (triage) → [specialist] → code-reviewer
- **Refactor**: you (plan) → code-reviewer (review plan) → [specialist] → code-reviewer

## Coding Standards
[Based on research findings — language conventions, naming, patterns]

## Shared Knowledge (MetaMemory)

All agents share context through MetaMemory. Use the `mm` CLI to read and write shared documents.

### Quick Reference
```bash
mm search <query>                    # Find existing knowledge
mm get <doc-id>                      # Read a document
mm list [--folder <id>]              # Browse documents
mm create -t "Title" -c "Content"    # Save new knowledge
mm update <doc-id> -c "New content"  # Update existing doc
```

### When to Use
- **Before starting work**: Search MetaMemory for existing context, decisions, and lessons
- **After completing work**: Save important decisions, architecture notes, and findings
- **When discovering patterns**: Document reusable patterns for other agents to reference
- Use `--by "agent-name"` when creating/updating to track which agent contributed

## Workflow Discipline (All Agents)

### Planning
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Write detailed specs upfront to reduce ambiguity

### Autonomous Execution
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user

### Verification
- Never mark a task complete without proving it works
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### Self-Improvement
- After ANY correction from the user: record the pattern as a lesson
- Write rules for yourself that prevent the same mistake
- Review lessons at session start for relevant context
- Save important lessons and discoveries to MetaMemory (`mm create`) so all agents benefit

### Core Principles
- **Simplicity First**: Make every change as simple as possible. Minimal code impact.
- **Root Cause Focus**: Find root causes. No temporary fixes.
- **Minimal Footprint**: Only touch what's necessary. Avoid introducing bugs.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?" Skip for simple fixes.
- **Subagent Strategy**: Use subagents liberally. One tack per subagent for focused execution.

## Available Skills
[List the skills created below with brief descriptions]
```

### File 2: .claude/agents/ (3-5 agent files)

Create each agent as `.claude/agents/<name>.md`. Note: there is NO tech-lead agent — CLAUDE.md itself serves as the orchestrator.

**IMPORTANT: Every agent's system prompt MUST end with the Workflow Discipline section** (the same block from the CLAUDE.md template above). Copy it verbatim into each agent's system prompt after their domain-specific instructions.

#### Required Agent:

**code-reviewer.md** (Quality Gate)
```yaml
---
name: code-reviewer
description: "Use this agent when code changes need review before completion. For example: after implementing a feature, before merging a PR, when refactoring existing code."
model: sonnet
tools: Read, Glob, Grep, Bash
---
```
System prompt: Senior code reviewer who checks for correctness, security, performance, maintainability, and adherence to project conventions. Produces structured review with severity levels.

#### Domain Specialists (2-3, based on research):

Create specialists appropriate to the team type. Each should have:
- A focused, specific `description` with concrete examples
- `model: sonnet` (specialists are cost-effective workers)
- Appropriate `tools` restriction (e.g., a UI specialist might not need Bash)
- Detailed system prompt with domain expertise, methodologies, and self-verification steps

**Examples by domain:**

For a web fullstack team:
- `frontend-engineer.md` — UI components, styling, client-side logic, accessibility
- `backend-engineer.md` — APIs, database, server logic, authentication
- `devops-engineer.md` — CI/CD, Docker, deployment, infrastructure

For an iOS team:
- `ios-engineer.md` — SwiftUI/UIKit, app architecture, platform APIs
- `ui-designer.md` — Layout, animations, design system, accessibility
- `test-engineer.md` — XCTest, UI testing, test plans, mocking

For a data science team:
- `data-engineer.md` — Pipelines, ETL, data quality, schemas
- `ml-engineer.md` — Model training, evaluation, feature engineering
- `analyst.md` — EDA, visualization, statistical analysis, reporting

For a game dev team:
- `game-programmer.md` — Game logic, physics, networking
- `graphics-engineer.md` — Rendering, shaders, performance
- `level-designer.md` — Content, scripting, game balance

**Adapt based on your research findings.** The research should reveal which specialist roles are most valuable for this specific team type.

### File 3: .claude/skills/ (2-4 skill files)

Create domain-appropriate workflow skills. Each skill is `.claude/skills/<name>/SKILL.md`.

Common patterns:

**a) build-and-test skill** (almost always useful)
```yaml
---
name: build-and-test
description: Build the project and run tests, reporting results
user-invocable: true
allowed-tools: Bash, Read, Grep
context: fork
---
```

**b) Domain-specific workflow skill** (varies by team type)
Examples:
- For web: `deploy-preview`, `lighthouse-audit`, `api-test`
- For iOS: `build-simulator`, `run-tests`, `archive-release`
- For data science: `run-pipeline`, `evaluate-model`, `generate-report`
- For game dev: `build-game`, `playtest-checklist`, `profile-performance`

**c) review-checklist skill** (quality assurance)
A skill that generates a domain-specific code review checklist.

Use `!`backtick`` syntax for dynamic context in skills where appropriate (git status, branch name, recent changes, etc.).

### File 4: .claude/rules/ (1-2 rule files)

Create coding standard rules as `.claude/rules/<name>.md`. Rules are automatically loaded and enforced.

Base the content on research findings. Example structure:

```markdown
# [Language/Framework] Coding Standards

## Naming Conventions
- [specific conventions from research]

## Code Organization
- [file structure, module patterns]

## Error Handling
- [domain-specific error patterns]

## Testing Requirements
- [what must be tested, coverage expectations]
```

### File 5: .mcp.json (project root)

Create `.mcp.json` with MCP servers relevant to the project. Use this format:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@package/name", ...additional-args],
      "env": {}
    }
  }
}
```

Select servers based on your research findings. Here is the **verified catalog** of real MCP servers with correct npm package names:

| Server | Package | Args Example | Purpose | Best For |
|--------|---------|-------------|---------|----------|
| context7 | `@upstash/context7-mcp@latest` | `["-y", "@upstash/context7-mcp@latest"]` | Up-to-date library docs | Any project using external libraries |
| filesystem | `@modelcontextprotocol/server-filesystem` | `["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"]` | Enhanced file operations | Projects with complex file structures |
| playwright | `@playwright/mcp@latest` | `["-y", "@playwright/mcp@latest"]` | Browser automation & testing | Web projects (by Microsoft) |
| postgres | `@modelcontextprotocol/server-postgres` | `["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@host:5432/db"]` | Database operations | Projects with PostgreSQL |
| sequential-thinking | `@modelcontextprotocol/server-sequential-thinking` | `["-y", "@modelcontextprotocol/server-sequential-thinking"]` | Structured reasoning | Complex problem-solving |
| github | HTTP transport | N/A (see below) | GitHub API access | Any project on GitHub |

> **Note:** Cross-session memory is handled by MetaMemory (integrated in CLAUDE.md via `mm` CLI). No need for the `@modelcontextprotocol/server-memory` MCP package.

**GitHub MCP server** uses HTTP transport, not stdio. Configure it as:
```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

**CRITICAL: Only use packages from this verified catalog or packages you have confirmed exist via web search during Phase 1.** Do NOT invent or guess package names.

Only include servers that are genuinely useful for this team type. Don't add servers just to have more — each one should serve a clear purpose.

---

## PHASE 3: COLLECT CREDENTIALS AND FINALIZE .mcp.json

**IMPORTANT: Do NOT use `claude mcp add`.** It cannot run inside a nested Claude Code session. The `.mcp.json` file was already written manually in Phase 2 (File 5) — Claude Code will auto-discover it when launched inside the project folder.

However, some MCP servers and skills require **API keys, tokens, connection strings, or other credentials** to function. You MUST check for these and ask the user to provide them.

### Step 1: Identify credentials needed

Review the `.mcp.json` you wrote and check each server:

| Server | Credential Needed | Env Var |
|--------|-------------------|---------|
| github (HTTP) | GitHub Copilot token (usually auto-handled) | — |
| postgres | Connection string | Passed as arg |
| Any server with `"env": {}` that needs keys | API key / token | Varies |

Also check if any skills you created reference external services that need authentication.

### Step 2: Ask the user for any required credentials

If any MCP server or skill needs a key/token/connection-string, use `AskUserQuestion` to ask the user. For example:

- "The postgres MCP server needs a connection string. What is your PostgreSQL connection URL? (e.g., `postgresql://user:pass@host:5432/db`)"
- "The [service] MCP server needs an API key. Please provide your API key for [service], or type 'skip' to configure it later."

**Always offer a "skip / configure later" option.** The user may not have credentials at hand. If skipped, add a comment in `.mcp.json` or a note in `CLAUDE.md` reminding them to fill it in later.

### Step 3: Update .mcp.json with credentials

After collecting credentials, update the `.mcp.json` file to fill in the actual values. For example:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@host:5432/db"],
      "env": {}
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "env": {}
    }
  }
}
```

If the user skipped a credential, leave a placeholder and add a TODO comment in CLAUDE.md:

```markdown
## TODO
- [ ] Configure [server-name] MCP server: add your API key to `.mcp.json` → `mcpServers.[name].env.API_KEY`
```

### Step 4: Pre-download npm packages (optional, best-effort)

For stdio MCP servers that use `npx -y`, you can optionally pre-download the packages so they are cached for faster first launch:

```bash
npx -y @upstash/context7-mcp@latest --help 2>/dev/null || true
npx -y @modelcontextprotocol/server-filesystem --help 2>/dev/null || true
```

This is best-effort — if it fails, it's fine. `npx -y` will download on first use anyway.

---

## PHASE 4: VERIFY AND REPORT

After all files are created and credentials collected, verify everything **from inside the project folder**:

1. Show the full project tree:
```bash
find . -type f | grep -v '.git/' | sort
```

2. Verify `.mcp.json` is valid JSON:
```bash
cat .mcp.json | python3 -m json.tool > /dev/null && echo "Valid JSON" || echo "INVALID JSON - fix it!"
```

3. Show the routing table from CLAUDE.md.

4. Print a final summary in this format:

```
## Agent Team Created Successfully

### Project Folder
<absolute-path-to-project-folder>/

### Files Created
- CLAUDE.md (orchestration hub — you are the tech lead)
- AGENTS.md → CLAUDE.md (symlink, so Kimi engine reads the same doc)
- .mcp.json (MCP server config — auto-discovered by Claude Code)
- .claude/agents/[specialist-1].md
- .claude/agents/[specialist-2].md
- .claude/agents/code-reviewer.md
- .claude/skills/[skill-1]/SKILL.md
- .claude/skills/[skill-2]/SKILL.md
- .claude/rules/[rule-1].md

### Agent Team
| Agent | Role | Model |
|-------|------|-------|
| (CLAUDE.md) | Orchestrator (main session) | — |
| [name] | [role] | sonnet |
| ... | ... | ... |

### MCP Servers Configured (in .mcp.json)
- [server-name]: [purpose] [✓ ready / ⚠ needs credentials]
- ...

### Credentials Status
- [server/skill]: ✓ configured / ⚠ skipped — add [ENV_VAR] to .mcp.json later

### Next Steps
1. The agent team is already registered and available in the Web UI sidebar
2. Review CLAUDE.md and customize the routing table for your workflow
3. Run `claude` inside the folder — agents, skills, rules, and MCP servers are all auto-discovered
4. If any credentials were skipped, edit `.mcp.json` to add them before using those MCP servers
5. Try: "Plan and implement [a feature relevant to this project type]"
6. Claude will automatically break it down and delegate to specialist agents
```

---

## PHASE 4.5: REGISTER AS BOT (Auto-Discovery)

After the team is verified, register it as a web bot so it appears in the Web UI sidebar immediately.

**Run this command from inside the project folder:**

```bash
curl -s -X POST "http://localhost:${METABOT_API_PORT:-9100}/api/bots" \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"platform\":\"web\",\"name\":\"$(basename $(pwd))\",\"description\":\"Agent team created by MetaSkill\",\"defaultWorkingDirectory\":\"$(pwd)\",\"installSkills\":true}" \
  | python3 -m json.tool 2>/dev/null || true
```

If the API call succeeds, the bot is immediately available in the Web UI sidebar — no restart needed.
If it fails (e.g., no API secret configured, or the API server is not running), skip silently — the user can add the bot manually later via the API.

---

## Critical Rules

1. **Always create a project folder first.** Never write files into the current working directory directly. Create a new subfolder, `cd` into it, then scaffold everything inside.
2. **Research first, build second.** Never skip Phase 1. The research directly improves the quality of agents and skills.
3. **NEVER use `claude mcp add`.** It cannot run inside a nested Claude Code session. Write `.mcp.json` manually — Claude Code auto-discovers it on launch.
4. **Ask for credentials.** If any MCP server or skill needs API keys, tokens, or connection strings, use `AskUserQuestion` to ask the user. Always offer a "skip / configure later" option.
5. **Every agent needs a specific description.** Vague descriptions like "general helper" are useless. Include concrete trigger scenarios.
6. **System prompts in second person.** Always "You are...", "You should...", "Your responsibility is...".
7. **Agents should be focused.** One agent = one domain of expertise. Resist making "do everything" agents.
8. **Skills use dynamic context.** Use `!`backtick`` syntax to inject live project state where it adds value.
9. **Don't over-configure MCP servers.** Only include what's genuinely useful for this team type.
10. **Only use verified MCP packages.** NEVER invent or guess npm package names. Only use packages from the verified catalog in Phase 2 File 5, or packages you confirmed exist via web search in Phase 1.
11. **Respect existing folders.** If a folder with the same name already exists, ask the user before overwriting. Suggest a different name or offer to merge.
12. **Validate frontmatter.** Every agent and skill must have valid YAML frontmatter with at minimum `name` and `description`.
13. **Init git.** Run `git init` inside the project folder so it's a proper repo from the start.
14. **Include MetaMemory integration.** Always add the "Shared Knowledge (MetaMemory)" section to CLAUDE.md. The `mm` CLI enables cross-agent knowledge sharing without needing the MCP memory server.
