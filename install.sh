#!/usr/bin/env bash
# MetaBot Installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash -s -- --dir /opt/metabot
#   METABOT_HOME=/opt/metabot bash install.sh
set -euo pipefail

# ============================================================================
# CRITICAL: When running via `curl | bash`, stdin is the pipe (not terminal).
# All interactive reads MUST use /dev/tty explicitly.
# ============================================================================
if [[ ! -t 0 ]] && [[ -e /dev/tty ]]; then
  TTY=/dev/tty
else
  TTY=/dev/stdin
fi

# ============================================================================
# Parse CLI arguments
# ============================================================================
INSTALL_DIR_ARG=""
print_usage() {
  cat <<'USAGE'
MetaBot Installer

Usage:
  bash install.sh [OPTIONS]
  curl -fsSL <url> | bash -s -- [OPTIONS]

Options:
  -d, --dir <path>     Install MetaBot to <path>.
                       Priority: --dir > METABOT_HOME env var > interactive prompt.
                       Default: $HOME/metabot
  -h, --help           Show this help and exit.

Examples:
  bash install.sh
  bash install.sh --dir /opt/metabot
  bash install.sh -d ~/projects/metabot
  METABOT_HOME=/opt/metabot bash install.sh
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires a path argument" >&2; exit 1; }
      INSTALL_DIR_ARG="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR_ARG="${1#--dir=}"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Warning: unknown argument '$1'" >&2
      shift
      ;;
  esac
done

# ============================================================================
# Configuration defaults
# ============================================================================
# METABOT_HOME is resolved later (Phase 0.5) — priority: --dir > env var > prompt > default.
DEFAULT_METABOT_HOME="$HOME/metabot"
METABOT_REPO="${METABOT_REPO:-https://github.com/xvirobotics/metabot.git}"

# ============================================================================
# Colors and formatting
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║            MetaBot Installer             ║"
  echo "  ║        一生二，二生三，三生万物          ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo -e "${NC}"
  echo ""
}

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}==> $*${NC}"; }

# Safe prompt — reads from /dev/tty, uses printf -v (no eval)
prompt_input() {
  local varname="$1"
  local prompt_text="$2"
  local default_val="${3:-}"
  local input

  if [[ -n "$default_val" ]]; then
    echo -en "${CYAN}  $prompt_text${NC} [${default_val}]: " >&2
  else
    echo -en "${CYAN}  $prompt_text${NC}: " >&2
  fi
  read -r input < "$TTY" || input=""
  if [[ -z "$input" ]]; then
    input="$default_val"
  fi
  printf -v "$varname" '%s' "$input"
}

prompt_secret() {
  local varname="$1"
  local prompt_text="$2"
  local input

  echo -en "${CYAN}  $prompt_text${NC}: " >&2
  read -rs input < "$TTY" || input=""
  echo "" >&2
  printf -v "$varname" '%s' "$input"
}

prompt_choice() {
  local varname="$1"
  local default_val="$2"
  local input

  echo -en "${CYAN}  Choice${NC} [${default_val}]: " >&2
  read -r input < "$TTY" || input=""
  if [[ -z "$input" ]]; then
    input="$default_val"
  fi
  printf -v "$varname" '%s' "$input"
}

prompt_yn() {
  local prompt_text="$1"
  local default="${2:-y}"
  local input

  if [[ "$default" == "y" ]]; then
    echo -en "${CYAN}  $prompt_text${NC} [Y/n]: " >&2
  else
    echo -en "${CYAN}  $prompt_text${NC} [y/N]: " >&2
  fi
  read -r input < "$TTY" || input=""
  input="${input:-$default}"
  # Use tr for bash 3.x compatibility (macOS ships bash 3.2)
  local lower
  lower="$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]')"
  [[ "$lower" == "y" || "$lower" == "yes" ]]
}

# ============================================================================
# Phase 0: Banner + detect OS/arch
# ============================================================================
banner

OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected: ${OS} ${ARCH}"

if [[ "$OS" != "Linux" && "$OS" != "Darwin" ]]; then
  error "Unsupported OS: $OS. MetaBot supports Linux and macOS."
  exit 1
fi

# Portable sed -i helper
sed_i() {
  if [[ "$OS" == "Darwin" ]]; then
    sed -i "" "$@"
  else
    sed -i "$@"
  fi
}

# ============================================================================
# Phase 0.5: Resolve install directory
# Priority: --dir CLI arg > METABOT_HOME env var > interactive prompt > default.
# ============================================================================
step "Phase 0.5: Choose install directory"

if [[ -n "$INSTALL_DIR_ARG" ]]; then
  METABOT_HOME="$INSTALL_DIR_ARG"
  info "Using install directory from --dir: $METABOT_HOME"
elif [[ -n "${METABOT_HOME:-}" ]]; then
  info "Using install directory from METABOT_HOME env: $METABOT_HOME"
else
  echo ""
  echo -e "${BOLD}Where should MetaBot be installed?${NC}"
  echo "  (You can override later with the METABOT_HOME env var or --dir flag.)"
  prompt_input METABOT_HOME "Install directory" "$DEFAULT_METABOT_HOME"
fi

# Expand a leading ~ to $HOME (avoids eval; safe with spaces).
METABOT_HOME="${METABOT_HOME/#\~/$HOME}"

