# Contributing to MetaBot

Thank you for your interest in contributing to MetaBot! This guide covers everything you need to get started — whether you're a human developer or an AI agent.

**[Chinese version / 中文版](./CONTRIBUTING_zh.md)**

## Code of Conduct

We are committed to providing a welcoming and respectful environment for everyone. Be kind, be constructive, and assume good intent. Harassment, discrimination, and personal attacks will not be tolerated.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | Runtime |
| npm | 10+ | Package manager |
| Git | 2.x+ | Version control |
| Claude Code CLI | latest | `npm i -g @anthropic-ai/claude-code` — must be authenticated |
| Feishu dev account | — | Optional, only needed for testing bot integration |

## Getting Started

```bash
# 1. Fork & clone
git clone https://github.com/<your-username>/metabot.git
cd metabot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your Feishu app credentials (see CLAUDE.md for setup guide)

# 4. Build
npm run build

# 5. Run tests
npm test

# 6. Start development server (hot reload)
npm run dev
```

### Verifying Your Setup

A successful setup looks like this:

```bash
npm run build    # No errors
npm test         # All 14 test suites pass
npm run lint     # No lint errors
```

## Project Architecture

### Message Flow

```
Feishu WSClient
  -> EventHandler (parse message, @mention filter)
    -> MessageBridge (route commands, manage tasks)
      -> ClaudeExecutor (Agent SDK query)
        -> StreamProcessor (transform to card state)
          -> Feishu card updates (streaming)
```

### Module Map

| Directory | Purpose |
|-----------|---------|
| `src/bridge/` | Message routing, task management, rate limiting, outputs |
| `src/claude/` | Claude Agent SDK integration, session management, streaming |
| `src/feishu/` | Feishu API client, card builder, message sender, doc reader |
| `src/memory/` | MetaMemory server client |
| `src/sync/` | Wiki sync (MetaMemory -> Feishu Wiki) |
| `src/utils/` | Logger (pino), helpers |
| `tests/` | Vitest test suites |

For detailed architecture docs, see [CLAUDE.md](./CLAUDE.md).

## Finding Issues

- Look for issues labeled [`good first issue`](https://github.com/xvirobotics/metabot/labels/good%20first%20issue) or [`help wanted`](https://github.com/xvirobotics/metabot/labels/help%20wanted)
- Comment on the issue to claim it before starting work
- If you want to work on something without an existing issue, open one first to discuss the approach

## Development Workflow

### Branch Strategy

```
main (stable, production)
  └── dev (active development)
       ├── feat/your-feature
       ├── fix/your-bugfix
       └── docs/your-docs-change
```

- **`main`** — Stable branch. Only receives merges from `dev` or hotfix PRs.
- **`dev`** — Active development. All day-to-day work happens here.
- Create feature branches from `dev`, not `main`.

### Branch Naming

| Prefix | Use |
|--------|-----|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation changes |
| `refactor/` | Code restructuring |
| `test/` | Adding or updating tests |
| `ci/` | CI/CD changes |

### Keeping Up to Date

```bash
git checkout dev
git pull origin dev
git checkout feat/your-feature
git rebase dev
```

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/). Every commit message should have this format:

