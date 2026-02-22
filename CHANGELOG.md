# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- CONTRIBUTING.md with development setup guide
- GitHub Actions CI workflow (Node.js 20/22 build + type check)
- Issue templates for bug reports and feature requests
- README badges (CI, license, stars)

### Fixed
- Timeout error message now correctly shows "1 hour limit" instead of "10 min limit"
- Memory client API response format handling (unwrapArray/unwrapSingle)

## [1.0.0] - 2025-02-20

### Added
- Feishu/Lark to Claude Code bridge via Agent SDK
- Real-time streaming card updates
- Multi-bot support (multiple Feishu apps in one process)
- Multi-user parallel sessions (per-chat isolation)
- Multi-turn conversations with session persistence
- Image support (send to Claude, receive generated images)
- File upload/download support
- MCP server integration (loads from Claude Code settings)
- Interactive Q&A (Claude can ask questions, user answers in chat)
- Status cards with color-coded states, tool call tracking, cost/duration
- Memory server integration (MetaMemory)
- Bot commands: `/help`, `/reset`, `/stop`, `/status`, `/memory`
- Authorization via user IDs and chat IDs
- PM2 deployment with auto-restart
