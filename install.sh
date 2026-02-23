#!/usr/bin/env bash
# MetaBot Genesis Installer
# One command: curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
set -euo pipefail

# ============================================================================
# Configuration defaults
# ============================================================================
METABOT_HOME="${METABOT_HOME:-$HOME/metabot}"
METABOT_REPO="${METABOT_REPO:-https://github.com/xvirobotics/metabot.git}"
DEFAULT_BOT_NAME="genesis"
DEFAULT_WORK_DIR="$HOME/metabot-workspace"

# ============================================================================
# Colors and formatting
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║          MetaBot Genesis Installer       ║"
  echo "  ║   一生二，二生三，三生万物                   ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo -e "${NC}"
  echo ""
}

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}==> $*${NC}"; }

prompt_input() {
  local varname="$1"
  local prompt_text="$2"
  local default_val="${3:-}"
  local input

  if [[ -n "$default_val" ]]; then
    echo -en "${CYAN}$prompt_text${NC} [${default_val}]: "
  else
    echo -en "${CYAN}$prompt_text${NC}: "
  fi
  read -r input
  if [[ -z "$input" ]]; then
    input="$default_val"
  fi
  eval "$varname=\"$input\""
}

prompt_secret() {
  local varname="$1"
  local prompt_text="$2"
  local input

  echo -en "${CYAN}$prompt_text${NC}: "
  read -rs input
  echo ""
  eval "$varname=\"$input\""
}