```
<type>(<optional scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `ci` | CI/CD changes |
| `chore` | Maintenance tasks |

### Examples from Our Git Log

```
feat: remote URL config for CLI tools (#48)
fix: replace grep -oP with sed for macOS compatibility (#50)
docs: add Star History chart to READMEs (#51)
refactor: rename MEMORY_SERVER_URL to META_MEMORY_URL (#49)
fix: mb CLI auth reads .env instead of stale env vars (#44)
feat: auto-reply in 2-member group chats without @mention (#35)
```

### Rules

- Use imperative mood: "add feature" not "added feature"
- Keep the subject line under 72 characters
- Reference issue numbers in the subject when applicable: `fix: crash on empty message (#42)`
- Use the body for context on _why_, not _what_ (the diff shows what)

## Pull Request Process

### Before Submitting

1. Ensure all checks pass locally:
   ```bash
   npx tsc --noEmit    # Type check
   npm test             # Tests
   npm run lint         # Lint
   npm run build        # Build
   ```
2. Rebase on latest `dev` to avoid merge conflicts
3. Update documentation if your change affects user-facing behavior

### Submitting

1. Push your branch and open a PR targeting `dev` (or `main` for hotfixes only)
2. Fill in the [PR template](./.github/pull_request_template.md) — all sections
3. Ensure CI is green (the pipeline runs: type check -> test -> lint -> build)
4. Request a review

### Review Process

- Reviews are typically completed within 48 hours
- Address all review comments before re-requesting review
- PRs are squash-merged to keep `main` history clean
- One approval is required to merge

## Testing Guide

### What to Test

- Pure logic modules (parsers, builders, processors, utilities)
- State management (session manager, sync store)
- Edge cases in data transformation (card builder, markdown-to-blocks)

### What NOT to Test

- Feishu API calls (external service — mock at the boundary)
- Claude Agent SDK calls (external service)
- Simple config loading or re-exports

### Testing Patterns

We use [Vitest](https://vitest.dev/) with ESM imports:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock external modules
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('MyModule', () => {
  it('should do the expected thing', () => {
    // Arrange, Act, Assert
  });
});
```

Key conventions:
- Test files go in `tests/` with `.test.ts` extension
- Use `.js` extensions in imports (ESM project)
- Mock external dependencies, not internal logic
- Run tests with `npm test` (runs `vitest run`)

## Code Style

### TypeScript

- **Strict mode** enabled (`"strict": true` in tsconfig)
- **ESM project** — all imports use `.js` extensions (even for `.ts` files)
- **Target**: ES2022, **Module**: Node16
- Use `async/await` over raw promises
- Use `pino` for logging (not `console.log`)

### Formatting & Linting

Formatting is handled by Prettier, linting by ESLint:

```bash
npm run format        # Auto-format
npm run format:check  # Check formatting (CI uses this)
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix lint issues
```

**Prettier config** (`.prettierrc`):
- Single quotes, trailing commas, 120 char line width, 2-space indent, semicolons

**ESLint config** (`eslint.config.js`):
- TypeScript-ESLint recommended rules
- `@typescript-eslint/no-explicit-any`: off
- Unused vars warning (with `_` prefix exception)
- Empty functions allowed

### EditorConfig

Install the [EditorConfig plugin](https://editorconfig.org/#download) for your editor to automatically apply consistent whitespace settings.

## CI Pipeline

Every push and PR triggers the CI pipeline (`.github/workflows/ci.yml`):

```
Job: check (Node 20 + 22 matrix)
  1. Type check    — npx tsc --noEmit
  2. Run tests     — npm test
  3. Lint           — npm run lint

Job: build (Node 22, depends on check)
  4. Full build    — npm run build
```

All four steps must pass for a PR to be mergeable.

## Release Process

MetaBot follows a manual release process:

1. Merge PRs into `dev` during development
2. When ready for release, create a PR from `dev` to `main`
3. After merge, deploy via PM2 on the production server
4. Sync back: `git checkout dev && git merge main && git push`

## Agent Contributor Guidance

This section is for **AI agents** (Claude Code, Codex, Cursor, Copilot, Devin, etc.) contributing to MetaBot. Whether you're working autonomously or pair-programming with a human, follow these guidelines.

### Before You Start

1. **Read CLAUDE.md first.** It contains the full architecture, message flow, module descriptions, and configuration details. It is the single source of truth for how this project works.
2. **Read this CONTRIBUTING.md.** You're doing that now — good.
3. **Check existing issues and PRs.** Don't duplicate work that's already in progress.

### Agent PR Requirements

Agent-authored PRs must meet the same quality bar as human PRs, plus:

- **All CI checks must pass** — type check, test, lint, build. No exceptions.
- **Include `Co-Authored-By` in commit messages:**
  ```
  feat: add widget support

  Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
  ```
- **Fill in the PR template completely** — the What/Why/How sections help reviewers understand your reasoning.
- **Keep changes focused.** One PR = one logical change. Don't bundle unrelated fixes.

### Agent Context Files

| File | Purpose | When to Read |
|------|---------|--------------|
| `CLAUDE.md` | Full architecture, module map, config reference | Always — before any code change |
| `CONTRIBUTING.md` | Development workflow, conventions, CI | Always — before submitting |
| `.env.example` | All environment variables with descriptions | When touching config |
| `bots.example.json` | Multi-bot configuration format | When touching bot config |
| `SECURITY.md` | Security policy and scope | When touching auth, sessions, or input handling |

### Working with the Codebase

- **ESM imports**: Always use `.js` extensions in imports, even for TypeScript files. This is the #1 agent mistake.
  ```typescript
  // Correct
  import { something } from './my-module.js';
  // Wrong — will fail at runtime
  import { something } from './my-module';
  import { something } from './my-module.ts';
  ```

- **Logger**: Use `pino` via `createLogger()`, never `console.log`.
  ```typescript
  import { createLogger } from '../utils/logger.js';
  const logger = createLogger('my-module');
  logger.info({ data }, 'Something happened');
  ```

- **Feishu card content limit**: Card content is truncated at 28KB. If you're modifying card builder logic, keep this in mind.

- **Session isolation**: Sessions are keyed by `chatId`, not `userId`. Each chat gets its own session, working directory, and conversation history.

### Common Agent Pitfalls

| Mistake | How to Avoid |
|---------|--------------|
| Missing `.js` import extensions | Always add `.js` to relative imports |
| Using `console.log` | Use `createLogger()` from `src/utils/logger.js` |
| Modifying `main` directly | Work on `dev` branch or feature branches |
| Skipping tests | Run `npm test` before every commit |
| Overly broad changes | Keep PRs focused on one concern |
| Not updating docs | If behavior changes, update README.md, README_zh.md, and CLAUDE.md |
| Adding unnecessary dependencies | Prefer built-in Node.js APIs and existing deps |
| Hardcoding URLs or credentials | Use environment variables via `src/config.ts` |
| Ignoring TypeScript errors | `strict: true` is non-negotiable — fix all type errors |

### Agent Testing Checklist

Before submitting your PR, verify:

```bash
# 1. Type check passes
npx tsc --noEmit

# 2. All tests pass
npm test

# 3. No lint errors
npm run lint

# 4. Build succeeds
npm run build

# 5. If you added new features, did you add tests?
# 6. If you changed behavior, did you update docs?
# 7. Is your PR targeting the correct branch (dev)?
```

### Agent Autonomy Guidelines

- **Safe to do without asking**: Read files, run tests, run lint, run build, create branches, write code
- **Ask before doing**: Force-push, delete branches, modify CI config, change dependencies, alter `.env.example`
- **Never do**: Commit secrets, push to `main` directly, skip CI checks, merge your own PR

### Pair Programming with Agents

If you're a human working with an AI agent on MetaBot:

1. Point the agent to `CLAUDE.md` first — it has all the context needed
2. Use the conventional commit format — agents can follow it consistently
3. Let the agent run the full CI check locally before pushing
4. Review agent PRs with the same rigor as human PRs — agents can make subtle errors in business logic
5. Agent PRs should be squash-merged just like human PRs

## Documentation

### When to Update Docs

| Change Type | Files to Update |
|-------------|-----------------|
| New feature | README.md, README_zh.md, CLAUDE.md |
| New env variable | `.env.example`, CLAUDE.md |
| Architecture change | CLAUDE.md |
| New CLI command | README.md, README_zh.md |
| API change | CLAUDE.md |
| Bug fix | Usually none, unless it changes documented behavior |

### Documentation Style

- Keep READMEs user-focused (setup, usage, features)
- Keep CLAUDE.md developer/agent-focused (architecture, internals, config reference)
- Use bilingual docs: English (`README.md`) and Chinese (`README_zh.md`)

## Questions?

- Open an [issue](https://github.com/xvirobotics/metabot/issues/new) for bugs or feature requests
- Use [GitHub Discussions](https://github.com/xvirobotics/metabot/discussions) for questions and ideas
- Check existing issues before creating new ones
