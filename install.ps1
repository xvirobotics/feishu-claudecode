# MetaBot Installer for Windows PowerShell
# Usage:
#   irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
#   .\install.ps1 -Dir C:\opt\metabot
#   $env:METABOT_HOME = "C:\opt\metabot"; irm <url> | iex
#Requires -Version 5.1

[CmdletBinding()]
param(
    [Alias('d', 'InstallDir')]
    [string]$Dir = "",

    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    @"
MetaBot Installer (Windows)

Usage:
  .\install.ps1 [-Dir <path>]
  irm <url> | iex                        # uses default ($env:USERPROFILE\metabot) or $env:METABOT_HOME

Parameters:
  -Dir, -d <path>     Install MetaBot to <path>.
                      Priority: -Dir > `$env:METABOT_HOME > interactive prompt.
                      Default: `$env:USERPROFILE\metabot
  -Help               Show this help and exit.

Examples:
  .\install.ps1
  .\install.ps1 -Dir C:\opt\metabot
  `$env:METABOT_HOME = "C:\opt\metabot"; irm <url> | iex
"@ | Write-Host
    exit 0
}

# ============================================================================
# Configuration defaults
# ============================================================================
$MetabotRepo = if ($env:METABOT_REPO) { $env:METABOT_REPO } else { "https://github.com/xvirobotics/metabot.git" }
# $MetabotHome is resolved later (Phase 0.5) — priority: -Dir > env > prompt > default.
$DefaultMetabotHome = Join-Path $env:USERPROFILE "metabot"
$MetabotHome = $null

# ============================================================================
# Helper functions (colors via Write-Host -ForegroundColor)
# ============================================================================
function Write-Banner {
    Write-Host ""
    Write-Host "  +============================================+" -ForegroundColor Cyan
    Write-Host "  |            MetaBot Installer                |" -ForegroundColor Cyan
    Write-Host "  |     Yi sheng er, er sheng san,              |" -ForegroundColor Cyan
    Write-Host "  |         san sheng wan wu                    |" -ForegroundColor Cyan
    Write-Host "  +============================================+" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Info    { param([string]$Message) Write-Host "[INFO] " -ForegroundColor Blue -NoNewline; Write-Host $Message }
function Write-Success { param([string]$Message) Write-Host "[OK] " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Warn    { param([string]$Message) Write-Host "[WARN] " -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Write-Err     { param([string]$Message) Write-Host "[ERROR] " -ForegroundColor Red -NoNewline; Write-Host $Message }
function Write-Step    { param([string]$Message) Write-Host ""; Write-Host "==> $Message" -ForegroundColor White }

function Read-Input {
    param(
        [string]$Prompt,
        [string]$Default = ""
    )
    if ($Default) {
        Write-Host "  $Prompt " -ForegroundColor Cyan -NoNewline
        Write-Host "[$Default]: " -NoNewline
    } else {
        Write-Host "  $Prompt" -ForegroundColor Cyan -NoNewline
        Write-Host ": " -NoNewline
    }
    $input = Read-Host
    if ([string]::IsNullOrWhiteSpace($input)) { return $Default }
    return $input
}

function Read-Secret {
    param([string]$Prompt)
    Write-Host "  $Prompt" -ForegroundColor Cyan -NoNewline
    Write-Host ": " -NoNewline
    $secure = Read-Host -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Read-Choice {
    param([string]$Default = "1")
    Write-Host "  Choice " -ForegroundColor Cyan -NoNewline
    Write-Host "[$Default]: " -NoNewline
    $input = Read-Host
    if ([string]::IsNullOrWhiteSpace($input)) { return $Default }
    return $input
}

function Read-YesNo {
    param(
        [string]$Prompt,
        [string]$Default = "y"
    )
    if ($Default -eq "y") {
        Write-Host "  $Prompt " -ForegroundColor Cyan -NoNewline
        Write-Host "[Y/n]: " -NoNewline
    } else {
        Write-Host "  $Prompt " -ForegroundColor Cyan -NoNewline
        Write-Host "[y/N]: " -NoNewline
    }
    $input = Read-Host
    if ([string]::IsNullOrWhiteSpace($input)) { $input = $Default }
    return ($input.ToLower() -eq "y" -or $input.ToLower() -eq "yes")
}

function Test-Command {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ============================================================================
# Phase 0: Banner + environment detection
# ============================================================================
Write-Banner

$PSVer = $PSVersionTable.PSVersion
Write-Info "PowerShell version: $PSVer"
Write-Info "OS: $([System.Environment]::OSVersion.VersionString)"

if ($PSVer.Major -lt 5 -or ($PSVer.Major -eq 5 -and $PSVer.Minor -lt 1)) {
    Write-Err "PowerShell 5.1+ is required. Current: $PSVer"
    exit 1
}

# ============================================================================
# Phase 0.5: Resolve install directory
# Priority: -Dir parameter > $env:METABOT_HOME > interactive prompt > default.
# ============================================================================
Write-Step "Phase 0.5: Choose install directory"

if ($Dir) {
    $MetabotHome = $Dir
    Write-Info "Using install directory from -Dir: $MetabotHome"
} elseif ($env:METABOT_HOME) {
    $MetabotHome = $env:METABOT_HOME
    Write-Info "Using install directory from `$env:METABOT_HOME: $MetabotHome"
} else {
    Write-Host ""
    Write-Host "Where should MetaBot be installed?" -ForegroundColor White
    Write-Host "  (Override later with -Dir or `$env:METABOT_HOME.)"
    $MetabotHome = Read-Input "Install directory" $DefaultMetabotHome
}

