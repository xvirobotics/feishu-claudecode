#!/usr/bin/env bash
# MetaBot Genesis Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
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
# Configuration defaults
# ============================================================================
METABOT_HOME="${METABOT_HOME:-$HOME/metabot}"
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
  echo "  ║          MetaBot Genesis Installer       ║"
  echo "  ║     一生二，二生三，三生万物               ║"
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
  echo "  Install: https://nodejs.org/ or use nvm/fnm"
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

if ! command -v pm2 &>/dev/null; then
  info "Installing PM2 globally..."
  npm install -g pm2
  success "PM2 installed"
else
  success "PM2 already installed"
fi

if command -v claude &>/dev/null; then
  success "Claude CLI found: $(command -v claude)"
else
  info "Installing Claude CLI..."
  npm install -g @anthropic-ai/claude-code
  if command -v claude &>/dev/null; then
    success "Claude CLI installed"
  else
    warn "Claude CLI install failed. Install manually: npm install -g @anthropic-ai/claude-code"
  fi
fi

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

  # ------ 4b: Claude AI authentication ------
  echo ""
  echo -e "${BOLD}Claude AI Authentication:${NC}"
  echo "  1) Claude Code Subscription (OAuth — run 'claude login' after install)"
  echo "  2) Anthropic API Key (sk-ant-...)"
  echo "  3) Third-party provider (Kimi/Moonshot, DeepSeek, GLM, etc.)"
  prompt_choice AUTH_CHOICE "1"

  CLAUDE_AUTH_ENV_LINES=""
  CLAUDE_AUTH_METHOD="subscription"

  case "$AUTH_CHOICE" in
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
  echo "  3) Both"
  prompt_choice PLATFORM_CHOICE "1"

  SETUP_FEISHU=false
  SETUP_TELEGRAM=false
  case "$PLATFORM_CHOICE" in
    1) SETUP_FEISHU=true ;;
    2) SETUP_TELEGRAM=true ;;
    3) SETUP_FEISHU=true; SETUP_TELEGRAM=true ;;
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

  # ------ 4d: Bot name + auto-generated settings ------
  echo ""
  echo -e "${BOLD}Bot Name:${NC}"
  prompt_input BOT_NAME "Name for your genesis bot" "genesis"

  # Auto-generate API secret
  API_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64)"
  API_PORT="9100"
  LOG_LEVEL="info"
  MEMORY_SERVER_URL="http://localhost:8100"

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
    echo "MEMORY_SERVER_URL=${MEMORY_SERVER_URL}"
  } > "$METABOT_HOME/.env"
  chmod 600 "$METABOT_HOME/.env"
  success ".env generated"

  # Generate bots.json (use node for safe JSON escaping)
  BOTS_JSON="$METABOT_HOME/bots.json"
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
    [[ "$SETUP_FEISHU" == "true" ]] && TG_NAME="${BOT_NAME}-telegram"
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
# Phase 6: Install skills (git clone from independent repos)
# ============================================================================
step "Phase 6: Installing skills"

SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$SKILLS_DIR"

# metaskill: clone xvirobotics/metaskill → ~/.claude/skills/metaskill
if [[ -d "$SKILLS_DIR/metaskill/.git" ]]; then
  info "metaskill exists, pulling latest..."
  (cd "$SKILLS_DIR/metaskill" && git pull --ff-only) || warn "metaskill pull failed, using existing"
  success "metaskill updated"
else
  info "Cloning metaskill..."
  if git clone https://github.com/xvirobotics/metaskill.git "$SKILLS_DIR/metaskill" 2>/dev/null; then
    success "metaskill cloned → $SKILLS_DIR/metaskill"
  else
    warn "Failed to clone metaskill (network issue or repo not accessible)"
  fi
fi

# Determine working directory for skill deployment
if [[ "$SKIP_CONFIG" == "false" ]]; then
  SKILLS_DEST="$WORK_DIR/.claude/skills"
