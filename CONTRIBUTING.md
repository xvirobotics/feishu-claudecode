# Contributing to feishu-claudecode

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
# 1. Clone the repo
git clone https://github.com/xvirobotics/feishu-claudecode.git
cd feishu-claudecode

# 2. Install dependencies
npm install

# 3. Copy environment config
cp .env.example .env
# Edit .env with your Feishu app credentials

# 4. Build
npm run build

# 5. Run in development
npm run dev
```

**Prerequisites:** Node.js 20+, Claude Code CLI installed.

## Project Structure

```
src/
  bridge/        # Message routing & task management
  claude/        # Claude Agent SDK integration
  feishu/        # Feishu API client & card builder
  memory/        # Memory server client
  utils/         # Logger, helpers
```

## How to Contribute

### Reporting Bugs

- Use the [Bug Report](https://github.com/xvirobotics/feishu-claudecode/issues/new?template=bug_report.md) template
- Include logs (redact sensitive info) and steps to reproduce

### Suggesting Features

- Use the [Feature Request](https://github.com/xvirobotics/feishu-claudecode/issues/new?template=feature_request.md) template
- Describe the use case, not just the solution

### Submitting Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes with clear commit messages
3. Ensure `npm run build` passes with no errors
4. Open a PR with a clear description of what changed and why

## Code Style

- TypeScript strict mode
- Use `async/await` over raw promises
- Keep functions small and focused
- Add JSDoc comments for public APIs

## Questions?

Open an issue or start a discussion — we're happy to help!
