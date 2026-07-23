# Installation

## Requirements

- **Node.js >= 22.19**
- Git
- Credentials for at least one engine and one chat channel
- Linux/macOS for the complete signed-checksum personal-edition lifecycle

Codex is the default engine. Kimi Code is a first-class alternative; Claude
Code is an optional compatibility engine for existing workspaces.

## One-Line Install

=== "Linux / macOS"

    ```bash
    curl -fsSL https://github.com/xvirobotics/metabot/releases/latest/download/install.sh | bash
    ```

=== "Windows (PowerShell)"

    ```powershell
    irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
    ```

The Linux/macOS installer:

1. downloads the current public GitHub Release and verifies `SHA256SUMS`;
2. installs the local Core, token-only Web UI, Bridge, CLI, and bundled Skills;
3. stores the generated Core token at `~/.metabot-core/token` with mode `0600`;
4. prompts for a workspace, engine, authentication, and IM channel; and
5. starts Core and Bridge as separate PM2 applications.

The local personal console is `http://localhost:9200`. The installer does not
print the raw token into logs. Core data is stored under `~/.metabot-core/` and
Bridge state under `~/.metabot/` by default.

To install elsewhere:

```bash
METABOT_HOME=/opt/metabot bash install.sh
```

The default directory is `~/metabot`.

## Engine Authentication

Run login commands from a standalone terminal.

### Codex CLI (default)

```bash
npm install -g @openai/codex
codex login
```

MetaBot's public adapter currently uses `codex exec --json` and
`codex exec resume`. It does not require or claim Codex app-server support.

### Kimi Code 0.27+

```bash
npm install -g @moonshot-ai/kimi-code@latest
kimi login
```

MetaBot uses Kimi Code's official loopback Server API, the same frontend
contract used by Kimi's web UI. Legacy Python `kimi-cli --wire` integrations
are not supported by this path.

### Claude Code compatibility

Install and run `claude login` only when an existing bot or workspace selects
`"engine": "claude"`.

## Update

For a normal package-managed personal edition, the default command upgrades to
the latest GitHub Release:

```bash
metabot update
```

To install one immutable release instead of following `latest`:

```bash
metabot update --package --version 1.3.0
```

The pinned form downloads `install.sh`, `metabot-runtime.tgz`, and
`SHA256SUMS` from the GitHub v1.3.0 Release. Package updates verify the runtime
SHA256, validate the complete personal-edition manifest and semantic version,
and fail closed if a pinned package reports a different version.

Source checkouts use Git explicitly:

```bash
metabot update --git
```

The package overlay preserves `.env`, `bots.json`, `data/`, `logs/`, `.git/`,
workspace instructions, and locally modified Skills. User and Core state under
`~/.metabot/` and `~/.metabot-core/` is outside the runtime overlay and is also
preserved. The package-owned `~/.metabot/default.env` may be refreshed with new
safe defaults; other user-created state in that directory is not removed.
Release and source update paths are kept separate.

## Existing External Core

To install only the Bridge and point it at an existing Core:

```bash
METABOT_INSTALL_CORE=0 bash install.sh
```

Configure `METABOT_CORE_URL` and `METABOT_CORE_TOKEN`. The installer will not
replace a foreign Core PM2 process or its data.

## Source Development Install

```bash
git clone https://github.com/xvirobotics/metabot.git ~/metabot
cd ~/metabot
npm ci --include=dev
cp bots.example.json bots.json
cp .env.example .env
npm run dev
```

## Windows Notes

The PowerShell installer configures the Bridge and installs a `.cmd` wrapper
for the `metabot` CLI. It requires Git for Windows. The complete local
Core/Web UI lifecycle remains provided by the Linux/macOS Release installer
until Windows reaches packaging parity.

The installer fails if dependency installation, the build, or PM2 startup
fails, and waits for the Bridge health endpoint at `http://127.0.0.1:9100/api/health`.
On failure it prints only bounded PM2 and log diagnostics. It does not install,
stop, or delete a Core/MetaMemory service. Configure an existing Core with
`METABOT_CORE_URL` and `METABOT_CORE_TOKEN`; standalone port `8100` is obsolete.

The generated wrapper records the absolute, quoted Git Bash path. The legacy
`C:\Windows\System32\bash.exe` WSL launcher is intentionally rejected because
it cannot execute the wrapper's Windows-style script path. If Git Bash is
missing, install Git for Windows and rerun `install.ps1`.

Next: [Quick Setup](quick-setup.md) or the detailed
[Feishu App Setup](feishu-app-setup.md).
