# metabot CLI

The `metabot` command manages the MetaBot service lifecycle.

## Installation

Installed automatically by the MetaBot installer to `~/.local/bin/metabot`.

## Commands

```bash
metabot update                      # pull latest code, rebuild, update skills, restart
metabot start                       # start with PM2
metabot stop                        # stop
metabot restart                     # restart
metabot logs                        # view live logs
metabot status                      # PM2 process status
```

## Update

`metabot update` is the recommended way to update MetaBot. It performs:

1. `git pull` — fetch latest code
2. `npm install && npm run build` — rebuild
3. Copy bundled MetaBot skills into Claude/Codex skill directories
4. If `lark-cli` or lark skills are already installed, update `@larksuite/cli` and refresh the lark AI Agent skills
5. Sync skills into the configured bot workspace
6. `pm2 restart` — restart the service

All in one command.
