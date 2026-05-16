# Troubleshooting & Prerequisites

← back to [CLAUDE.md](../../CLAUDE.md)

## Prerequisites

Before running the service, ensure:

1. **Node.js 20+** is installed.
2. **At least one engine CLI is installed and authenticated** — MetaBot spawns the selected engine's CLI as a subprocess. Install only the engine(s) you intend to use; each bot picks one via `engine` in its config.

   **Claude Code (default)** — `engine: "claude"`
   - Install: `npm install -g @anthropic-ai/claude-code`
   - Authenticate (one of):
     - **OAuth login (recommended)**: Run `claude login` in a standalone terminal and complete the browser flow.
     - **API Key**: Set `ANTHROPIC_API_KEY=sk-ant-...` in `.env` or your shell environment.
   - Verify: Run `claude --version` and `claude "hello"` in a standalone terminal.
   - **Important**: You cannot run `claude login` or `claude auth status` from inside a Claude Code session (nested sessions are blocked). Always use a separate terminal.

   **Kimi Code** — `engine: "kimi"`
   - Install: `npm install -g @moonshot-ai/kimi-code`
   - Authenticate: `kimi login` (OAuth, uses your Moonshot subscription) or set `KIMI_API_KEY` in `.env`.
   - Verify: `kimi --version`.

   **Codex CLI** — `engine: "codex"`
   - Install the Codex CLI (see the upstream project README for platform-specific binaries).
   - Authenticate: `codex login` in a standalone terminal, or configure a profile / API key in `~/.codex/config.toml`.
   - Verify: `codex exec --help`.
   - Optional per-bot overrides: `codex.model`, `codex.profile`, `codex.approvalPolicy` (`untrusted` | `on-failure` | `on-request` | `never`), `codex.sandbox` (`read-only` | `workspace-write` | `danger-full-access`), `codex.extraArgs` (extra argv passed verbatim to `codex exec`), `codex.env` (extra env vars for the subprocess). `CODEX_EXECUTABLE_PATH` env var overrides auto-detection; `CODEX_APPROVAL_POLICY` / `CODEX_SANDBOX` provide global defaults.
   - Session continuity uses `codex exec resume <thread_id>` — MetaBot stores the Codex thread id per `chatId` just like Claude sessions.
   - Interactive tool approvals (`sendAnswer` / `resolveQuestion`) are **not** supported under Codex — use `approvalPolicy: "never"` and a sandbox level you trust, since the bridge cannot surface approval prompts back to Feishu.

3. **Feishu app is configured** — See the [Feishu setup guide](feishu-setup.md).

## Troubleshooting

### "Error: Claude Code process exited with code 1"

The bot starts but replies with this error when you message it. This means the Agent SDK's subprocess (`claude`) failed to launch properly. There are two causes:

**Cause A: Claude CLI is not authenticated.** The SDK spawns `claude` as a child process — if it has no valid credentials, it exits immediately with code 1.

**Fix** (run in a **separate terminal**, not inside Claude Code):

```bash
# Option A: OAuth login
claude login

# Option B: API key — add to .env
echo 'ANTHROPIC_API_KEY=sk-ant-your-key' >> /path/to/metabot/.env
```

Then restart the service:

```bash
pkill -f "tsx src/index.ts"
cd /path/to/metabot && npm run dev
```

**Cause B: Running as root/sudo.** Claude Code blocks `--dangerously-skip-permissions` under root privileges. Check `pm2 logs metabot` for: `--dangerously-skip-permissions cannot be used with root/sudo privileges`. MetaBot automatically switches to `permissionMode: auto` when it detects root — ensure you're on a version that includes this fix.

### Service won't connect to Feishu

If the service starts but Feishu events don't arrive:

1. Ensure the Feishu app event subscription mode is **"persistent connection"** (WebSocket), not HTTP callback.
2. The service must be running **before** you save the event subscription config — Feishu validates the WS connection on save.
3. Check that `im.message.receive_v1` event is subscribed.
4. Ensure the app version is **published and enabled** in the Feishu dev console.

### Bot doesn't reply in group chats

The bot only responds when **@mentioned** in group chats. In DMs it replies to all messages. This is by design in `event-handler.ts`.