else
  if [[ -f "$METABOT_HOME/bots.json" ]]; then
    WORK_DIR=$(node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$METABOT_HOME/bots.json','utf-8'));
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

# Copy skills from ~/.claude/skills to bot working directory
if [[ -n "${SKILLS_DEST:-}" ]]; then
  for SKILL in metaskill metamemory; do
    if [[ -d "$SKILLS_DIR/$SKILL" ]]; then
      mkdir -p "$SKILLS_DEST/$SKILL"
      cp -r "$SKILLS_DIR/$SKILL/." "$SKILLS_DEST/$SKILL/"
      success "Installed $SKILL → $SKILLS_DEST/$SKILL"
    else
      warn "Skill $SKILL not found in $SKILLS_DIR, skipping"
    fi
  done
else
  warn "Could not determine working directory, skipping skill deployment to workdir"
fi

# ============================================================================
# Phase 7: MetaMemory Server (optional)
# ============================================================================
step "Phase 7: MetaMemory Server"

METAMEMORY_INSTALLED=false

if prompt_yn "Install MetaMemory server (knowledge persistence)?"; then

  METAMEMORY_HOME="${METAMEMORY_HOME:-$HOME/metamemory}"

  # 7a. Check Python 3.8+
  if command -v python3 &>/dev/null; then
    PY_VER="$(python3 --version 2>&1 | sed 's/Python //')"
    PY_MAJOR="$(echo "$PY_VER" | cut -d. -f1)"
    PY_MINOR="$(echo "$PY_VER" | cut -d. -f2)"
    if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 8 ]]; then
      success "Python found: ${PY_VER}"
    else
      error "Python ${PY_VER} found, but 3.8+ is required."
      warn "Skipping MetaMemory installation."
      METAMEMORY_INSTALLED=false
    fi
  else
    error "Python 3 not found."
    echo "  Install: https://www.python.org/downloads/ or use your package manager"
    warn "Skipping MetaMemory installation."
    METAMEMORY_INSTALLED=false
  fi

  # Only continue if Python check passed (not explicitly set to false above after check)
  if command -v python3 &>/dev/null; then
    PY_MAJOR="$(python3 -c 'import sys; print(sys.version_info.major)')"
    PY_MINOR="$(python3 -c 'import sys; print(sys.version_info.minor)')"
    if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 8 ]]; then

      # 7b. Clone or update xvirobotics/metamemory
      if [[ -d "$METAMEMORY_HOME/.git" ]]; then
        info "MetaMemory repo exists, pulling latest..."
        (cd "$METAMEMORY_HOME" && git pull --ff-only) || warn "MetaMemory pull failed, using existing"
      else
        info "Cloning MetaMemory..."
        git clone https://github.com/xvirobotics/metamemory.git "$METAMEMORY_HOME"
      fi

      # 7c. Create venv + pip install
      # The metamemory repo has its server code under server/ with its own requirements.txt
      cd "$METAMEMORY_HOME"
      if [[ ! -d "venv" ]]; then
        info "Creating Python virtual environment..."
        python3 -m venv venv
      fi
      info "Installing Python dependencies..."
      source venv/bin/activate
      if [[ -f "server/requirements.txt" ]]; then
        pip install -r server/requirements.txt -q
      elif [[ -f "requirements.txt" ]]; then
        pip install -r requirements.txt -q
      elif [[ -f "pyproject.toml" ]]; then
        pip install -e . -q
      else
        warn "No requirements.txt or pyproject.toml found, skipping pip install"
      fi
      deactivate
      success "MetaMemory dependencies installed"

      # 7d. Extract metamemory SKILL.md to ~/.claude/skills/metamemory/
      # Check common locations for the skill file in the metamemory repo
      SKILL_EXTRACTED=false
      for SKILL_PATH in skill skills/metamemory skill/metamemory; do
        if [[ -d "$METAMEMORY_HOME/$SKILL_PATH" && -f "$METAMEMORY_HOME/$SKILL_PATH/SKILL.md" ]]; then
          mkdir -p "$SKILLS_DIR/metamemory"
          cp -r "$METAMEMORY_HOME/$SKILL_PATH/." "$SKILLS_DIR/metamemory/"
          success "Extracted metamemory skill → $SKILLS_DIR/metamemory"
          SKILL_EXTRACTED=true
          break
        fi
      done
      # Fallback: check for SKILL.md at repo root
      if [[ "$SKILL_EXTRACTED" == "false" && -f "$METAMEMORY_HOME/SKILL.md" ]]; then
        mkdir -p "$SKILLS_DIR/metamemory"
        cp "$METAMEMORY_HOME/SKILL.md" "$SKILLS_DIR/metamemory/SKILL.md"
        success "Extracted metamemory skill → $SKILLS_DIR/metamemory"
        SKILL_EXTRACTED=true
      fi
      if [[ "$SKILL_EXTRACTED" == "false" ]]; then
        warn "Could not find SKILL.md in metamemory repo"
      fi

      # Also copy to bot working directory if available
      if [[ -n "${SKILLS_DEST:-}" && -d "$SKILLS_DIR/metamemory" ]]; then
        mkdir -p "$SKILLS_DEST/metamemory"
        cp -r "$SKILLS_DIR/metamemory/." "$SKILLS_DEST/metamemory/"
        success "Deployed metamemory skill → $SKILLS_DEST/metamemory"
      fi

      # 7e. Start MetaMemory via PM2
      # The metamemory repo structure: server/app/main.py → uvicorn app.main:app --cwd server/
      METAMEMORY_ENTRY=""
      METAMEMORY_CWD="$METAMEMORY_HOME"
      if [[ -f "$METAMEMORY_HOME/server/app/main.py" ]]; then
        METAMEMORY_ENTRY="app.main:app"
        METAMEMORY_CWD="$METAMEMORY_HOME/server"
      elif [[ -f "$METAMEMORY_HOME/main.py" ]]; then
        METAMEMORY_ENTRY="main:app"
      elif [[ -f "$METAMEMORY_HOME/app.py" ]]; then
        METAMEMORY_ENTRY="app:app"
      elif [[ -f "$METAMEMORY_HOME/server.py" ]]; then
        METAMEMORY_ENTRY="server:app"
      fi

      if [[ -n "$METAMEMORY_ENTRY" ]]; then
        if pm2 describe metamemory &>/dev/null 2>&1; then
          info "MetaMemory already in PM2, restarting..."
          pm2 restart metamemory
        else
          info "Starting MetaMemory with PM2..."
          pm2 start "$METAMEMORY_HOME/venv/bin/python" \
            --name metamemory \
            --cwd "$METAMEMORY_CWD" \
            -- -m uvicorn "$METAMEMORY_ENTRY" --host 0.0.0.0 --port 8100
        fi

        # 7f. Health check
        sleep 3
        if curl -sf http://localhost:8100/api/health &>/dev/null || curl -sf http://localhost:8100/health &>/dev/null; then
          success "MetaMemory server is running on port 8100"
          METAMEMORY_INSTALLED=true
        else
          warn "MetaMemory started but health check failed. Check: pm2 logs metamemory"
          METAMEMORY_INSTALLED=true
        fi
      else
        warn "Could not detect MetaMemory entry point"
        warn "You may need to start MetaMemory manually."
        METAMEMORY_INSTALLED=true
      fi

    fi
  fi