# Require an absolute path so all later $METABOT_HOME references are unambiguous.
if [[ "$METABOT_HOME" != /* ]]; then
  error "Install path must be absolute, got: $METABOT_HOME"
  exit 1
fi

# Refuse a few obviously-bad targets that would clobber the user's home or root.
case "$METABOT_HOME" in
  /|/root|/home|/Users|"$HOME")
    error "Refusing to install directly into $METABOT_HOME — pick a dedicated subdirectory."
    exit 1
    ;;
esac

success "Install directory: $METABOT_HOME"

# ============================================================================
# Phase 1: Check prerequisites
# ============================================================================
step "Phase 1: Checking prerequisites"

check_command() {
  local cmd="$1"
  local name="${2:-$1}"
  local install_hint="${3:-}"
  if command -v "$cmd" &>/dev/null; then
    success "$name found: $(command -v "$cmd")"
    return 0
  else
    error "$name not found."
    if [[ -n "$install_hint" ]]; then
      echo "  Install: $install_hint"
    fi
    return 1
  fi
}

MISSING=0
check_command git "Git" "https://git-scm.com/downloads" || MISSING=1

install_node() {
  info "Installing Node.js 22.x via NodeSource..."
  if [[ "$OS" == "Linux" ]]; then
    if command -v apt-get &>/dev/null; then
      # Debian/Ubuntu
      curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
      sudo -n bash /tmp/nodesource_setup.sh 2>/dev/null || sudo bash /tmp/nodesource_setup.sh
      sudo -n apt-get install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs
      rm -f /tmp/nodesource_setup.sh
    elif command -v dnf &>/dev/null; then
      # Fedora/RHEL
      curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
      sudo -n bash /tmp/nodesource_setup.sh 2>/dev/null || sudo bash /tmp/nodesource_setup.sh
      sudo -n dnf install -y nodejs 2>/dev/null || sudo dnf install -y nodejs
      rm -f /tmp/nodesource_setup.sh
    elif command -v yum &>/dev/null; then
      # CentOS/older RHEL
      curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
      sudo -n bash /tmp/nodesource_setup.sh 2>/dev/null || sudo bash /tmp/nodesource_setup.sh
      sudo -n yum install -y nodejs 2>/dev/null || sudo yum install -y nodejs
      rm -f /tmp/nodesource_setup.sh
    else
      return 1
    fi
  elif [[ "$OS" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install node@22
    else
      return 1
    fi
  fi
  # Verify
  if command -v node &>/dev/null; then
    success "Node.js installed: $(node --version)"
    return 0
  fi
  return 1
}

NEED_NODE=false
if command -v node &>/dev/null; then
  NODE_VER="$(node --version | sed 's/v//')"
  NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    success "Node.js found: v${NODE_VER}"
  else
    warn "Node.js v${NODE_VER} found, but v20+ is required."
    NEED_NODE=true
  fi
else
  warn "Node.js not found."
  NEED_NODE=true
fi

if [[ "$NEED_NODE" == "true" ]]; then
  if prompt_yn "Install Node.js 22.x automatically?"; then
    if install_node; then
      success "Node.js ready"
    else
      error "Automatic install failed. Please install Node.js 20+ manually:"
      echo "  https://nodejs.org/ or use nvm/fnm"
      MISSING=1
    fi
  else
    error "Node.js 20+ is required. Install manually and re-run."
    exit 1
  fi
fi

check_command npm "npm" "Comes with Node.js" || MISSING=1

if [[ "$MISSING" -eq 1 ]]; then
  error "Please install missing prerequisites and re-run this script."
  exit 1
fi

# ============================================================================
# Phase 2: Clone or update repo
# ============================================================================
step "Phase 2: Setting up MetaBot at ${METABOT_HOME}"

if [[ -d "$METABOT_HOME/.git" ]]; then
  info "Existing installation found, pulling latest..."
  cd "$METABOT_HOME"
  OLD_HEAD="$(git rev-parse HEAD)"
  git pull --ff-only || warn "git pull failed, continuing with existing code"
  NEW_HEAD="$(git rev-parse HEAD)"
  # Re-exec with the updated install.sh if it changed (avoids running stale code from memory)
  if [[ "$OLD_HEAD" != "$NEW_HEAD" && -z "${METABOT_REEXEC:-}" ]]; then
    info "install.sh updated, re-launching..."
    export METABOT_REEXEC=1
    exec bash "$METABOT_HOME/install.sh"
  fi
else
  info "Cloning MetaBot..."
  git clone "$METABOT_REPO" "$METABOT_HOME"
  cd "$METABOT_HOME"
fi
success "MetaBot code ready at ${METABOT_HOME}"

# ============================================================================
# Phase 3: Install dependencies
# ============================================================================
step "Phase 3: Installing dependencies"

cd "$METABOT_HOME"
info "Running npm install..."
npm install --production=false
success "npm dependencies installed"

# Helper: npm install -g with sudo fallback
npm_install_global() {
  npm install -g "$@" 2>/dev/null || sudo -n npm install -g "$@" 2>/dev/null || sudo npm install -g "$@"
}

if ! command -v pm2 &>/dev/null; then
  info "Installing PM2 globally..."
  npm_install_global pm2
  success "PM2 installed"
else
  success "PM2 already installed"
fi

# Claude and Kimi CLI installs are driven by the engine choice in Phase 4.
# We still ensure the Claude CLI is present as a default convenience, since
# most users start with Claude and may mix engines later.
if command -v claude &>/dev/null; then
  success "Claude CLI found: $(command -v claude)"
else
  info "Installing Claude CLI..."
  npm_install_global @anthropic-ai/claude-code
  if command -v claude &>/dev/null; then
    success "Claude CLI installed"
  else
    warn "Claude CLI install failed. Install manually: sudo npm install -g @anthropic-ai/claude-code"
  fi
fi

# Install uv + kimi-cli helper. Used by the Kimi engine path below.
install_kimi_cli() {
  if command -v kimi &>/dev/null; then
    success "Kimi CLI found: $(command -v kimi)"
    return 0
  fi
  # Need uv first (kimi-cli is a Python tool distributed via uv)
  if ! command -v uv &>/dev/null; then
    info "Installing uv (required by kimi-cli)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
    # uv installs to ~/.local/bin — make sure it's on PATH for this script
    export PATH="$HOME/.local/bin:$PATH"
    if ! command -v uv &>/dev/null; then
      warn "uv install failed. Install manually from https://astral.sh/uv and re-run."
      return 1
    fi
    success "uv installed: $(uv --version)"
  fi
  info "Installing kimi-cli via uv..."
  if uv tool install kimi-cli 2>&1 | tail -3; then
    export PATH="$HOME/.local/bin:$PATH"
    if command -v kimi &>/dev/null; then
      success "Kimi CLI installed: $(command -v kimi)"
      return 0
    fi
  fi
  warn "Kimi CLI install failed. Install manually: uv tool install kimi-cli"
  return 1
}

# ============================================================================
# Phase 4: Interactive configuration
# ============================================================================
step "Phase 4: Configuration"

if [[ -f "$METABOT_HOME/.env" ]]; then
  warn ".env already exists. Skipping interactive config."
  warn "Edit ${METABOT_HOME}/.env to modify settings."
  SKIP_CONFIG=true
else
  SKIP_CONFIG=false
fi

if [[ "$SKIP_CONFIG" == "false" ]]; then

  # ------ 4a: Working directory ------
  echo ""
  echo -e "${BOLD}Working Directory:${NC}"
  prompt_input WORK_DIR "Project directory for Claude to work in" "$HOME/metabot-workspace"
  mkdir -p "$WORK_DIR"
  success "Working directory: ${WORK_DIR}"

  # ------ 4b: Engine selection ------
  echo ""
  echo -e "${BOLD}Agent Engine:${NC}"
  echo "  1) Claude Code (Anthropic)"
  echo "  2) Kimi (Moonshot AI — requires kimi-cli login, uses your subscription)"
  prompt_choice ENGINE_CHOICE "1"

  BOT_ENGINE="claude"
  CLAUDE_AUTH_ENV_LINES=""
  CLAUDE_AUTH_METHOD="subscription"

  if [[ "$ENGINE_CHOICE" == "2" ]]; then
    BOT_ENGINE="kimi"
    CLAUDE_AUTH_METHOD="kimi"
    echo ""
    info "Installing kimi-cli..."
    install_kimi_cli || warn "Continuing despite kimi-cli install failure — you can install it later."
    info "After install, run 'kimi login' in a separate terminal to authenticate."
    # Skip the Claude provider prompt entirely for Kimi — it has its own auth.
    AUTH_CHOICE="kimi"
  else
    # ------ 4b-claude: Claude AI authentication ------
    echo ""
    echo -e "${BOLD}Claude AI Authentication:${NC}"
    echo "  1) Claude Code Subscription (OAuth — run 'claude login' after install)"
    echo "  2) Anthropic API Key (sk-ant-...)"
    echo "  3) Third-party provider (Kimi/Moonshot, DeepSeek, GLM, etc.)"
    prompt_choice AUTH_CHOICE "1"
  fi

  case "$AUTH_CHOICE" in
    kimi)
      : # handled above
      ;;
    1)
      CLAUDE_AUTH_METHOD="subscription"
      info "Using Claude Code Subscription. Run 'claude login' after install."
      ;;
    2)
      CLAUDE_AUTH_METHOD="anthropic_key"
      prompt_secret ANTHROPIC_API_KEY "Anthropic API Key (sk-ant-...)"
      if [[ -z "$ANTHROPIC_API_KEY" ]]; then
        error "API key is required."; exit 1
      fi
      CLAUDE_AUTH_ENV_LINES="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
      ;;
    3)
      CLAUDE_AUTH_METHOD="third_party"
      echo ""
      echo -e "  ${BOLD}Select provider:${NC}"
      echo "    1) Kimi/Moonshot  (https://platform.moonshot.cn)"
      echo "    2) DeepSeek       (https://platform.deepseek.com)"
      echo "    3) GLM/Zhipu      (https://open.bigmodel.cn)"
      echo "    4) Custom URL"
      prompt_choice PROVIDER_CHOICE "1"

      case "$PROVIDER_CHOICE" in
        1) PROVIDER_NAME="Kimi/Moonshot"; PROVIDER_BASE_URL="https://api.moonshot.ai/anthropic"
           PROVIDER_DEFAULT_MODEL=""; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
        2) PROVIDER_NAME="DeepSeek"; PROVIDER_BASE_URL="https://api.deepseek.com/anthropic"
           PROVIDER_DEFAULT_MODEL="deepseek-chat"; PROVIDER_DEFAULT_SMALL_MODEL="deepseek-chat" ;;
        3) PROVIDER_NAME="GLM/Zhipu"; PROVIDER_BASE_URL="https://api.z.ai/api/anthropic"
           PROVIDER_DEFAULT_MODEL="glm-4.5"; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
        4) PROVIDER_NAME="Custom"
           prompt_input PROVIDER_BASE_URL "API Base URL (e.g. https://api.example.com/anthropic)"
           PROVIDER_DEFAULT_MODEL=""; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
        *) PROVIDER_NAME="Kimi/Moonshot"; PROVIDER_BASE_URL="https://api.moonshot.ai/anthropic"
           PROVIDER_DEFAULT_MODEL=""; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
      esac

      info "Provider: ${PROVIDER_NAME} (${PROVIDER_BASE_URL})"
      prompt_secret PROVIDER_API_KEY "${PROVIDER_NAME} API Key"
      if [[ -z "$PROVIDER_API_KEY" ]]; then
        error "API key is required."; exit 1
      fi

      prompt_input PROVIDER_MODEL "Model name (enter for default)" "${PROVIDER_DEFAULT_MODEL}"
      prompt_input PROVIDER_SMALL_MODEL "Small/fast model (enter to skip)" "${PROVIDER_DEFAULT_SMALL_MODEL}"

      CLAUDE_AUTH_ENV_LINES="# ${PROVIDER_NAME} Provider
ANTHROPIC_BASE_URL=${PROVIDER_BASE_URL}
ANTHROPIC_AUTH_TOKEN=${PROVIDER_API_KEY}"
      [[ -n "$PROVIDER_MODEL" ]] && CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
ANTHROPIC_MODEL=${PROVIDER_MODEL}"
      [[ -n "$PROVIDER_SMALL_MODEL" ]] && CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
ANTHROPIC_SMALL_FAST_MODEL=${PROVIDER_SMALL_MODEL}"
      [[ "$PROVIDER_CHOICE" == "2" ]] && CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
API_TIMEOUT_MS=600000"
      ;;
  esac

  # ------ 4c: IM Bot platform + credentials ------
  echo ""
  echo -e "${BOLD}IM Bot Platform:${NC}"
  echo "  1) Feishu/Lark"
  echo "  2) Telegram"
  echo "  3) WeChat ClawBot"
  echo "  4) Feishu + Telegram"
  echo "  5) Feishu + WeChat"
  echo "  6) All"
  prompt_choice PLATFORM_CHOICE "1"

  SETUP_FEISHU=false
  SETUP_TELEGRAM=false
  SETUP_WECHAT=false
  case "$PLATFORM_CHOICE" in
    1) SETUP_FEISHU=true ;;
    2) SETUP_TELEGRAM=true ;;
    3) SETUP_WECHAT=true ;;
    4) SETUP_FEISHU=true; SETUP_TELEGRAM=true ;;
    5) SETUP_FEISHU=true; SETUP_WECHAT=true ;;
    6) SETUP_FEISHU=true; SETUP_TELEGRAM=true; SETUP_WECHAT=true ;;
    *) SETUP_FEISHU=true ;;
  esac

  FEISHU_APP_ID=""
  FEISHU_APP_SECRET=""
  if [[ "$SETUP_FEISHU" == "true" ]]; then
    echo ""
    echo -e "  ${BOLD}Feishu/Lark Credentials:${NC}"
    prompt_input FEISHU_APP_ID "App ID (e.g. cli_xxxx)"
    prompt_secret FEISHU_APP_SECRET "App Secret"
    if [[ -z "$FEISHU_APP_ID" || -z "$FEISHU_APP_SECRET" ]]; then
      error "Feishu App ID and Secret are required."; exit 1
    fi
  fi

  TELEGRAM_BOT_TOKEN=""
  if [[ "$SETUP_TELEGRAM" == "true" ]]; then
    echo ""
    echo -e "  ${BOLD}Telegram Credentials:${NC}"
    prompt_secret TELEGRAM_BOT_TOKEN "Bot Token (from @BotFather)"
    if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then
      error "Telegram Bot Token is required."; exit 1
    fi
  fi

  if [[ "$SETUP_WECHAT" == "true" ]]; then
    echo ""
    echo -e "  ${BOLD}WeChat ClawBot:${NC}"
    info "No credentials needed — you'll scan a QR code after installation."
    info "Requires WeChat ClawBot beta access (apply at ilinkai.weixin.qq.com)."
  fi

  # ------ 4d: Bot name + auto-generated settings ------
  echo ""
  echo -e "${BOLD}Bot Name:${NC}"
  prompt_input BOT_NAME "Name for your bot" "metabot"

  # Auto-generate API secret
  API_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64)"
  API_PORT="9100"
  LOG_LEVEL="info"
  META_MEMORY_URL="http://localhost:8100"

  # Claude executable path
  CLAUDE_PATH=""
  if command -v claude &>/dev/null; then
    CLAUDE_PATH="$(command -v claude)"
  fi
fi

# ============================================================================
# Phase 5: Generate .env + bots.json
# ============================================================================
step "Phase 5: Generating configuration files"

if [[ "$SKIP_CONFIG" == "false" ]]; then
  # Generate .env
  {
    echo "# MetaBot Configuration (generated by install.sh)"
    echo "# $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo ""
    echo "# Bot config file (multi-bot mode)"
    echo "BOTS_CONFIG=./bots.json"
    echo ""
    echo "# API Server"
    echo "API_PORT=${API_PORT}"
    echo "API_SECRET=${API_SECRET}"
    echo ""
    echo "# Claude AI Authentication"
    if [[ "$CLAUDE_AUTH_METHOD" == "subscription" ]]; then
      echo "# Using Claude Code Subscription (OAuth). Run 'claude login' to authenticate."
    elif [[ -n "${CLAUDE_AUTH_ENV_LINES:-}" ]]; then
      echo "$CLAUDE_AUTH_ENV_LINES"
    fi
    echo ""
    echo "# Claude Settings"
    echo "CLAUDE_DEFAULT_WORKING_DIRECTORY=${WORK_DIR}"
    echo "# CLAUDE_MAX_TURNS="
    echo "# CLAUDE_MAX_BUDGET_USD="
    echo "LOG_LEVEL=${LOG_LEVEL}"
    if [[ -n "${CLAUDE_PATH:-}" ]]; then
      echo "CLAUDE_EXECUTABLE_PATH=${CLAUDE_PATH}"
    fi
    echo ""
    echo "# MetaMemory"
    echo "META_MEMORY_URL=${META_MEMORY_URL}"
  } > "$METABOT_HOME/.env"
  chmod 600 "$METABOT_HOME/.env"
  success ".env generated"

  # Generate bots.json (use node for safe JSON escaping)
  BOTS_JSON="$METABOT_HOME/bots.json"
  FEISHU_BOTS_JSON="[]"
  TELEGRAM_BOTS_JSON="[]"
  WECHAT_BOTS_JSON="[]"

  if [[ "$SETUP_FEISHU" == "true" ]]; then
    FEISHU_BOTS_JSON=$(node -e "
      const engine = process.argv[5];
      const bot = {
        name: process.argv[1],
        feishuAppId: process.argv[2],
        feishuAppSecret: process.argv[3],
        defaultWorkingDirectory: process.argv[4],
      };
      if (engine === 'kimi') { bot.engine = 'kimi'; bot.kimi = { thinking: true }; }
      console.log(JSON.stringify([bot], null, 2))
    " "$BOT_NAME" "$FEISHU_APP_ID" "$FEISHU_APP_SECRET" "$WORK_DIR" "${BOT_ENGINE:-claude}")
  fi

  if [[ "$SETUP_TELEGRAM" == "true" ]]; then
    TG_NAME="$BOT_NAME"
    [[ "$SETUP_FEISHU" == "true" ]] && TG_NAME="${BOT_NAME}-telegram"
    TELEGRAM_BOTS_JSON=$(node -e "
      const engine = process.argv[4];
      const bot = {
        name: process.argv[1],
        telegramBotToken: process.argv[2],
        defaultWorkingDirectory: process.argv[3],
      };
      if (engine === 'kimi') { bot.engine = 'kimi'; bot.kimi = { thinking: true }; }
      console.log(JSON.stringify([bot], null, 2))
    " "$TG_NAME" "$TELEGRAM_BOT_TOKEN" "$WORK_DIR" "${BOT_ENGINE:-claude}")
  fi

  if [[ "$SETUP_WECHAT" == "true" ]]; then
    WX_NAME="$BOT_NAME"
    # Append suffix if other platforms are also configured
    [[ "$SETUP_FEISHU" == "true" || "$SETUP_TELEGRAM" == "true" ]] && WX_NAME="${BOT_NAME}-wechat"
    WECHAT_BOTS_JSON=$(node -e "
      const engine = process.argv[3];
      const bot = {
        name: process.argv[1],
        defaultWorkingDirectory: process.argv[2],
      };
      if (engine === 'kimi') { bot.engine = 'kimi'; bot.kimi = { thinking: true }; }
      console.log(JSON.stringify([bot], null, 2))
    " "$WX_NAME" "$WORK_DIR" "${BOT_ENGINE:-claude}")
  fi

  node -e "
    const config = {};
    const feishu = JSON.parse(process.argv[1]);
    const telegram = JSON.parse(process.argv[2]);
    const wechat = JSON.parse(process.argv[3]);
    if (feishu.length > 0) config.feishuBots = feishu;
    if (telegram.length > 0) config.telegramBots = telegram;
    if (wechat.length > 0) config.wechatBots = wechat;
    console.log(JSON.stringify(config, null, 2));
  " "$FEISHU_BOTS_JSON" "$TELEGRAM_BOTS_JSON" "$WECHAT_BOTS_JSON" > "$BOTS_JSON"
  chmod 600 "$BOTS_JSON"

  # Validate generated JSON
  if ! node -e "JSON.parse(require('fs').readFileSync('$BOTS_JSON','utf-8'))" 2>/dev/null; then
    error "Generated bots.json is invalid. Please check your bot name and credentials for special characters."
    exit 1
  fi
  success "bots.json generated"
fi

# ============================================================================
# Phase 6: Install skills + workspace setup
# ============================================================================
step "Phase 6: Installing skills and setting up workspace"

SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$SKILLS_DIR"

# Install metaskill (bundled in src/skills/metaskill/)
info "Installing metaskill skill..."
mkdir -p "$SKILLS_DIR/metaskill/flows"
cp "$METABOT_HOME/src/skills/metaskill/SKILL.md" "$SKILLS_DIR/metaskill/SKILL.md"
cp "$METABOT_HOME/src/skills/metaskill/flows/team.md" "$SKILLS_DIR/metaskill/flows/team.md"
cp "$METABOT_HOME/src/skills/metaskill/flows/agent.md" "$SKILLS_DIR/metaskill/flows/agent.md"
cp "$METABOT_HOME/src/skills/metaskill/flows/skill.md" "$SKILLS_DIR/metaskill/flows/skill.md"
success "metaskill skill installed → $SKILLS_DIR/metaskill"

# Install metamemory skill (bundled in src/memory/skill/)
info "Installing metamemory skill..."
mkdir -p "$SKILLS_DIR/metamemory"
cp "$METABOT_HOME/src/memory/skill/SKILL.md" "$SKILLS_DIR/metamemory/SKILL.md"
# Clean up old skill location if it exists
if [[ -d "$HOME/.claude/skills/memory" ]]; then
  rm -rf "$HOME/.claude/skills/memory"
fi
success "metamemory skill installed → $SKILLS_DIR/metamemory"

# Install metabot skill (bundled in src/skills/metabot/)
info "Installing metabot skill..."
mkdir -p "$SKILLS_DIR/metabot"
cp "$METABOT_HOME/src/skills/metabot/SKILL.md" "$SKILLS_DIR/metabot/SKILL.md"
success "metabot skill installed → $SKILLS_DIR/metabot"

# Install voice skill (bundled in src/skills/voice/)
info "Installing voice skill..."
mkdir -p "$SKILLS_DIR/voice"
cp "$METABOT_HOME/src/skills/voice/SKILL.md" "$SKILLS_DIR/voice/SKILL.md"
success "voice skill installed → $SKILLS_DIR/voice"

# Install skill-hub skill (bundled in src/skills/skill-hub/)
info "Installing skill-hub skill..."
mkdir -p "$SKILLS_DIR/skill-hub"
cp "$METABOT_HOME/src/skills/skill-hub/SKILL.md" "$SKILLS_DIR/skill-hub/SKILL.md"
success "skill-hub skill installed → $SKILLS_DIR/skill-hub"

# Detect Feishu bots
HAS_FEISHU=false
if [[ "$SKIP_CONFIG" == "false" && "$SETUP_FEISHU" == "true" ]]; then
  HAS_FEISHU=true
elif [[ "$SKIP_CONFIG" == "true" && -f "$METABOT_HOME/bots.json" ]]; then
  # Detect from existing config
  if node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); process.exit((c.feishuBots||[]).length>0?0:1)" 2>/dev/null; then
    HAS_FEISHU=true
  fi
fi

# Install lark-cli and AI Agent skills — only when Feishu is configured
SETUP_LARK_CLI=false
if [[ "$HAS_FEISHU" == "true" ]]; then
  echo ""
  info "lark-cli provides 19 AI Agent skills for Feishu (docs, sheets, calendar, IM, etc.)"
  if prompt_yn "Install lark-cli and Feishu AI Agent skills?" "y"; then
    SETUP_LARK_CLI=true
  fi
fi

if [[ "$SETUP_LARK_CLI" == "true" ]]; then
  info "Installing lark-cli (Feishu official CLI)..."
  if command -v lark-cli &>/dev/null; then
    success "lark-cli already installed ($(lark-cli --version 2>/dev/null || echo 'unknown'))"
  else
    # Try global install, fall back to user-local prefix
    if npm install -g @larksuite/cli 2>/dev/null; then
      success "lark-cli installed globally"
    else
      mkdir -p "$HOME/.npm-global"
      npm config set prefix "$HOME/.npm-global"
      npm install -g @larksuite/cli 2>/dev/null
      # Ensure ~/.npm-global/bin is in PATH
      if ! echo "$PATH" | grep -q "$HOME/.npm-global/bin"; then
        export PATH="$HOME/.npm-global/bin:$PATH"
        echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"
        info "Added ~/.npm-global/bin to PATH in ~/.bashrc"
      fi
      success "lark-cli installed to ~/.npm-global/bin"
    fi
  fi

  # Configure lark-cli with first Feishu bot credentials
  if [[ ! -f "$HOME/.lark-cli/config.json" && -f "$METABOT_HOME/bots.json" ]]; then
    FEISHU_APP_ID=$(node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); console.log((c.feishuBots||[])[0]?.feishuAppId||'')" 2>/dev/null)
    FEISHU_APP_SECRET=$(node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); console.log((c.feishuBots||[])[0]?.feishuAppSecret||'')" 2>/dev/null)
    if [[ -n "$FEISHU_APP_ID" && -n "$FEISHU_APP_SECRET" ]]; then
      echo "$FEISHU_APP_SECRET" | lark-cli config init --app-id "$FEISHU_APP_ID" --app-secret-stdin --brand feishu 2>/dev/null && \
        success "lark-cli configured with app $FEISHU_APP_ID" || \
        warn "lark-cli config failed — you can run manually: lark-cli config init"
    fi
  fi

  # Install lark-cli AI Agent skills for Claude Code
  info "Installing lark-cli AI Agent skills..."
  if npx skills add larksuite/cli --all -y -g 2>/dev/null; then
    success "lark-cli AI Agent skills installed (19 skills)"
  else
    warn "lark-cli skills install failed — you can run manually: npx skills add larksuite/cli --all -y -g"
  fi
fi

# Clean up old feishu-doc skill if present
if [[ -d "$SKILLS_DIR/feishu-doc" ]]; then
  rm -rf "$SKILLS_DIR/feishu-doc"
  info "Removed legacy feishu-doc skill (replaced by lark-cli skills)"
fi

# Determine working directory
if [[ "$SKIP_CONFIG" == "false" ]]; then
  DEPLOY_WORK_DIR="$WORK_DIR"
else
  if [[ -f "$METABOT_HOME/bots.json" ]]; then
    DEPLOY_WORK_DIR=$(node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$METABOT_HOME/bots.json','utf-8'));
      const bots = [...(cfg.feishuBots||[]),...(cfg.telegramBots||[]),...(cfg.wechatBots||[])];
      if (bots[0]) console.log(bots[0].defaultWorkingDirectory);
    " 2>/dev/null || echo "")
  else
    DEPLOY_WORK_DIR=""
  fi
fi

# Deploy skills + CLAUDE.md to bot working directory
if [[ -n "${DEPLOY_WORK_DIR:-}" ]]; then
  SKILLS_DEST="$DEPLOY_WORK_DIR/.claude/skills"

  # Copy skills (common + lark-cli skills if Feishu)
  DEPLOY_SKILLS="metaskill metamemory metabot voice skill-hub"
  if [[ "$SETUP_LARK_CLI" == "true" ]]; then
    for lark_skill in lark-base lark-calendar lark-contact lark-doc lark-drive lark-event lark-im lark-mail lark-minutes lark-openapi-explorer lark-shared lark-sheets lark-skill-maker lark-task lark-vc lark-whiteboard lark-wiki lark-workflow-meeting-summary lark-workflow-standup-report; do
      [[ -d "$SKILLS_DIR/$lark_skill" ]] && DEPLOY_SKILLS="$DEPLOY_SKILLS $lark_skill"
    done
  fi
  for SKILL in $DEPLOY_SKILLS; do
    if [[ -d "$SKILLS_DIR/$SKILL" ]]; then
      mkdir -p "$SKILLS_DEST/$SKILL"
      cp -r "$SKILLS_DIR/$SKILL/." "$SKILLS_DEST/$SKILL/"
      success "Deployed $SKILL → $SKILLS_DEST/$SKILL"
    fi
  done

  # Deploy CLAUDE.md to working directory (+ AGENTS.md symlink for Kimi engine)
  if [[ -f "$METABOT_HOME/src/workspace/CLAUDE.md" ]]; then
    cp "$METABOT_HOME/src/workspace/CLAUDE.md" "$DEPLOY_WORK_DIR/CLAUDE.md"
    success "Deployed CLAUDE.md → $DEPLOY_WORK_DIR/CLAUDE.md"
    # Kimi engine reads AGENTS.md not CLAUDE.md — symlink so both engines see the same doc
    if [[ ! -e "$DEPLOY_WORK_DIR/AGENTS.md" ]]; then
      (cd "$DEPLOY_WORK_DIR" && ln -s CLAUDE.md AGENTS.md 2>/dev/null) \
        && success "Linked AGENTS.md → CLAUDE.md (for Kimi engine compatibility)" \
        || warn "Could not create AGENTS.md symlink"
    fi
  fi
else
  warn "Could not determine working directory, skipping workspace deployment"
fi

# ============================================================================
# Phase 7: MetaMemory (embedded in MetaBot)
# ============================================================================
step "Phase 7: MetaMemory"

METAMEMORY_INSTALLED=false

info "MetaMemory is embedded in MetaBot (no separate server needed)."
mkdir -p "${METABOT_HOME}/data"

# Migrate existing database from standalone Python MetaMemory if found
if [[ -f "$HOME/.metamemory-data/metamemory.db" && ! -f "$METABOT_HOME/data/metamemory.db" ]]; then
  info "Migrating existing MetaMemory database..."
  cp "$HOME/.metamemory-data/metamemory.db" "$METABOT_HOME/data/"
  success "Database migrated from ~/.metamemory-data/"
fi

# Stop old standalone MetaMemory PM2 process if running
if pm2 describe metamemory &>/dev/null 2>&1; then
  info "Stopping old standalone MetaMemory PM2 process..."
  pm2 delete metamemory 2>/dev/null || true
  success "Old MetaMemory process removed"
fi

# Kill any process still occupying port 8100 (e.g. old Python uvicorn)
if command -v lsof &>/dev/null; then
  OLD_PID=$(lsof -ti :8100 2>/dev/null || true)
  if [[ -n "$OLD_PID" ]]; then
    info "Killing old process on port 8100 (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

METAMEMORY_INSTALLED=true
success "MetaMemory will start automatically with MetaBot on port 8100"

# Install mm() shell shortcut for MetaMemory CLI
BASH_ALIASES="$HOME/.bash_aliases"
if ! grep -q 'mm()' "$BASH_ALIASES" 2>/dev/null; then
  info "Installing mm() shell shortcut..."
  cat >> "$BASH_ALIASES" << 'MMEOF'

# MetaMemory shortcuts (installed by MetaBot)
export MEMORY_URL="http://localhost:8100"
export MEMORY_AUTH="Authorization: Bearer ${MEMORY_ADMIN_TOKEN:-${MEMORY_TOKEN:-${MEMORY_SECRET:-${API_SECRET:-changeme}}}}"

mm() {
  local cmd="${1:-help}"
  shift 2>/dev/null
  case "$cmd" in
    search|s)
      curl -s -H "$MEMORY_AUTH" "$MEMORY_URL/api/search?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$*'))")"
      ;;
    get|g)
      curl -s -H "$MEMORY_AUTH" "$MEMORY_URL/api/documents/$1"
      ;;
    list|ls)
      curl -s -H "$MEMORY_AUTH" "$MEMORY_URL/api/documents?folder_id=${1:-root}&limit=50"
      ;;
    folders|f)
      curl -s -H "$MEMORY_AUTH" "$MEMORY_URL/api/folders"
      ;;
    create|c)
      local title="$1"; shift
      local content="$*"
      curl -s -X POST "$MEMORY_URL/api/documents" \
        -H "$MEMORY_AUTH" -H "Content-Type: application/json" \
        -d "{\"title\":\"$title\",\"folder_id\":\"root\",\"content\":\"$content\"}"
      ;;
    health|h)
      curl -s -H "$MEMORY_AUTH" "$MEMORY_URL/api/health"
      ;;
    *)
      echo "mm - MetaMemory CLI"
      echo "  mm search <query>       - Search documents"
      echo "  mm get <doc_id>         - Get document by ID"
      echo "  mm list [folder_id]     - List documents (default: root)"
      echo "  mm folders              - List folder tree"
      echo "  mm create <title> <md>  - Create a document"
      echo "  mm health               - Health check"
      ;;
  esac
}
MMEOF
  # Patch the actual API_SECRET into the file
  if [[ -n "${API_SECRET:-}" ]]; then
    sed_i "s|\${API_SECRET:-changeme}|${API_SECRET}|g" "$BASH_ALIASES"
  fi
  success "mm() shortcut installed"
else
  info "mm() shortcut already exists, skipping"
fi

# Install mb() shell shortcut for MetaBot API (Agent Bus, Scheduling, Bot Management)
if ! grep -q 'mb()' "$BASH_ALIASES" 2>/dev/null; then
  info "Installing mb() shell shortcut..."
  cat >> "$BASH_ALIASES" << 'MBEOF'

# MetaBot API shortcuts (installed by MetaBot)
export METABOT_URL="http://localhost:${METABOT_API_PORT:-9100}"
export METABOT_AUTH="Authorization: Bearer ${METABOT_API_SECRET:-changeme}"

mb() {
  local cmd="${1:-help}"
  shift 2>/dev/null
  case "$cmd" in
    # --- Bot management ---
    bots|b)
      curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/bots" | python3 -m json.tool 2>/dev/null || curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/bots"
      ;;
    bot)
      curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/bots/$1" | python3 -m json.tool 2>/dev/null || curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/bots/$1"
      ;;
    # --- Task delegation ---
    task|t)
      local bot="$1" chat="$2"; shift 2 2>/dev/null
      local prompt="$*"
      if [[ -z "$bot" || -z "$chat" || -z "$prompt" ]]; then
        echo "Usage: mb task <botName> <chatId> <prompt>"
        return 1
      fi
      curl -s -X POST "$METABOT_URL/api/tasks" \
        -H "$METABOT_AUTH" -H "Content-Type: application/json" \
        -d "{\"botName\":\"$bot\",\"chatId\":\"$chat\",\"prompt\":\"$prompt\",\"sendCards\":true}"
      ;;
    # --- Scheduling ---
    schedule|sched|sc)
      local subcmd="${1:-list}"; shift 2>/dev/null
      case "$subcmd" in
        list|ls)
          curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/schedule" | python3 -m json.tool 2>/dev/null || curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/schedule"
          ;;
        add|a)
          local bot="$1" chat="$2" delay="$3"; shift 3 2>/dev/null
          local prompt="$*"
          if [[ -z "$bot" || -z "$chat" || -z "$delay" || -z "$prompt" ]]; then
            echo "Usage: mb schedule add <botName> <chatId> <delaySeconds> <prompt>"
            return 1
          fi
          curl -s -X POST "$METABOT_URL/api/schedule" \
            -H "$METABOT_AUTH" -H "Content-Type: application/json" \
            -d "{\"botName\":\"$bot\",\"chatId\":\"$chat\",\"delaySeconds\":$delay,\"prompt\":\"$prompt\"}"
          ;;
        cancel|rm)
          if [[ -z "$1" ]]; then echo "Usage: mb schedule cancel <id>"; return 1; fi
          curl -s -X DELETE "$METABOT_URL/api/schedule/$1" -H "$METABOT_AUTH"
          ;;
        *)
          echo "mb schedule - Task scheduling"
          echo "  mb schedule list                                    - List pending tasks"
          echo "  mb schedule add <bot> <chatId> <delaySec> <prompt>  - Schedule a task"
          echo "  mb schedule cancel <id>                             - Cancel a task"
          ;;
      esac
      ;;
    # --- Health ---
    health|h)
      curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/health" | python3 -m json.tool 2>/dev/null || curl -s -H "$METABOT_AUTH" "$METABOT_URL/api/health"
      ;;
    # --- Help ---
    *)
      echo "mb - MetaBot API CLI"
      echo ""
      echo "  Bots:"
      echo "    mb bots                          - List all bots"
      echo "    mb bot <name>                    - Get bot details"
      echo ""
      echo "  Tasks:"
      echo "    mb task <bot> <chatId> <prompt>  - Delegate task to a bot"
      echo ""
      echo "  Scheduling:"
      echo "    mb schedule list                 - List pending scheduled tasks"
      echo "    mb schedule add <bot> <chatId> <delaySec> <prompt>"
      echo "    mb schedule cancel <id>          - Cancel a scheduled task"
      echo ""
      echo "  System:"
      echo "    mb health                        - Health check"
      ;;
  esac
}
MBEOF
  # Patch the actual secrets into the file
  if [[ -n "${API_PORT:-}" ]]; then
    sed_i "s|\${METABOT_API_PORT:-9100}|${API_PORT}|g" "$BASH_ALIASES"
  fi
  if [[ -n "${API_SECRET:-}" ]]; then
    sed_i "s|\${METABOT_API_SECRET:-changeme}|${API_SECRET}|g" "$BASH_ALIASES"
  fi
  success "mb() shortcut installed"
else
  info "mb() shortcut already exists, skipping"
fi

# Ensure ~/.bashrc sources ~/.bash_aliases (Ubuntu default, but not universal)
if [[ -f "$HOME/.bashrc" ]] && ! grep -q 'bash_aliases' "$HOME/.bashrc"; then
  echo -e '\n# Load bash aliases\nif [ -f ~/.bash_aliases ]; then\n    . ~/.bash_aliases\nfi' >> "$HOME/.bashrc"
fi
# Source it in the current shell so mm/mb work immediately after install
source "$BASH_ALIASES" 2>/dev/null || true

# Install mm/mb/metabot as standalone executables in ~/.local/bin (no source needed)
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
CLI_TOOLS="mm mb metabot"
for cli in $CLI_TOOLS; do
  if [[ -f "$METABOT_HOME/bin/$cli" ]]; then
    cp "$METABOT_HOME/bin/$cli" "$LOCAL_BIN/$cli"
    chmod +x "$LOCAL_BIN/$cli"
  fi
done
# Clean up legacy fd CLI if present
[[ -f "$LOCAL_BIN/fd" ]] && rm -f "$LOCAL_BIN/fd"
# Ensure ~/.local/bin is in PATH (most distros include it, but not all)
if ! echo "$PATH" | grep -q "$LOCAL_BIN"; then
  echo "export PATH=\"$LOCAL_BIN:\$PATH\"" >> "$HOME/.bashrc"
  info "Added ~/.local/bin to PATH in ~/.bashrc"
fi
success "mm/mb/metabot CLI tools installed to $LOCAL_BIN"

# Persist METABOT_HOME for non-default install paths so the CLI tools
# (mm/mb/metabot) can find the install in new shell sessions. The CLIs all
# fall back to $HOME/metabot, so we only need to export when it differs.
if [[ "$METABOT_HOME" != "$DEFAULT_METABOT_HOME" ]]; then
  for rc_file in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [[ -f "$rc_file" ]] || continue
    # Drop any prior export to keep this idempotent across re-runs.
    if grep -q '^export METABOT_HOME=' "$rc_file" 2>/dev/null; then
      sed_i '/^export METABOT_HOME=/d' "$rc_file"
    fi
  done
  echo "export METABOT_HOME=\"$METABOT_HOME\"" >> "$HOME/.bashrc"
  if [[ -f "$HOME/.zshrc" ]]; then
    echo "export METABOT_HOME=\"$METABOT_HOME\"" >> "$HOME/.zshrc"
  fi
  info "Persisted METABOT_HOME=$METABOT_HOME to shell rc files"
fi

# ============================================================================
# Phase 8: Build + Start MetaBot with PM2
# ============================================================================
step "Phase 8: Starting MetaBot"

cd "$METABOT_HOME"

info "Building TypeScript..."
npm run build 2>/dev/null && success "Build complete" || warn "Build failed, will use tsx directly via PM2"

# Always delete + start fresh to avoid stale/stopped process issues
if pm2 describe metabot &>/dev/null 2>&1; then
  info "Removing old MetaBot PM2 process..."
  pm2 delete metabot 2>/dev/null || true
fi
info "Starting MetaBot with PM2..."
pm2 start ecosystem.config.cjs

pm2 save --force 2>/dev/null || true
success "MetaBot is running!"

# --- WeChat QR login: wait for URL and display it ---
HAS_WECHAT_BOT=false
if [[ "$SKIP_CONFIG" == "false" && "${SETUP_WECHAT:-false}" == "true" ]]; then
  HAS_WECHAT_BOT=true
elif [[ "$SKIP_CONFIG" == "true" && -f "$METABOT_HOME/bots.json" ]]; then
  if node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); process.exit((c.wechatBots||[]).length>0?0:1)" 2>/dev/null; then
    HAS_WECHAT_BOT=true
  fi
fi

if [[ "$HAS_WECHAT_BOT" == "true" ]]; then
  echo ""
  info "WeChat ClawBot detected — waiting for QR login URL..."
  WX_QR_URL=""
  LOG_FILE="$METABOT_HOME/logs/out.log"
  for i in $(seq 1 15); do
    sleep 2
    if [[ -f "$LOG_FILE" ]]; then
      WX_QR_URL=$(grep -oP 'Open this URL or scan the QR code: \K\S+' "$LOG_FILE" 2>/dev/null | tail -1 || true)
      if [[ -n "$WX_QR_URL" ]]; then
        break
      fi
    fi
  done

  if [[ -n "$WX_QR_URL" ]]; then
    echo ""
    echo -e "  ${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
    echo -e "  ${GREEN}${BOLD}║  WeChat ClawBot — Scan QR Code to bind      ║${NC}"
    echo -e "  ${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${CYAN}${WX_QR_URL}${NC}"
    echo ""
    echo "  Open the URL above in your browser, then scan the QR code with WeChat."
    echo "  The bot will automatically connect after scanning."
    echo ""
  else
    warn "QR URL not yet available. Check logs to get it:"
    echo "    pm2 logs metabot --lines 30"
  fi
fi

# ============================================================================
# Phase 9: Summary
# ============================================================================
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║           MetaBot — Ready!               ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo -e "  ${BOLD}Installation:${NC}   ${METABOT_HOME}"
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Working Dir:${NC}    ${WORK_DIR}"
  echo -e "  ${BOLD}API:${NC}            http://localhost:${API_PORT}"
  echo -e "  ${BOLD}API Secret:${NC}     ${API_SECRET:0:8}...${API_SECRET: -4}"
  echo -e "  ${BOLD}Engine:${NC}         ${BOT_ENGINE:-claude}"
  echo -e "  ${BOLD}Auth Method:${NC}    ${CLAUDE_AUTH_METHOD}"
  if [[ "${CLAUDE_AUTH_METHOD}" == "third_party" ]]; then
    echo -e "  ${BOLD}Provider:${NC}       ${PROVIDER_NAME}"
  fi
fi
if [[ "$METAMEMORY_INSTALLED" == "true" ]]; then
  echo -e "  ${BOLD}MetaMemory:${NC}     http://localhost:8100"
fi
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    pm2 logs metabot          # View MetaBot logs"
echo "    pm2 restart metabot       # Restart MetaBot"
echo "    pm2 stop metabot          # Stop MetaBot"
if [[ "$METAMEMORY_INSTALLED" == "true" ]]; then
  echo "    mm search <query>         # Search MetaMemory"
  echo "    mm folders                # Browse knowledge tree"
fi
echo ""
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Next Steps:${NC}"
  STEP_NUM=1
  if [[ "${CLAUDE_AUTH_METHOD}" == "subscription" ]]; then
    echo "    ${STEP_NUM}. Run 'claude login' in a separate terminal"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${CLAUDE_AUTH_METHOD}" == "kimi" ]]; then
    echo "    ${STEP_NUM}. Run 'kimi login' in a separate terminal (https://kimi.com to sign up)"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "$SETUP_FEISHU" == "true" ]]; then
    echo "    ${STEP_NUM}. Configure Feishu app: enable long-connection events + im.message.receive_v1 + publish"
    STEP_NUM=$((STEP_NUM + 1))
    echo "    ${STEP_NUM}. Open Feishu and message your bot"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${SETUP_TELEGRAM:-false}" == "true" ]]; then
    echo "    ${STEP_NUM}. Open Telegram and message your bot — it's ready now!"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${SETUP_WECHAT:-false}" == "true" ]]; then
    echo "    ${STEP_NUM}. Scan the WeChat QR code shown above (or check pm2 logs metabot)"
    STEP_NUM=$((STEP_NUM + 1))
    echo "    ${STEP_NUM}. Send a message to your ClawBot in WeChat"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  echo "    ${STEP_NUM}. Check logs: pm2 logs metabot"
fi
echo ""