# Expand a leading ~ to $env:USERPROFILE.
if ($MetabotHome.StartsWith("~")) {
    $MetabotHome = Join-Path $env:USERPROFILE ($MetabotHome.Substring(1).TrimStart('\','/'))
}

# Require a rooted path so all later $MetabotHome references are unambiguous.
if (-not [System.IO.Path]::IsPathRooted($MetabotHome)) {
    Write-Err "Install path must be absolute, got: $MetabotHome"
    exit 1
}

# Refuse a few obviously-bad targets that would clobber the user's profile or a system root.
$normalized = $MetabotHome.TrimEnd('\','/')
$forbidden = @(
    $env:USERPROFILE.TrimEnd('\','/'),
    $env:SystemDrive,                          # e.g. "C:"
    (Join-Path $env:SystemDrive 'Users').TrimEnd('\','/'),
    (Join-Path $env:SystemDrive 'Windows').TrimEnd('\','/')
) | ForEach-Object { $_.TrimEnd('\','/') }
if ($forbidden -contains $normalized -or $normalized -eq '') {
    Write-Err "Refusing to install directly into $MetabotHome — pick a dedicated subdirectory."
    exit 1
}

Write-Success "Install directory: $MetabotHome"

# ============================================================================
# Phase 1: Check prerequisites
# ============================================================================
Write-Step "Phase 1: Checking prerequisites"

$Missing = 0

# Git
if (Test-Command "git") {
    Write-Success "Git found: $((Get-Command git).Source)"
} else {
    Write-Err "Git not found. Install from https://git-scm.com/downloads"
    $Missing = 1
}

# Node.js
$NeedNode = $false
if (Test-Command "node") {
    $NodeVer = (node --version) -replace '^v', ''
    $NodeMajor = [int]($NodeVer.Split('.')[0])
    if ($NodeMajor -ge 20) {
        Write-Success "Node.js found: v$NodeVer"
    } else {
        Write-Warn "Node.js v$NodeVer found, but v20+ is required."
        $NeedNode = $true
    }
} else {
    Write-Warn "Node.js not found."
    $NeedNode = $true
}

if ($NeedNode) {
    if (Read-YesNo "Install Node.js 22.x automatically?") {
        $NodeInstalled = $false

        # Try winget
        if (-not $NodeInstalled -and (Test-Command "winget")) {
            Write-Info "Installing Node.js via winget..."
            try {
                winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
                # Refresh PATH
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                if (Test-Command "node") { $NodeInstalled = $true; Write-Success "Node.js installed via winget" }
            } catch {
                Write-Warn "winget install failed, trying alternatives..."
            }
        }

        # Try choco
        if (-not $NodeInstalled -and (Test-Command "choco")) {
            Write-Info "Installing Node.js via Chocolatey..."
            try {
                choco install nodejs-lts -y
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                if (Test-Command "node") { $NodeInstalled = $true; Write-Success "Node.js installed via Chocolatey" }
            } catch {
                Write-Warn "Chocolatey install failed, trying alternatives..."
            }
        }

        # Try scoop
        if (-not $NodeInstalled -and (Test-Command "scoop")) {
            Write-Info "Installing Node.js via scoop..."
            try {
                scoop install nodejs-lts
                if (Test-Command "node") { $NodeInstalled = $true; Write-Success "Node.js installed via scoop" }
            } catch {
                Write-Warn "scoop install failed."
            }
        }

        if (-not $NodeInstalled) {
            Write-Err "Automatic install failed. Please install Node.js 20+ manually from https://nodejs.org/"
            $Missing = 1
        }
    } else {
        Write-Err "Node.js 20+ is required. Install manually and re-run."
        exit 1
    }
}

# npm
if (Test-Command "npm") {
    Write-Success "npm found: $((Get-Command npm).Source)"
} else {
    Write-Err "npm not found. It comes with Node.js."
    $Missing = 1
}

if ($Missing -eq 1) {
    Write-Err "Please install missing prerequisites and re-run this script."
    exit 1
}

# ============================================================================
# Phase 2: Clone or update repo
# ============================================================================
Write-Step "Phase 2: Setting up MetaBot at $MetabotHome"

if (Test-Path (Join-Path $MetabotHome ".git")) {
    Write-Info "Existing installation found, pulling latest..."
    Push-Location $MetabotHome
    $OldHead = git rev-parse HEAD
    try { git pull --ff-only } catch { Write-Warn "git pull failed, continuing with existing code" }
    $NewHead = git rev-parse HEAD

    # Re-exec with updated install.ps1 if it changed
    if ($OldHead -ne $NewHead -and -not $env:METABOT_REEXEC) {
        Write-Info "install.ps1 updated, re-launching..."
        $env:METABOT_REEXEC = "1"
        & (Join-Path $MetabotHome "install.ps1")
        Pop-Location
        exit 0
    }
    Pop-Location
} else {
    Write-Info "Cloning MetaBot..."
    git clone $MetabotRepo $MetabotHome
}
Write-Success "MetaBot code ready at $MetabotHome"

# ============================================================================
# Phase 3: Install dependencies
# ============================================================================
Write-Step "Phase 3: Installing dependencies"

Push-Location $MetabotHome
Write-Info "Running npm install..."
npm install --production=false
Write-Success "npm dependencies installed"

# PM2
if (-not (Test-Command "pm2")) {
    Write-Info "Installing PM2 globally..."
    npm install -g pm2
    Write-Success "PM2 installed"
} else {
    Write-Success "PM2 already installed"
}

# Claude CLI
if (Test-Command "claude") {
    Write-Success "Claude CLI found: $((Get-Command claude).Source)"
} else {
    Write-Info "Installing Claude CLI..."
    npm install -g @anthropic-ai/claude-code
    if (Test-Command "claude") {
        Write-Success "Claude CLI installed"
    } else {
        Write-Warn "Claude CLI install failed. Install manually: npm install -g @anthropic-ai/claude-code"
    }
}
Pop-Location

# ============================================================================
# Phase 4: Interactive configuration
# ============================================================================
Write-Step "Phase 4: Configuration"

$EnvFile = Join-Path $MetabotHome ".env"
$SkipConfig = $false

if (Test-Path $EnvFile) {
    Write-Warn ".env already exists. Skipping interactive config."
    Write-Warn "Edit $EnvFile to modify settings."
    $SkipConfig = $true
}

if (-not $SkipConfig) {

    # ------ 4a: Working directory ------
    Write-Host ""
    Write-Host "Working Directory:" -ForegroundColor White
    $DefaultWorkDir = Join-Path $env:USERPROFILE "metabot-workspace"
    $WorkDir = Read-Input "Project directory for Claude to work in" $DefaultWorkDir
    if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    Write-Success "Working directory: $WorkDir"

    # ------ 4b: Claude AI authentication ------
    Write-Host ""
    Write-Host "Claude AI Authentication:" -ForegroundColor White
    Write-Host "  1) Claude Code Subscription (OAuth - run 'claude login' after install)"
    Write-Host "  2) Anthropic API Key (sk-ant-...)"
    Write-Host "  3) Third-party provider (Kimi/Moonshot, DeepSeek, GLM, etc.)"
    $AuthChoice = Read-Choice "1"

    $ClaudeAuthEnvLines = ""
    $ClaudeAuthMethod = "subscription"

    switch ($AuthChoice) {
        "1" {
            $ClaudeAuthMethod = "subscription"
            Write-Info "Using Claude Code Subscription. Run 'claude login' after install."
        }
        "2" {
            $ClaudeAuthMethod = "anthropic_key"
            $AnthropicApiKey = Read-Secret "Anthropic API Key (sk-ant-...)"
            if ([string]::IsNullOrWhiteSpace($AnthropicApiKey)) {
                Write-Err "API key is required."; exit 1
            }
            $ClaudeAuthEnvLines = "ANTHROPIC_API_KEY=$AnthropicApiKey"
        }
        "3" {
            $ClaudeAuthMethod = "third_party"
            Write-Host ""
            Write-Host "  Select provider:" -ForegroundColor White
            Write-Host "    1) Kimi/Moonshot  (https://platform.moonshot.cn)"
            Write-Host "    2) DeepSeek       (https://platform.deepseek.com)"
            Write-Host "    3) GLM/Zhipu      (https://open.bigmodel.cn)"
            Write-Host "    4) Custom URL"
            $ProviderChoice = Read-Choice "1"

            $ProviderName = ""
            $ProviderBaseUrl = ""
            $ProviderDefaultModel = ""
            $ProviderDefaultSmallModel = ""

            switch ($ProviderChoice) {
                "1" { $ProviderName = "Kimi/Moonshot"; $ProviderBaseUrl = "https://api.moonshot.ai/anthropic" }
                "2" { $ProviderName = "DeepSeek"; $ProviderBaseUrl = "https://api.deepseek.com/anthropic"
                      $ProviderDefaultModel = "deepseek-chat"; $ProviderDefaultSmallModel = "deepseek-chat" }
                "3" { $ProviderName = "GLM/Zhipu"; $ProviderBaseUrl = "https://api.z.ai/api/anthropic"
                      $ProviderDefaultModel = "glm-4.5" }
                "4" { $ProviderName = "Custom"
                      $ProviderBaseUrl = Read-Input "API Base URL (e.g. https://api.example.com/anthropic)" }
                default { $ProviderName = "Kimi/Moonshot"; $ProviderBaseUrl = "https://api.moonshot.ai/anthropic" }
            }

            Write-Info "Provider: $ProviderName ($ProviderBaseUrl)"
            $ProviderApiKey = Read-Secret "$ProviderName API Key"
            if ([string]::IsNullOrWhiteSpace($ProviderApiKey)) {
                Write-Err "API key is required."; exit 1
            }

            $ProviderModel = Read-Input "Model name (enter for default)" $ProviderDefaultModel
            $ProviderSmallModel = Read-Input "Small/fast model (enter to skip)" $ProviderDefaultSmallModel

            $ClaudeAuthEnvLines = "# $ProviderName Provider`nANTHROPIC_BASE_URL=$ProviderBaseUrl`nANTHROPIC_AUTH_TOKEN=$ProviderApiKey"
            if ($ProviderModel) { $ClaudeAuthEnvLines += "`nANTHROPIC_MODEL=$ProviderModel" }
            if ($ProviderSmallModel) { $ClaudeAuthEnvLines += "`nANTHROPIC_SMALL_FAST_MODEL=$ProviderSmallModel" }
            if ($ProviderChoice -eq "2") { $ClaudeAuthEnvLines += "`nAPI_TIMEOUT_MS=600000" }
        }
    }

    # ------ 4c: IM Bot platform + credentials ------
    Write-Host ""
    Write-Host "IM Bot Platform:" -ForegroundColor White
    Write-Host "  1) Feishu/Lark"
    Write-Host "  2) Telegram"
    Write-Host "  3) Both"
    $PlatformChoice = Read-Choice "1"

    $SetupFeishu = $false
    $SetupTelegram = $false
    switch ($PlatformChoice) {
        "1" { $SetupFeishu = $true }
        "2" { $SetupTelegram = $true }
        "3" { $SetupFeishu = $true; $SetupTelegram = $true }
        default { $SetupFeishu = $true }
    }

    $FeishuAppId = ""
    $FeishuAppSecret = ""
    if ($SetupFeishu) {
        Write-Host ""
        Write-Host "  Feishu/Lark Credentials:" -ForegroundColor White
        $FeishuAppId = Read-Input "App ID (e.g. cli_xxxx)"
        $FeishuAppSecret = Read-Secret "App Secret"
        if ([string]::IsNullOrWhiteSpace($FeishuAppId) -or [string]::IsNullOrWhiteSpace($FeishuAppSecret)) {
            Write-Err "Feishu App ID and Secret are required."; exit 1
        }
    }

    $TelegramBotToken = ""
    if ($SetupTelegram) {
        Write-Host ""
        Write-Host "  Telegram Credentials:" -ForegroundColor White
        $TelegramBotToken = Read-Secret "Bot Token (from @BotFather)"
        if ([string]::IsNullOrWhiteSpace($TelegramBotToken)) {
            Write-Err "Telegram Bot Token is required."; exit 1
        }
    }

    # ------ 4d: Bot name + auto-generated settings ------
    Write-Host ""
    Write-Host "Bot Name:" -ForegroundColor White
    $BotName = Read-Input "Name for your bot" "metabot"

    # Auto-generate API secret
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $ApiSecret = -join ($bytes | ForEach-Object { $_.ToString("x2") })

    $ApiPort = "9100"
    $LogLevel = "info"
    $MemoryServerUrl = "http://localhost:8100"

    # Claude executable path
    $ClaudePath = ""
    if (Test-Command "claude") {
        $ClaudePath = (Get-Command claude).Source
    }
}

# ============================================================================
# Phase 5: Generate .env + bots.json
# ============================================================================
Write-Step "Phase 5: Generating configuration files"

if (-not $SkipConfig) {
    # Generate .env
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $envContent = @"
# MetaBot Configuration (generated by install.ps1)
# $timestamp

# Bot config file (multi-bot mode)
BOTS_CONFIG=./bots.json

# API Server
API_PORT=$ApiPort
API_SECRET=$ApiSecret

# Claude AI Authentication
"@

    if ($ClaudeAuthMethod -eq "subscription") {
        $envContent += "`n# Using Claude Code Subscription (OAuth). Run 'claude login' to authenticate."
    } elseif ($ClaudeAuthEnvLines) {
        $envContent += "`n$ClaudeAuthEnvLines"
    }

    $envContent += @"

# Claude Settings
CLAUDE_DEFAULT_WORKING_DIRECTORY=$WorkDir
# CLAUDE_MAX_TURNS=
# CLAUDE_MAX_BUDGET_USD=
LOG_LEVEL=$LogLevel
"@

    if ($ClaudePath) {
        $envContent += "`nCLAUDE_EXECUTABLE_PATH=$ClaudePath"
    }

    $envContent += @"

# MetaMemory
META_MEMORY_URL=$MemoryServerUrl
"@

    [System.IO.File]::WriteAllText($EnvFile, $envContent, [System.Text.UTF8Encoding]::new($false))
    Write-Success ".env generated"

    # Generate bots.json (use node for safe JSON escaping)
    $BotsJson = Join-Path $MetabotHome "bots.json"
    $FeishuBotsJson = "[]"
    $TelegramBotsJson = "[]"

    if ($SetupFeishu) {
        $FeishuBotsJson = node -e "console.log(JSON.stringify([{name:process.argv[1],feishuAppId:process.argv[2],feishuAppSecret:process.argv[3],defaultWorkingDirectory:process.argv[4]}],null,2))" $BotName $FeishuAppId $FeishuAppSecret $WorkDir
        $FeishuBotsJson = $FeishuBotsJson -join "`n"
    }

    if ($SetupTelegram) {
        $TgName = $BotName
        if ($SetupFeishu) { $TgName = "$BotName-telegram" }
        $TelegramBotsJson = node -e "console.log(JSON.stringify([{name:process.argv[1],telegramBotToken:process.argv[2],defaultWorkingDirectory:process.argv[3]}],null,2))" $TgName $TelegramBotToken $WorkDir
        $TelegramBotsJson = $TelegramBotsJson -join "`n"
    }

    $botsResult = node -e "const c={};const f=JSON.parse(process.argv[1]);const t=JSON.parse(process.argv[2]);if(f.length>0)c.feishuBots=f;if(t.length>0)c.telegramBots=t;console.log(JSON.stringify(c,null,2))" $FeishuBotsJson $TelegramBotsJson
    [System.IO.File]::WriteAllText($BotsJson, ($botsResult -join "`n"), [System.Text.UTF8Encoding]::new($false))
    Write-Success "bots.json generated"
}

# ============================================================================
# Phase 6: Install skills + workspace setup
# ============================================================================
Write-Step "Phase 6: Installing skills and setting up workspace"

$SkillsDir = Join-Path $env:USERPROFILE ".claude\skills"
New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null

# Install metaskill
Write-Info "Installing metaskill skill..."
$metaskillDir = Join-Path $SkillsDir "metaskill\flows"
New-Item -ItemType Directory -Path $metaskillDir -Force | Out-Null
Copy-Item (Join-Path $MetabotHome "src\skills\metaskill\SKILL.md") (Join-Path $SkillsDir "metaskill\SKILL.md") -Force
Copy-Item (Join-Path $MetabotHome "src\skills\metaskill\flows\team.md") (Join-Path $SkillsDir "metaskill\flows\team.md") -Force
Copy-Item (Join-Path $MetabotHome "src\skills\metaskill\flows\agent.md") (Join-Path $SkillsDir "metaskill\flows\agent.md") -Force
Copy-Item (Join-Path $MetabotHome "src\skills\metaskill\flows\skill.md") (Join-Path $SkillsDir "metaskill\flows\skill.md") -Force
Write-Success "metaskill skill installed -> $(Join-Path $SkillsDir 'metaskill')"

# Install metamemory skill
Write-Info "Installing metamemory skill..."
New-Item -ItemType Directory -Path (Join-Path $SkillsDir "metamemory") -Force | Out-Null
Copy-Item (Join-Path $MetabotHome "src\memory\skill\SKILL.md") (Join-Path $SkillsDir "metamemory\SKILL.md") -Force
# Clean up old skill location if it exists
$oldSkillDir = Join-Path $env:USERPROFILE ".claude\skills\memory"
if (Test-Path $oldSkillDir) { Remove-Item $oldSkillDir -Recurse -Force }
Write-Success "metamemory skill installed -> $(Join-Path $SkillsDir 'metamemory')"

# Install metabot skill
Write-Info "Installing metabot skill..."
New-Item -ItemType Directory -Path (Join-Path $SkillsDir "metabot") -Force | Out-Null
Copy-Item (Join-Path $MetabotHome "src\skills\metabot\SKILL.md") (Join-Path $SkillsDir "metabot\SKILL.md") -Force
Write-Success "metabot skill installed -> $(Join-Path $SkillsDir 'metabot')"

# Install voice skill
Write-Info "Installing voice skill..."
New-Item -ItemType Directory -Path (Join-Path $SkillsDir "voice") -Force | Out-Null
Copy-Item (Join-Path $MetabotHome "src\skills\voice\SKILL.md") (Join-Path $SkillsDir "voice\SKILL.md") -Force
Write-Success "voice skill installed -> $(Join-Path $SkillsDir 'voice')"

# Install skill-hub skill
Write-Info "Installing skill-hub skill..."
New-Item -ItemType Directory -Path (Join-Path $SkillsDir "skill-hub") -Force | Out-Null
Copy-Item (Join-Path $MetabotHome "src\skills\skill-hub\SKILL.md") (Join-Path $SkillsDir "skill-hub\SKILL.md") -Force
Write-Success "skill-hub skill installed -> $(Join-Path $SkillsDir 'skill-hub')"

# Install feishu-doc skill (only when Feishu is configured)
$HasFeishu = $false
if (-not $SkipConfig -and $SetupFeishu) {
    $HasFeishu = $true
} elseif ($SkipConfig -and (Test-Path (Join-Path $MetabotHome "bots.json"))) {
    try {
        $result = node -e "const c=JSON.parse(require('fs').readFileSync('$(Join-Path $MetabotHome "bots.json")','utf-8'));process.exit((c.feishuBots||[]).length>0?0:1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $HasFeishu = $true }
    } catch {}
}
$feishuDocSkill = Join-Path $MetabotHome "src\skills\feishu-doc\SKILL.md"
if ($HasFeishu -and (Test-Path $feishuDocSkill)) {
    Write-Info "Installing feishu-doc skill..."
    New-Item -ItemType Directory -Path (Join-Path $SkillsDir "feishu-doc") -Force | Out-Null
    Copy-Item $feishuDocSkill (Join-Path $SkillsDir "feishu-doc\SKILL.md") -Force
    Write-Success "feishu-doc skill installed -> $(Join-Path $SkillsDir 'feishu-doc')"
}

# Determine working directory for deployment
$DeployWorkDir = ""
if (-not $SkipConfig) {
    $DeployWorkDir = $WorkDir
} else {
    $botsJsonPath = Join-Path $MetabotHome "bots.json"
    if (Test-Path $botsJsonPath) {
        try {
            $DeployWorkDir = node -e "const fs=require('fs');const cfg=JSON.parse(fs.readFileSync('$botsJsonPath','utf-8'));const bots=[...(cfg.feishuBots||[]),...(cfg.telegramBots||[])];if(bots[0])console.log(bots[0].defaultWorkingDirectory)" 2>$null
            $DeployWorkDir = ($DeployWorkDir -join "").Trim()
        } catch { $DeployWorkDir = "" }
    }
}

# Deploy skills + CLAUDE.md to bot working directory
if ($DeployWorkDir) {
    $SkillsDest = Join-Path $DeployWorkDir ".claude\skills"

    $deploySkills = @("metaskill", "metamemory", "metabot", "voice", "skill-hub")
    if ($HasFeishu) { $deploySkills += "feishu-doc" }

    foreach ($skill in $deploySkills) {
        $skillSrc = Join-Path $SkillsDir $skill
        if (Test-Path $skillSrc) {
            $skillDst = Join-Path $SkillsDest $skill
            New-Item -ItemType Directory -Path $skillDst -Force | Out-Null
            Copy-Item "$skillSrc\*" $skillDst -Recurse -Force
            Write-Success "Deployed $skill -> $skillDst"
        }
    }

    # Deploy CLAUDE.md to working directory
    $workspaceClaude = Join-Path $MetabotHome "src\workspace\CLAUDE.md"
    if (Test-Path $workspaceClaude) {
        Copy-Item $workspaceClaude (Join-Path $DeployWorkDir "CLAUDE.md") -Force
        Write-Success "Deployed CLAUDE.md -> $(Join-Path $DeployWorkDir 'CLAUDE.md')"
    }
} else {
    Write-Warn "Could not determine working directory, skipping workspace deployment"
}

# Install CLI tools with .cmd wrappers for CMD/PowerShell
$LocalBin = Join-Path $env:USERPROFILE ".local\bin"
New-Item -ItemType Directory -Path $LocalBin -Force | Out-Null

$HasBash = Test-Command "bash"

$cliTools = @("mm", "mb", "metabot")
if ($HasFeishu) { $cliTools += "fd" }

if ($HasBash) {
    foreach ($cli in $cliTools) {
        $srcScript = Join-Path $MetabotHome "bin\$cli"
        if (Test-Path $srcScript) {
            # Copy the bash script
            Copy-Item $srcScript (Join-Path $LocalBin $cli) -Force

            # Patch secrets into the standalone script
            $scriptPath = Join-Path $LocalBin $cli
            if ($ApiSecret) {
                (Get-Content $scriptPath -Raw) -replace 'changeme', $ApiSecret | Set-Content $scriptPath -NoNewline
            }
            if ($ApiPort -and $cli -eq "mb") {
                (Get-Content $scriptPath -Raw) -replace '9100', $ApiPort | Set-Content $scriptPath -NoNewline
            }

            # Create .cmd wrapper: @bash "%~dp0mm" %*
            $cmdContent = "@bash `"%~dp0$cli`" %*"
            $cmdContent | Out-File -FilePath (Join-Path $LocalBin "$cli.cmd") -Encoding ascii -NoNewline
        }
    }

    # Ensure LocalBin is in user PATH
    $UserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$LocalBin*") {
        [System.Environment]::SetEnvironmentVariable("Path", "$LocalBin;$UserPath", "User")
        $env:Path = "$LocalBin;$env:Path"
        Write-Info "Added $LocalBin to user PATH"
    }

    if ($HasFeishu) {
        Write-Success "mm/mb/metabot/fd CLI tools installed to $LocalBin (with .cmd wrappers)"
    } else {
        Write-Success "mm/mb/metabot CLI tools installed to $LocalBin (with .cmd wrappers)"
    }
} else {
    Write-Warn "Git Bash not found. CLI tools (mm, mb, metabot) require bash."
    Write-Warn "Install Git for Windows (https://git-scm.com) to enable CLI tools."
}

# Persist METABOT_HOME for non-default install paths so the CLI tools
# (mm/mb/metabot) can find the install in new shell sessions. The CLIs all
# fall back to ~/metabot, so we only need to persist when it differs.
if ($MetabotHome -ne $DefaultMetabotHome) {
    [System.Environment]::SetEnvironmentVariable("METABOT_HOME", $MetabotHome, "User")
    $env:METABOT_HOME = $MetabotHome
    Write-Info "Persisted METABOT_HOME=$MetabotHome to user environment"
}

# ============================================================================
# Phase 7: MetaMemory
# ============================================================================
Write-Step "Phase 7: MetaMemory"

$MetamemoryInstalled = $false

Write-Info "MetaMemory is embedded in MetaBot (no separate server needed)."
New-Item -ItemType Directory -Path (Join-Path $MetabotHome "data") -Force | Out-Null

# Migrate existing database from standalone MetaMemory if found
$OldDb = Join-Path $env:USERPROFILE ".metamemory-data\metamemory.db"
$NewDb = Join-Path $MetabotHome "data\metamemory.db"
if ((Test-Path $OldDb) -and -not (Test-Path $NewDb)) {
    Write-Info "Migrating existing MetaMemory database..."
    Copy-Item $OldDb $NewDb -Force
    Write-Success "Database migrated from ~/.metamemory-data/"
}

# Stop old standalone MetaMemory PM2 process if running
try {
    $pm2Desc = pm2 describe metamemory 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Info "Stopping old standalone MetaMemory PM2 process..."
        pm2 delete metamemory 2>$null
        Write-Success "Old MetaMemory process removed"
    }
} catch {}

# Kill any process occupying port 8100
try {
    $port8100 = Get-NetTCPConnection -LocalPort 8100 -ErrorAction SilentlyContinue
    if ($port8100) {
        foreach ($conn in $port8100) {
            Write-Info "Killing old process on port 8100 (PID: $($conn.OwningProcess))..."
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
} catch {}

$MetamemoryInstalled = $true
Write-Success "MetaMemory will start automatically with MetaBot on port 8100"

# ============================================================================
# Phase 8: Build + Start MetaBot with PM2
# ============================================================================
Write-Step "Phase 8: Starting MetaBot"

Push-Location $MetabotHome

Write-Info "Building TypeScript..."
try {
    npm run build 2>$null
    Write-Success "Build complete"
} catch {
    Write-Warn "Build failed, will use tsx directly via PM2"
}

# Always delete + start fresh
try {
    $pm2Desc = pm2 describe metabot 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Info "Removing old MetaBot PM2 process..."
        pm2 delete metabot 2>$null
    }
} catch {}

Write-Info "Starting MetaBot with PM2..."
pm2 start ecosystem.config.cjs

try { pm2 save --force 2>$null } catch {}
Write-Success "MetaBot is running!"
Pop-Location

# ============================================================================
# Phase 9: Summary
# ============================================================================
Write-Host ""
Write-Host "  +============================================+" -ForegroundColor Green
Write-Host "  |           MetaBot -- Ready!                |" -ForegroundColor Green
Write-Host "  +============================================+" -ForegroundColor Green
Write-Host ""

Write-Host "  Installation:   " -ForegroundColor White -NoNewline; Write-Host $MetabotHome
if (-not $SkipConfig) {
    Write-Host "  Working Dir:    " -ForegroundColor White -NoNewline; Write-Host $WorkDir
    Write-Host "  API:            " -ForegroundColor White -NoNewline; Write-Host "http://localhost:$ApiPort"
    $secretPreview = $ApiSecret.Substring(0, 8) + "..." + $ApiSecret.Substring($ApiSecret.Length - 4)
    Write-Host "  API Secret:     " -ForegroundColor White -NoNewline; Write-Host $secretPreview
    Write-Host "  Auth Method:    " -ForegroundColor White -NoNewline; Write-Host $ClaudeAuthMethod
    if ($ClaudeAuthMethod -eq "third_party") {
        Write-Host "  Provider:       " -ForegroundColor White -NoNewline; Write-Host $ProviderName
    }
}
if ($MetamemoryInstalled) {
    Write-Host "  MetaMemory:     " -ForegroundColor White -NoNewline; Write-Host "http://localhost:8100"
}

Write-Host ""
Write-Host "  Commands:" -ForegroundColor White
Write-Host "    pm2 logs metabot          # View MetaBot logs"
Write-Host "    pm2 restart metabot       # Restart MetaBot"
Write-Host "    pm2 stop metabot          # Stop MetaBot"
if ($MetamemoryInstalled) {
    Write-Host "    mm search <query>         # Search MetaMemory"
    Write-Host "    mm folders                # Browse knowledge tree"
}

Write-Host ""
if (-not $SkipConfig) {
    Write-Host "  Next Steps:" -ForegroundColor White
    $StepNum = 1
    if ($ClaudeAuthMethod -eq "subscription") {
        Write-Host "    $StepNum. Run 'claude login' in a separate terminal"
        $StepNum++
    }
    if ($SetupFeishu) {
        Write-Host "    $StepNum. Configure Feishu app: enable long-connection events + im.message.receive_v1 + publish"
        $StepNum++
        Write-Host "    $StepNum. Open Feishu and message your bot"
        $StepNum++
    }
    if ($SetupTelegram) {
        Write-Host "    $StepNum. Open Telegram and message your bot -- it's ready now!"
        $StepNum++
    }
    Write-Host "    $StepNum. Check logs: pm2 logs metabot"
}
Write-Host ""