else
  info "Skipping MetaMemory installation"
fi

# ============================================================================
# Phase 8: Build + Start MetaBot with PM2
# ============================================================================
step "Phase 8: Starting MetaBot"

cd "$METABOT_HOME"

info "Building TypeScript..."
npm run build 2>/dev/null && success "Build complete" || warn "Build failed, will use tsx directly via PM2"

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
echo "  ║       MetaBot Genesis — Ready!           ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo -e "  ${BOLD}Installation:${NC}   ${METABOT_HOME}"
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Working Dir:${NC}    ${WORK_DIR}"
  echo -e "  ${BOLD}API:${NC}            http://localhost:${API_PORT}"
  echo -e "  ${BOLD}API Secret:${NC}     ${API_SECRET:0:8}...${API_SECRET: -4}"
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
  echo "    pm2 logs metamemory       # View MetaMemory logs"
  echo "    pm2 restart metamemory    # Restart MetaMemory"
fi
echo ""
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Next Steps:${NC}"
  STEP_NUM=1
  if [[ "${CLAUDE_AUTH_METHOD}" == "subscription" ]]; then
    echo "    ${STEP_NUM}. Run 'claude login' in a separate terminal"
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
  echo "    ${STEP_NUM}. Check logs: pm2 logs metabot"
fi
echo ""
