# MetaBot Installer for Windows PowerShell
# Usage:
#   git clone https://github.com/xvirobotics/metabot.git $env:USERPROFILE\metabot
#   cd $env:USERPROFILE\metabot
#   .\install.ps1
#   # Optional: .\install.ps1 -Dir C:\opt\metabot
#   # Optional: $env:METABOT_HOME = "C:\opt\metabot"; .\install.ps1
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
  git clone https://github.com/xvirobotics/metabot.git
  cd metabot
  .\install.ps1 [-Dir <path>]

Parameters:
  -Dir, -d <path>     Install MetaBot to <path>.
                      Priority: -Dir > `$env:METABOT_HOME > interactive prompt.
                      Default: `$env:USERPROFILE\metabot
  -Help               Show this help and exit.

Examples:
  .\install.ps1
  .\install.ps1 -Dir C:\opt\metabot
  `$env:METABOT_HOME = "C:\opt\metabot"; .\install.ps1
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

function Backup-SkillPath {
    param([string]$Source, [string]$BackupRoot)
    if (-not (Test-Path -LiteralPath $Source)) { return }
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    $backup = Join-Path $BackupRoot ("{0}.{1}" -f (Split-Path $Source -Leaf), [guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $Source -Destination $backup
}

function Install-SkillBundle {
    param([string]$Source, [string]$Destination, [string]$BackupRoot)
    if (Test-Path -LiteralPath $Destination) {
        Backup-SkillPath $Destination $BackupRoot
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}

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

function Test-VersionAtLeast {
    param(
        [string]$Version,
        [string]$Minimum
    )
    try {
        return ([version]($Version.TrimStart('v')) -ge [version]($Minimum.TrimStart('v')))
    } catch {
        return $false
    }
}

function Assert-NativeSuccess {
    param([string]$Operation)
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Wait-BridgeHealth {
    param(
        [string]$Url,
        [int]$Attempts = 15,
        [int]$DelaySeconds = 1
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                return $true
            }
        } catch {
            # The bridge can take a few seconds to load dependencies and bots.
        }
        if ($attempt -lt $Attempts) {
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    return $false
}

function Write-BridgeDiagnostics {
    param(
        [string]$InstallDir,
        [int]$MaxLogLines = 40
    )

    Write-Warn "Bridge health check failed. Showing bounded diagnostics:"
    try {
        & pm2 describe metabot 2>&1 | Select-Object -First 80 | Out-Host
    } catch {
        Write-Warn "Unable to read PM2 process details: $($_.Exception.Message)"
    }

    foreach ($relativePath in @("logs\error.log", "logs\out.log")) {
        $logPath = Join-Path $InstallDir $relativePath
        if (Test-Path $logPath) {
            Write-Host ""
            Write-Host "--- Last $MaxLogLines lines of $relativePath ---" -ForegroundColor Yellow
            Get-Content -LiteralPath $logPath -Tail $MaxLogLines -ErrorAction SilentlyContinue | Out-Host
        }
    }
}

function Test-GitBashPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
        $system32 = [System.IO.Path]::GetFullPath((Join-Path $env:WINDIR "System32"))
        if ($fullPath.StartsWith($system32, [System.StringComparison]::OrdinalIgnoreCase)) {
            # C:\Windows\System32\bash.exe is the legacy WSL launcher. It
            # cannot execute a Windows path such as C:\Users\...\metabot.
            return $false
        }
        if ([System.IO.Path]::GetFileName($fullPath) -ine "bash.exe") {
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

function Resolve-GitBashPath {
    $roots = New-Object System.Collections.Generic.List[string]

    # Derive the installation root from the Git executable first. This works
    # for custom locations as well as the default "Program Files\Git" path.
    try {
        $gitCommand = Get-Command git -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        $gitDir = Split-Path -Parent $gitCommand.Source
        $gitDirName = Split-Path -Leaf $gitDir
        if ($gitDirName -ieq "cmd" -or $gitDirName -ieq "bin") {
            $candidateRoot = Split-Path -Parent $gitDir
            if ((Split-Path -Leaf $candidateRoot) -ieq "mingw64") {
                $candidateRoot = Split-Path -Parent $candidateRoot
            }
            $roots.Add($candidateRoot)
        }
    } catch {}

    if ($env:ProgramFiles) {
        $roots.Add((Join-Path $env:ProgramFiles "Git"))
    }
    if (${env:ProgramFiles(x86)}) {
        $roots.Add((Join-Path ${env:ProgramFiles(x86)} "Git"))
    }
    if ($env:LOCALAPPDATA) {
        $roots.Add((Join-Path $env:LOCALAPPDATA "Programs\Git"))
    }

    $seen = @{}
    foreach ($root in $roots) {
        foreach ($relativePath in @("bin\bash.exe", "usr\bin\bash.exe")) {
            $candidate = Join-Path $root $relativePath
            if ($seen.ContainsKey($candidate)) { continue }
            $seen[$candidate] = $true
            if (Test-GitBashPath $candidate) {
                return [System.IO.Path]::GetFullPath($candidate)
            }
        }
    }
    return $null
}

function Get-KimiCodeVersion {
    if (-not (Test-Command "kimi")) { return $null }
    try {
        $versionOutput = ((& kimi --version 2>$null) | Select-Object -First 1).ToString()
        if ($versionOutput -match '([0-9]+\.[0-9]+\.[0-9]+)') { return $Matches[1] }
    } catch {}
    return $null
}

function Install-KimiCode {
    $installedVersion = Get-KimiCodeVersion
    if ($installedVersion -and (Test-VersionAtLeast $installedVersion "0.27.0")) {
        Write-Success "Kimi Code found: $((Get-Command kimi).Source) (v$installedVersion)"
        return $true
    }
    if (Test-Command "kimi") {
        Write-Warn "The installed Kimi CLI is older than 0.27.0 or has an unreadable version; upgrading."
    }

    Write-Info "Installing Kimi Code 0.27+ from npm..."
    try {
        & npm install -g "@moonshot-ai/kimi-code@latest" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm exited with code $LASTEXITCODE" }
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } catch {
        Write-Warn "Kimi Code install failed: $($_.Exception.Message)"
    }

    $installedVersion = Get-KimiCodeVersion
    if ($installedVersion -and (Test-VersionAtLeast $installedVersion "0.27.0")) {
        Write-Success "Kimi Code installed: $((Get-Command kimi).Source) (v$installedVersion)"
        return $true
    }
    Write-Warn "Kimi Code 0.27+ verification failed. Install manually with 'npm install -g @moonshot-ai/kimi-code@latest'."
    return $false
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

# Node.js (Kimi Code 0.27+ and MetaBot require 22.19.0 or newer.)
$MinimumNodeVersion = "22.19.0"
$NeedNode = $false
if (Test-Command "node") {
    $NodeVer = (node --version) -replace '^v', ''
    if (Test-VersionAtLeast $NodeVer $MinimumNodeVersion) {
        Write-Success "Node.js found: v$NodeVer"
    } else {
        Write-Warn "Node.js v$NodeVer found, but v$MinimumNodeVersion+ is required."
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
                if ((Test-Command "node") -and (Test-VersionAtLeast ((node --version) -replace '^v', '') $MinimumNodeVersion)) { $NodeInstalled = $true; Write-Success "Node.js installed via winget" }
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
                if ((Test-Command "node") -and (Test-VersionAtLeast ((node --version) -replace '^v', '') $MinimumNodeVersion)) { $NodeInstalled = $true; Write-Success "Node.js installed via Chocolatey" }
            } catch {
                Write-Warn "Chocolatey install failed, trying alternatives..."
            }
        }

        # Try scoop
        if (-not $NodeInstalled -and (Test-Command "scoop")) {
            Write-Info "Installing Node.js via scoop..."
            try {
                scoop install nodejs-lts
                if ((Test-Command "node") -and (Test-VersionAtLeast ((node --version) -replace '^v', '') $MinimumNodeVersion)) { $NodeInstalled = $true; Write-Success "Node.js installed via scoop" }
            } catch {
                Write-Warn "scoop install failed."
            }
        }

        if (-not $NodeInstalled) {
            Write-Err "Automatic install failed. Please install Node.js $MinimumNodeVersion+ manually from https://nodejs.org/"
            $Missing = 1
        }
    } else {
        Write-Err "Node.js $MinimumNodeVersion+ is required. Install manually and re-run."
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
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Err "git pull --ff-only failed at $MetabotHome."
        Write-Err "Your checkout has diverged from origin or has uncommitted changes."
        Write-Err "Continuing with stale code would silently break later phases (e.g. Phase 6 'skill not found')."
        Write-Err ""
        Write-Err "Fix one of these and re-run install.ps1:"
        Write-Err "  - Inspect: cd $MetabotHome; git status; git log --oneline -5"
        Write-Err "  - Stash & retry:    cd $MetabotHome; git stash; git pull --ff-only"
        Write-Err "  - Reset to origin (DESTROYS local commits/edits):"
        Write-Err "      cd $MetabotHome; git fetch origin; git reset --hard origin/main"
        exit 1
    }
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
    Assert-NativeSuccess "git clone"
}
Write-Success "MetaBot code ready at $MetabotHome"

# ============================================================================
# Phase 3: Install dependencies
# ============================================================================
Write-Step "Phase 3: Installing dependencies"

Push-Location $MetabotHome
Write-Info "Running npm install..."
npm install --production=false
Assert-NativeSuccess "npm install"
Write-Success "npm dependencies installed"

# PM2
if (-not (Test-Command "pm2")) {
    Write-Info "Installing PM2 globally..."
    npm install -g pm2
    Assert-NativeSuccess "PM2 installation"
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
    $WorkDir = Read-Input "Project directory for the Agent to work in" $DefaultWorkDir
    if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    Write-Success "Working directory: $WorkDir"

    # ------ 4b: Engine selection + authentication ------
    Write-Host ""
    Write-Host "Agent Engine:" -ForegroundColor White
    Write-Host "  1) Codex CLI (OpenAI)"
    Write-Host "  2) Kimi Code (Moonshot AI - default model kimi-code/k3)"
    Write-Host "  3) Claude Code compatibility (Anthropic)"
    $EngineChoice = Read-Choice "1"

    $BotEngine = "codex"
    $ClaudeAuthEnvLines = ""
    $ClaudeAuthMethod = "codex"

    if ($EngineChoice -eq "2") {
        $BotEngine = "kimi"
        $ClaudeAuthMethod = "kimi"
        $AuthChoice = "kimi"
        if (-not (Install-KimiCode)) {
            Write-Warn "Continuing with Kimi configuration; install Kimi Code 0.27+ before starting MetaBot."
        }
        Write-Info "Run 'kimi login' before starting MetaBot. MetaBot defaults Kimi sessions to kimi-code/k3."
    } elseif ($EngineChoice -eq "1") {
        $BotEngine = "codex"
        $ClaudeAuthMethod = "codex"
        $AuthChoice = "codex"
        if (Test-Command "codex") {
            Write-Success "Codex CLI found: $((Get-Command codex).Source)"
        } else {
            Write-Info "Installing Codex CLI..."
            try {
                & npm install -g "@openai/codex" | Out-Host
                if ($LASTEXITCODE -ne 0) { throw "npm exited with code $LASTEXITCODE" }
            } catch {
                Write-Warn "Codex install failed: $($_.Exception.Message)"
            }
            if (-not (Test-Command "codex")) {
                Write-Warn "Install Codex manually with 'npm install -g @openai/codex', then run 'codex login'."
            }
        }
        Write-Info "Run 'codex login' before starting MetaBot."
    } else {
        Write-Host ""
        Write-Host "Claude AI Authentication:" -ForegroundColor White
        Write-Host "  1) Claude Code Subscription (OAuth - run 'claude login' after install)"
        Write-Host "  2) Anthropic API Key (sk-ant-...)"
        Write-Host "  3) Third-party provider (Kimi/Moonshot, DeepSeek, GLM, etc.)"
        $AuthChoice = Read-Choice "1"
    }

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
    $CoreUrl = if ($env:METABOT_CORE_URL) { $env:METABOT_CORE_URL } else { "http://localhost:9200" }

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

# Agent Engine Authentication
"@

    if ($ClaudeAuthMethod -eq "subscription") {
        $envContent += "`n# Using Claude Code Subscription (OAuth). Run 'claude login' to authenticate."
    } elseif ($ClaudeAuthMethod -eq "kimi") {
        $envContent += "`n# Using Kimi Code 0.27+ (default model: kimi-code/k3). Run 'kimi login' to authenticate."
    } elseif ($ClaudeAuthMethod -eq "codex") {
        $envContent += "`n# Using Codex CLI. Run 'codex login' to authenticate."
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

# Optional Core service (not installed by the Windows Bridge installer)
METABOT_CORE_URL=$CoreUrl
# METABOT_CORE_TOKEN=
"@

    [System.IO.File]::WriteAllText($EnvFile, $envContent, [System.Text.UTF8Encoding]::new($false))
    Write-Success ".env generated"

    # Generate bots.json (use node for safe JSON escaping)
    $BotsJson = Join-Path $MetabotHome "bots.json"
    $FeishuBotsJson = "[]"
    $TelegramBotsJson = "[]"

    if ($SetupFeishu) {
        $FeishuBotsJson = node -e "const e=process.argv[5];const b={name:process.argv[1],engine:e,feishuAppId:process.argv[2],feishuAppSecret:process.argv[3],defaultWorkingDirectory:process.argv[4]};if(e==='kimi')b.kimi={model:'kimi-code/k3',thinking:true,permissionMode:'auto'};if(e==='codex')b.codex={approvalPolicy:'never',sandbox:'workspace-write'};console.log(JSON.stringify([b],null,2))" $BotName $FeishuAppId $FeishuAppSecret $WorkDir $BotEngine
        $FeishuBotsJson = $FeishuBotsJson -join "`n"
    }

    if ($SetupTelegram) {
        $TgName = $BotName
        if ($SetupFeishu) { $TgName = "$BotName-telegram" }
        $TelegramBotsJson = node -e "const e=process.argv[4];const b={name:process.argv[1],engine:e,telegramBotToken:process.argv[2],defaultWorkingDirectory:process.argv[3]};if(e==='kimi')b.kimi={model:'kimi-code/k3',thinking:true,permissionMode:'auto'};if(e==='codex')b.codex={approvalPolicy:'never',sandbox:'workspace-write'};console.log(JSON.stringify([b],null,2))" $TgName $TelegramBotToken $WorkDir $BotEngine
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
if ($env:CODEX_HOME) {
    $CodexHome = $env:CODEX_HOME
} else {
    $CodexHome = Join-Path $env:USERPROFILE ".codex"
}
$CodexSkillsDir = Join-Path $CodexHome "skills"
$AgentsSkillsDir = Join-Path $env:USERPROFILE ".agents\skills"
$GlobalSkillRoots = @($SkillsDir, $CodexSkillsDir, $AgentsSkillsDir)
$MetaBotSkillSources = [ordered]@{
    "metabot" = (Join-Path $MetabotHome "packages\skills\metabot")
    "metabot-team" = (Join-Path $MetabotHome "packages\skills\metabot-team")
}

# Install complete MetaBot-owned bundles for Claude, Codex, and Kimi Code's
# shared Agent Skills location. Existing unrelated user skills are untouched.
foreach ($skillName in $MetaBotSkillSources.Keys) {
    $skillSource = $MetaBotSkillSources[$skillName]
    if (-not (Test-Path (Join-Path $skillSource "SKILL.md"))) {
        Write-Err "Bundled $skillName skill source is missing or incomplete: $skillSource"
        exit 1
    }
}
foreach ($skillRoot in $GlobalSkillRoots) {
    New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null
    foreach ($skillName in $MetaBotSkillSources.Keys) {
        $skillDestination = Join-Path $skillRoot $skillName
        Install-SkillBundle $MetaBotSkillSources[$skillName] $skillDestination (Join-Path $env:USERPROFILE ".metabot\skill-backups")
        Write-Success "$skillName installed -> $skillDestination"
    }
    $voiceDestination = Join-Path $skillRoot "voice"
    if (Test-Path -LiteralPath $voiceDestination) {
        Backup-SkillPath $voiceDestination (Join-Path $env:USERPROFILE ".metabot\skill-backups")
        Write-Info "Retired voice Skill from $skillRoot"
    }
}

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

# Deploy selected Skills to the bot working directory. Workspace instruction
# files are user-owned and are never created or changed by the installer.
if ($DeployWorkDir) {
    $SkillsDest = Join-Path $DeployWorkDir ".claude\skills"
    $CodexSkillsDest = Join-Path $DeployWorkDir ".codex\skills"
    $AgentsSkillsDest = Join-Path $DeployWorkDir ".agents\skills"
    $WorkspaceSkillRoots = @($SkillsDest, $CodexSkillsDest, $AgentsSkillsDest)

    # MetaBot-owned Skills are global-only. Preserve and retire historical
    # project mirrors so stale snapshots cannot shadow current global Skills.
    $WorkspaceSkillBackup = Join-Path $DeployWorkDir ".metabot\skill-backups"
    foreach ($workspaceSkillRoot in $WorkspaceSkillRoots) {
        New-Item -ItemType Directory -Path $workspaceSkillRoot -Force | Out-Null
        foreach ($skill in @("metabot", "metabot-team", "voice")) {
            $skillDst = Join-Path $workspaceSkillRoot $skill
            $skillItem = Get-Item -LiteralPath $skillDst -Force -ErrorAction SilentlyContinue
            if ($null -ne $skillItem) {
                New-Item -ItemType Directory -Path $WorkspaceSkillBackup -Force | Out-Null
                $stamp = Get-Date -Format "yyyyMMddHHmmssfff"
                $backupName = "$skill.$stamp.$([guid]::NewGuid().ToString('N'))"
                Move-Item -LiteralPath $skillDst -Destination (Join-Path $WorkspaceSkillBackup $backupName)
                Write-Info "Retired project-level $skill mirror from $workspaceSkillRoot"
            }
        }
    }

    # Only user-selected integration Skills are mirrored into the workspace.
    $deploySkills = @()
    if ($HasFeishu) { $deploySkills += "feishu-doc" }

    foreach ($skill in $deploySkills) {
        $skillSrc = Join-Path $SkillsDir $skill
        if (Test-Path $skillSrc) {
            foreach ($workspaceSkillRoot in $WorkspaceSkillRoots) {
                $skillDst = Join-Path $workspaceSkillRoot $skill
                New-Item -ItemType Directory -Path $skillDst -Force | Out-Null
                Get-ChildItem $skillSrc -Force | Copy-Item -Destination $skillDst -Recurse -Force
                Write-Success "Deployed $skill -> $skillDst"
            }
        }
    }

    Remove-Item (Join-Path $DeployWorkDir ".metabot\workspace-harness.sha256") -Force -ErrorAction SilentlyContinue

} else {
    Write-Warn "Could not determine working directory, skipping workspace mirror cleanup"
}

# Install CLI tools with .cmd wrappers for CMD/PowerShell
$LocalBin = Join-Path $env:USERPROFILE ".local\bin"
New-Item -ItemType Directory -Path $LocalBin -Force | Out-Null

$GitBashPath = Resolve-GitBashPath

$cliTools = @("metabot")
if ($HasFeishu) { $cliTools += "fd" }

if ($GitBashPath) {
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

            # Pin the wrapper to Git Bash. Quoting both absolute paths keeps
            # installs under "Program Files" and user profiles with spaces safe.
            $cmdContent = "@`"$GitBashPath`" `"%~dp0$cli`" %*"
            $cmdContent | Out-File -FilePath (Join-Path $LocalBin "$cli.cmd") -Encoding ascii -NoNewline
        }
    }

    # Clean up legacy CLIs (mb deprecation shim + Phase 4 consolidation).
    foreach ($legacy in @("mb", "mb.cmd", "mm", "mm.cmd", "mh", "mh.cmd", "mbcore", "mbcore.cmd")) {
        $legacyPath = Join-Path $LocalBin $legacy
        if (Test-Path $legacyPath) {
            Remove-Item -Force $legacyPath
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
        Write-Success "metabot/fd CLI tools installed to $LocalBin (with .cmd wrappers)"
    } else {
        Write-Success "metabot CLI installed to $LocalBin (with .cmd wrapper)"
    }
} else {
    Write-Warn "Git Bash was not found. The WSL/System32 bash launcher is not compatible with Windows CLI wrappers."
    Write-Warn "Install Git for Windows (https://git-scm.com) and re-run this installer."
}

# Persist METABOT_HOME for non-default install paths so the CLI tool
# (metabot) can find the install in new shell sessions. The CLI falls
# back to ~/metabot, so we only need to persist when it differs.
if ($MetabotHome -ne $DefaultMetabotHome) {
    [System.Environment]::SetEnvironmentVariable("METABOT_HOME", $MetabotHome, "User")
    $env:METABOT_HOME = $MetabotHome
    Write-Info "Persisted METABOT_HOME=$MetabotHome to user environment"
}

# ============================================================================
# Phase 7: Core status
# ============================================================================
Write-Step "Phase 7: Checking optional Core service"

$ConfiguredCoreUrl = if ($env:METABOT_CORE_URL) { $env:METABOT_CORE_URL } else { "http://localhost:9200" }
if (Test-Path $EnvFile) {
    $coreLine = Get-Content -LiteralPath $EnvFile -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '^\s*METABOT_CORE_URL=' } |
        Select-Object -Last 1
    if ($coreLine) {
        $ConfiguredCoreUrl = ($coreLine -replace '^\s*METABOT_CORE_URL=', '').Trim().Trim('"').Trim("'")
    }
}

