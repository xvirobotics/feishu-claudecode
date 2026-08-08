# Security

MetaBot agents can read, write, and execute code in their configured
workspaces. Treat the workspace, engine policy, channel visibility, and local
tokens as one security boundary.

## Engine execution

### Codex

The Personal Edition default is:

```text
approvalPolicy = never
sandbox = workspace-write
```

Codex does not pause for interactive approval, but its filesystem scope remains
the configured workspace. Enable `danger-full-access` or
`CODEX_BYPASS_APPROVALS_AND_SANDBOX=true` only when the host itself is an
intentional isolation boundary.

### Kimi Code

Kimi defaults to `permissionMode: auto`. MetaBot does not automatically approve
pending tool requests. Set `permissionMode: yolo` only for a trusted workspace
where unattended execution is intended. Kimi Server URLs are loopback-only by
default so local credentials are not sent to a remote server.

### Claude compatibility

Claude workspaces retain their compatibility permission behavior. Prefer a
non-root service account and limit each bot to the smallest required workspace.

## Core Console token

The installer creates `~/.metabot-core/token` with mode `0600`. The token grants
access to Chat, Agents, Memory, Skills, T5T, Teams, and CLI APIs.

```bash
stat -c '%a %n' ~/.metabot-core/token
```

- never commit or paste the token into logs;
- rotate it if it is exposed;
- keep Core bound to loopback unless it is behind authenticated HTTPS or a
  private network.

## Bridge API

Bridge port `9100` binds to `127.0.0.1` by default and non-health API routes
require a Bearer credential. If remote Bridge commands are required, generate a
separate secret, set `API_HOST` explicitly, and terminate TLS at your own proxy:

```bash
openssl rand -hex 32
```

Do not expose raw ports `9100` or `9200` directly to the public internet.
Do not pass Bridge credentials in `token=` query strings; use
`Authorization: Bearer ...` for HTTP and non-browser WebSocket clients, or
`metabot-bearer.<secret>` as a WebSocket subprotocol for browser clients.

## Channels

- Restrict Feishu/Lark app visibility and publish only required permissions.
- Keep Telegram, Slack, and WeChat tokens or Slack signing secrets out of
  `bots.json` copies, screenshots, and issues.
- Slack Events API requests are accepted only after Slack HMAC signature and
  timestamp verification.
- Group replies use exact `@Bot` routing. Reply-mode changes are group-owner
  gated and fail closed when ownership cannot be verified.

## Memory sharing

Memory paths organize documents; they do not grant access. A document is
cross-agent readable only when it is explicitly shared:

```bash
metabot memory create "Private" "..." --no-share
metabot memory share <document-id> on
```

Never store credentials, device codes, or authorization URLs in shared memory.

## Recommended baseline

1. Use one least-privilege service account per deployment.
2. Give each bot only the workspace it needs.
3. Keep Codex in `workspace-write` and Kimi in `auto` unless there is a clear
   reason to broaden execution.
4. Keep local tokens at mode `0600` and raw services on loopback.
5. Review Core Console run, tool, and output-file activity regularly.
6. Update through verified GitHub Release assets with `metabot update`.