prompt_yn() {
  local prompt_text="$1"
  local default="${2:-y}"
  local input

  if [[ "$default" == "y" ]]; then
    echo -en "${CYAN}$prompt_text${NC} [Y/n]: "
  else
    echo -en "${CYAN}$prompt_text${NC} [y/N]: "
  fi
  read -r input
  input="${input:-$default}"
  [[ "${input,,}" == "y" || "${input,,}" == "yes" ]]
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

# Check Node.js 18+
if command -v node &>/dev/null; then
  NODE_VER="$(node --version | sed 's/v//')"
  NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    success "Node.js found: v${NODE_VER}"
  else
    error "Node.js v${NODE_VER} found, but v18+ is required."
    MISSING=1
  fi
else
  error "Node.js not found."
  echo "  Install: https://nodejs.org/ or use nvm"
  MISSING=1
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
  git pull --ff-only || warn "git pull failed, continuing with existing code"
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

# Install PM2 globally if missing
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2 globally..."
  npm install -g pm2
  success "PM2 installed"
else
  success "PM2 already installed: $(pm2 --version 2>/dev/null || echo 'unknown')"
fi

# Install Claude CLI if missing (required regardless of auth method)
if command -v claude &>/dev/null; then
  success "Claude CLI found: $(command -v claude)"
else
  info "Installing Claude CLI..."
  npm install -g @anthropic-ai/claude-code
  if command -v claude &>/dev/null; then
    success "Claude CLI installed"
  else
    warn "Claude CLI install may have failed. You can install manually: npm install -g @anthropic-ai/claude-code"
  fi
fi

# ============================================================================
# Phase 4: Interactive configuration
# ============================================================================
step "Phase 4: Configuration"

# Skip interactive config if .env already exists
if [[ -f "$METABOT_HOME/.env" ]]; then
  warn ".env file already exists. Skipping interactive config."
  warn "Edit ${METABOT_HOME}/.env to modify settings."
  SKIP_CONFIG=true
else
  SKIP_CONFIG=false
fi

if [[ "$SKIP_CONFIG" == "false" ]]; then
  echo ""
  echo -e "${BOLD}Select bot platform:${NC}"
  echo "  1) Feishu/Lark"
  echo "  2) Telegram"
  echo "  3) Both"
  echo -en "${CYAN}Choice${NC} [1]: "
  read -r PLATFORM_CHOICE
  PLATFORM_CHOICE="${PLATFORM_CHOICE:-1}"

  SETUP_FEISHU=false
  SETUP_TELEGRAM=false
  case "$PLATFORM_CHOICE" in
    1) SETUP_FEISHU=true ;;
    2) SETUP_TELEGRAM=true ;;
    3) SETUP_FEISHU=true; SETUP_TELEGRAM=true ;;
    *) SETUP_FEISHU=true ;;
  esac

  # Collect Feishu credentials
  FEISHU_APP_ID=""
  FEISHU_APP_SECRET=""
  if [[ "$SETUP_FEISHU" == "true" ]]; then
    echo ""
    echo -e "${BOLD}Feishu/Lark Configuration:${NC}"
    prompt_input FEISHU_APP_ID "Feishu App ID (e.g. cli_xxxx)"
    prompt_secret FEISHU_APP_SECRET "Feishu App Secret"
    if [[ -z "$FEISHU_APP_ID" || -z "$FEISHU_APP_SECRET" ]]; then
      error "Feishu App ID and Secret are required."
      exit 1
    fi
  fi

  # Collect Telegram credentials
  TELEGRAM_BOT_TOKEN=""
  if [[ "$SETUP_TELEGRAM" == "true" ]]; then
    echo ""
    echo -e "${BOLD}Telegram Configuration:${NC}"
    prompt_secret TELEGRAM_BOT_TOKEN "Telegram Bot Token (from @BotFather)"
    if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then
      error "Telegram Bot Token is required."
      exit 1
    fi
  fi

  # --------------------------------------------------------------------------
  # Claude AI Authentication
  # --------------------------------------------------------------------------
  echo ""
  echo -e "${BOLD}Claude AI Authentication:${NC}"
  echo "  1) Claude Code Subscription (OAuth login via 'claude login')"
  echo "  2) Anthropic API Key (ANTHROPIC_API_KEY=sk-ant-...)"
  echo "  3) Third-party provider (Kimi/Moonshot, DeepSeek, GLM, etc.)"
  echo -en "${CYAN}Choice${NC} [1]: "
  read -r AUTH_CHOICE
  AUTH_CHOICE="${AUTH_CHOICE:-1}"

  # Auth env vars to write into .env
  CLAUDE_AUTH_ENV_LINES=""

  case "$AUTH_CHOICE" in
    1)
      # OAuth subscription — no env vars needed, user runs `claude login` separately
      info "Using Claude Code Subscription (OAuth)."
      info "You will need to run 'claude login' in a separate terminal after install."
      CLAUDE_AUTH_METHOD="subscription"
      ;;
    2)
      # Direct Anthropic API key
      prompt_secret ANTHROPIC_API_KEY "Anthropic API Key (sk-ant-...)"
      if [[ -z "$ANTHROPIC_API_KEY" ]]; then
        error "API key is required."
        exit 1
      fi
      CLAUDE_AUTH_METHOD="anthropic_key"
      CLAUDE_AUTH_ENV_LINES="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
      ;;
    3)
      # Third-party provider
      echo ""
      echo -e "${BOLD}Select third-party provider:${NC}"
      echo "  1) Kimi/Moonshot  (https://platform.moonshot.cn)"
      echo "  2) DeepSeek       (https://platform.deepseek.com)"
      echo "  3) GLM/Zhipu      (https://open.bigmodel.cn)"
      echo "  4) Custom (enter your own base URL)"
      echo -en "${CYAN}Provider${NC} [1]: "
      read -r PROVIDER_CHOICE
      PROVIDER_CHOICE="${PROVIDER_CHOICE:-1}"

      case "$PROVIDER_CHOICE" in
        1)
          PROVIDER_NAME="Kimi/Moonshot"
          PROVIDER_BASE_URL="https://api.moonshot.ai/anthropic"
          PROVIDER_DEFAULT_MODEL=""
          PROVIDER_DEFAULT_SMALL_MODEL=""
          ;;
        2)
          PROVIDER_NAME="DeepSeek"
          PROVIDER_BASE_URL="https://api.deepseek.com/anthropic"
          PROVIDER_DEFAULT_MODEL="deepseek-chat"
          PROVIDER_DEFAULT_SMALL_MODEL="deepseek-chat"
          ;;
        3)
          PROVIDER_NAME="GLM/Zhipu"
          PROVIDER_BASE_URL="https://api.z.ai/api/anthropic"
          PROVIDER_DEFAULT_MODEL="glm-4.5"
          PROVIDER_DEFAULT_SMALL_MODEL=""
          ;;
        4)
          PROVIDER_NAME="Custom"
          prompt_input PROVIDER_BASE_URL "API Base URL (e.g. https://api.example.com/anthropic)"
          PROVIDER_DEFAULT_MODEL=""
          PROVIDER_DEFAULT_SMALL_MODEL=""
          ;;
        *)
          PROVIDER_NAME="Kimi/Moonshot"
          PROVIDER_BASE_URL="https://api.moonshot.ai/anthropic"
          PROVIDER_DEFAULT_MODEL=""
          PROVIDER_DEFAULT_SMALL_MODEL=""
          ;;
      esac

      info "Provider: ${PROVIDER_NAME}"
      prompt_input PROVIDER_BASE_URL "API Base URL" "$PROVIDER_BASE_URL"
      prompt_secret PROVIDER_API_KEY "${PROVIDER_NAME} API Key"
      if [[ -z "$PROVIDER_API_KEY" ]]; then
        error "API key is required."
        exit 1
      fi

      # Model configuration (optional)
      prompt_input PROVIDER_MODEL "Model name (leave empty for provider default)" "${PROVIDER_DEFAULT_MODEL}"
      prompt_input PROVIDER_SMALL_MODEL "Small/fast model name (leave empty to skip)" "${PROVIDER_DEFAULT_SMALL_MODEL}"

      CLAUDE_AUTH_METHOD="third_party"
      CLAUDE_AUTH_ENV_LINES="# ${PROVIDER_NAME} Provider