Write-Info "The Windows installer manages the MetaBot Bridge only."
Write-Info "Core Console and MetaMemory require a separately running Core service."
try {
    $coreHealth = Invoke-WebRequest -Uri "$($ConfiguredCoreUrl.TrimEnd('/'))/health" -UseBasicParsing -TimeoutSec 3
    if ($coreHealth.StatusCode -ge 200 -and $coreHealth.StatusCode -lt 300) {
        Write-Success "Core service is reachable at $ConfiguredCoreUrl"
    }
} catch {
    Write-Warn "Core service is not reachable at $ConfiguredCoreUrl. The Bridge can still serve IM bots."
    Write-Warn "Set METABOT_CORE_URL and METABOT_CORE_TOKEN in $EnvFile when Core is available."
}

# ============================================================================
# Phase 8: Build + Start MetaBot with PM2
# ============================================================================
Write-Step "Phase 8: Starting MetaBot"

Push-Location $MetabotHome

Write-Info "Building TypeScript..."
npm run build
Assert-NativeSuccess "MetaBot build"
Write-Success "Build complete"

# Always delete + start fresh
pm2 describe metabot 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Info "Removing old MetaBot PM2 process..."
    pm2 delete metabot 2>$null
    Assert-NativeSuccess "removing the old MetaBot PM2 process"
}

Write-Info "Starting MetaBot with PM2..."
pm2 start ecosystem.config.cjs
Assert-NativeSuccess "PM2 start"

pm2 save --force 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "PM2 started MetaBot, but saving the process list failed with exit code $LASTEXITCODE."
}

$HealthPort = if ($ApiPort) { $ApiPort } else { "9100" }
if (Test-Path $EnvFile) {
    $portLine = Get-Content -LiteralPath $EnvFile -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '^\s*API_PORT=' } |
        Select-Object -Last 1
    if ($portLine) {
        $HealthPort = ($portLine -replace '^\s*API_PORT=', '').Trim().Trim('"').Trim("'")
    }
}
$BridgeHealthUrl = "http://127.0.0.1:$HealthPort/api/health"
if (-not (Wait-BridgeHealth -Url $BridgeHealthUrl)) {
    Write-BridgeDiagnostics -InstallDir $MetabotHome
    throw "MetaBot Bridge did not become healthy at $BridgeHealthUrl."
}

Write-Success "MetaBot Bridge is healthy at $BridgeHealthUrl"
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
    Write-Host "  Engine:         " -ForegroundColor White -NoNewline; Write-Host $BotEngine
    Write-Host "  Auth Method:    " -ForegroundColor White -NoNewline; Write-Host $ClaudeAuthMethod
    if ($ClaudeAuthMethod -eq "third_party") {
        Write-Host "  Provider:       " -ForegroundColor White -NoNewline; Write-Host $ProviderName
    }
}
Write-Host "  Core Console:   " -ForegroundColor White -NoNewline; Write-Host "$ConfiguredCoreUrl (separate service)"

Write-Host ""
Write-Host "  Commands:" -ForegroundColor White
Write-Host "    pm2 logs metabot          # View MetaBot logs"
Write-Host "    pm2 restart metabot       # Restart MetaBot"
Write-Host "    pm2 stop metabot          # Stop MetaBot"
Write-Host "    metabot memory search ... # Search MetaMemory (via metabot-core)"
Write-Host "    metabot memory visibility # Per-bot default: /shared (public) vs /users (private); flip with 'visibility private|public'"

Write-Host ""
if (-not $SkipConfig) {
    Write-Host "  Next Steps:" -ForegroundColor White
    $StepNum = 1
    if ($ClaudeAuthMethod -eq "subscription") {
        Write-Host "    $StepNum. Run 'claude login' in a separate terminal"
        $StepNum++
    }
    if ($ClaudeAuthMethod -eq "kimi") {
        Write-Host "    $StepNum. Run 'kimi login' (Kimi Code 0.27+, default model kimi-code/k3)"
        $StepNum++
    }
    if ($ClaudeAuthMethod -eq "codex") {
        Write-Host "    $StepNum. Run 'codex login' in a separate terminal"
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