ANTHROPIC_BASE_URL=${PROVIDER_BASE_URL}
ANTHROPIC_AUTH_TOKEN=${PROVIDER_API_KEY}"
      if [[ -n "$PROVIDER_MODEL" ]]; then
        CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
ANTHROPIC_MODEL=${PROVIDER_MODEL}"
      fi
      if [[ -n "$PROVIDER_SMALL_MODEL" ]]; then
        CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
ANTHROPIC_SMALL_FAST_MODEL=${PROVIDER_SMALL_MODEL}"
      fi
      # DeepSeek benefits from extended timeout
      if [[ "$PROVIDER_CHOICE" == "2" ]]; then
        CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
API_TIMEOUT_MS=600000"
      fi
      ;;
    *)
      CLAUDE_AUTH_METHOD="subscription"
      ;;
  esac

  # Common settings
  echo ""
  echo -e "${BOLD}Common Settings:${NC}"
  prompt_input BOT_NAME "Bot name" "$DEFAULT_BOT_NAME"
  prompt_input WORK_DIR "Working directory for Claude" "$DEFAULT_WORK_DIR"

  # Generate API secret
  API_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64)"
  info "Generated API secret (stored in .env)"

  prompt_input API_PORT "API server port" "9100"
  prompt_input LOG_LEVEL "Log level (debug/info/warn/error)" "info"

  # MetaMemory
  INSTALL_METAMEMORY=false
  if prompt_yn "Install MetaMemory server for knowledge persistence?" "n"; then
    INSTALL_METAMEMORY=true
    prompt_input MEMORY_SERVER_URL "MetaMemory server URL" "http://localhost:8100"
  else
    MEMORY_SERVER_URL="http://localhost:8100"
  fi

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
  # Create working directory
  mkdir -p "$WORK_DIR"
  success "Working directory created: ${WORK_DIR}"

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
    echo "# CLAUDE_MODEL="
    echo "LOG_LEVEL=${LOG_LEVEL}"
    if [[ -n "${CLAUDE_PATH:-}" ]]; then
      echo "CLAUDE_EXECUTABLE_PATH=${CLAUDE_PATH}"
    fi
    echo ""
    echo "# MetaMemory"
    echo "MEMORY_SERVER_URL=${MEMORY_SERVER_URL}"
  } > "$METABOT_HOME/.env"
  chmod 600 "$METABOT_HOME/.env"
  success ".env generated"

  # Generate bots.json
  BOTS_JSON="$METABOT_HOME/bots.json"

  # Build JSON using node for proper escaping
  FEISHU_BOTS_JSON="[]"
  TELEGRAM_BOTS_JSON="[]"

  if [[ "$SETUP_FEISHU" == "true" ]]; then
    FEISHU_BOTS_JSON=$(node -e "
      console.log(JSON.stringify([{
        name: process.argv[1],
        feishuAppId: process.argv[2],
        feishuAppSecret: process.argv[3],
        defaultWorkingDirectory: process.argv[4]
      }], null, 2))
    " "$BOT_NAME" "$FEISHU_APP_ID" "$FEISHU_APP_SECRET" "$WORK_DIR")
  fi

  if [[ "$SETUP_TELEGRAM" == "true" ]]; then
    TG_NAME="$BOT_NAME"
    if [[ "$SETUP_FEISHU" == "true" ]]; then
      TG_NAME="${BOT_NAME}-telegram"
    fi
    TELEGRAM_BOTS_JSON=$(node -e "
      console.log(JSON.stringify([{
        name: process.argv[1],
        telegramBotToken: process.argv[2],
        defaultWorkingDirectory: process.argv[3]
      }], null, 2))
    " "$TG_NAME" "$TELEGRAM_BOT_TOKEN" "$WORK_DIR")
  fi

  node -e "
    const config = {};
    const feishu = JSON.parse(process.argv[1]);
    const telegram = JSON.parse(process.argv[2]);
    if (feishu.length > 0) config.feishuBots = feishu;
    if (telegram.length > 0) config.telegramBots = telegram;
    console.log(JSON.stringify(config, null, 2));
  " "$FEISHU_BOTS_JSON" "$TELEGRAM_BOTS_JSON" > "$BOTS_JSON"
  chmod 600 "$BOTS_JSON"
  success "bots.json generated"
fi

# ============================================================================
# Phase 6: Install skills
# ============================================================================
step "Phase 6: Installing skills"

SKILLS_SRC="$HOME/.claude/skills"
if [[ "$SKIP_CONFIG" == "false" ]]; then
  SKILLS_DEST="$WORK_DIR/.claude/skills"
else
  # Read workdir from bots.json if available
  if [[ -f "$METABOT_HOME/bots.json" ]]; then
    WORK_DIR=$(node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8'));
      const bots = [...(cfg.feishuBots||[]),...(cfg.telegramBots||[])];
      if (bots[0]) console.log(bots[0].defaultWorkingDirectory);
    " 2>/dev/null || echo "")
    if [[ -n "$WORK_DIR" ]]; then
      SKILLS_DEST="$WORK_DIR/.claude/skills"
    else
      SKILLS_DEST=""
    fi
  else
    SKILLS_DEST=""
  fi
fi

if [[ -n "${SKILLS_DEST:-}" ]]; then
  for SKILL in metaskill metamemory; do
    if [[ -d "$SKILLS_SRC/$SKILL" ]]; then
      mkdir -p "$SKILLS_DEST/$SKILL"
      cp -r "$SKILLS_SRC/$SKILL/." "$SKILLS_DEST/$SKILL/"
      success "Installed $SKILL to $SKILLS_DEST/$SKILL"
    else
      warn "Skill $SKILL not found at $SKILLS_SRC/$SKILL, skipping"
    fi
  done
else
  warn "Could not determine working directory, skipping skill installation"
fi

# ============================================================================
# Phase 7: MetaMemory server (optional)
# ============================================================================
if [[ "${INSTALL_METAMEMORY:-false}" == "true" ]]; then
  step "Phase 7: MetaMemory server"

  if command -v docker &>/dev/null; then
    info "Docker detected. You can start MetaMemory with:"
    echo "  docker run -d --name metamemory -p 8100:8100 -v metamemory-data:/data xvirobotics/metamemory"
    echo ""
    if prompt_yn "Start MetaMemory via Docker now?" "y"; then
      docker run -d --name metamemory -p 8100:8100 -v metamemory-data:/data xvirobotics/metamemory 2>/dev/null && \
        success "MetaMemory started via Docker" || \
        warn "Failed to start MetaMemory. You can start it manually later."
    fi
  else
    warn "Docker not found. MetaMemory server requires Docker or manual Python setup."
    echo "  See: https://github.com/xvirobotics/metamemory"
  fi
else
  info "Skipping MetaMemory server setup"
fi

# ============================================================================
# Phase 8: Start with PM2
# ============================================================================
step "Phase 8: Starting MetaBot with PM2"

cd "$METABOT_HOME"

# Build first
info "Building TypeScript..."
npm run build 2>/dev/null && success "Build complete" || warn "Build failed, will use tsx directly via PM2"

# Start or restart with PM2
if pm2 describe metabot &>/dev/null 2>&1; then
  info "MetaBot already in PM2, restarting..."
  pm2 restart metabot
else
  info "Starting MetaBot with PM2..."
  pm2 start ecosystem.config.cjs
fi

pm2 save --force 2>/dev/null || true
success "MetaBot is running!"

# ============================================================================
# Phase 9: Summary
# ============================================================================
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║      MetaBot Genesis - Ready!            ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo -e "  ${BOLD}Installation:${NC}   ${METABOT_HOME}"
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Working Dir:${NC}    ${WORK_DIR}"
  echo -e "  ${BOLD}API:${NC}            http://localhost:${API_PORT}"
  echo -e "  ${BOLD}API Secret:${NC}     ${API_SECRET:0:8}...${API_SECRET: -4} (in .env)"
fi
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    pm2 logs metabot          # View logs"
echo "    pm2 restart metabot       # Restart"
echo "    pm2 stop metabot          # Stop"
echo ""
echo -e "  ${BOLD}Self-Replication:${NC}"
echo "    Create new bots from chat by asking the Genesis Bot,"
echo "    or via API: POST /api/bots"
echo ""
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Auth Method:${NC}    ${CLAUDE_AUTH_METHOD}"
  if [[ "${CLAUDE_AUTH_METHOD}" == "third_party" ]]; then
    echo -e "  ${BOLD}Provider:${NC}       ${PROVIDER_NAME} (${PROVIDER_BASE_URL})"
  fi
  echo ""
  echo -e "  ${BOLD}Next Steps:${NC}"
  STEP_NUM=1
  if [[ "${CLAUDE_AUTH_METHOD}" == "subscription" ]]; then
    echo "    ${STEP_NUM}. Run 'claude login' in a separate terminal to authenticate"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "$SETUP_FEISHU" == "true" ]]; then
    echo "    ${STEP_NUM}. Open Feishu and message your bot to test"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${SETUP_TELEGRAM:-false}" == "true" ]]; then
    echo "    ${STEP_NUM}. Open Telegram and message your bot to test"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  echo "    ${STEP_NUM}. Check logs: pm2 logs metabot"
fi
echo ""
