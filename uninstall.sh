#!/usr/bin/env bash
# MetaBot Uninstaller
# Usage: bash uninstall.sh
#   or:  curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/uninstall.sh | bash
set -euo pipefail

# ============================================================================
# TTY handling (for curl | bash mode)
# ============================================================================
if [[ ! -t 0 ]] && [[ -e /dev/tty ]]; then
  TTY=/dev/tty
else
  TTY=/dev/stdin
fi

# ============================================================================
# Configuration
# ============================================================================
METABOT_HOME="${METABOT_HOME:-$HOME/metabot}"
LOCAL_BIN="$HOME/.local/bin"
SKILLS_DIR="$HOME/.claude/skills"
BASH_ALIASES="$HOME/.bash_aliases"

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

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}==> $*${NC}"; }

prompt_yn() {
  local prompt_text="$1"
  local default="${2:-n}"
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
# Banner
# ============================================================================
echo ""
echo -e "${RED}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║           MetaBot Uninstaller            ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

echo -e "  This will remove MetaBot from: ${BOLD}${METABOT_HOME}${NC}"
echo ""
if ! prompt_yn "Are you sure you want to uninstall MetaBot?"; then
  info "Uninstall cancelled."
  exit 0
fi

# ============================================================================
# Phase 1: Stop PM2 processes
# ============================================================================
step "Phase 1: Stopping MetaBot services"

if command -v pm2 &>/dev/null; then
  if pm2 describe metabot &>/dev/null 2>&1; then
    info "Stopping MetaBot PM2 process..."
    pm2 delete metabot 2>/dev/null || true
    success "MetaBot PM2 process removed"
  else
    info "No MetaBot PM2 process found"
  fi
  if pm2 describe metamemory &>/dev/null 2>&1; then
    info "Stopping MetaMemory PM2 process..."
    pm2 delete metamemory 2>/dev/null || true
    success "MetaMemory PM2 process removed"
  fi
  pm2 save --force 2>/dev/null || true
else
  info "PM2 not installed, skipping"
fi

# Kill any process on MetaBot port (default 9100)
if command -v lsof &>/dev/null; then
  for port in 9100 8100; do
    PID=$(lsof -ti :"$port" 2>/dev/null || true)
    if [[ -n "$PID" ]]; then
      info "Killing process on port $port (PID: $PID)..."
      kill "$PID" 2>/dev/null || true
    fi
  done
fi

# ============================================================================
# Phase 2: Remove CLI tools from ~/.local/bin
# ============================================================================
step "Phase 2: Removing CLI tools"

for cli in mm mb metabot fd; do
  if [[ -f "$LOCAL_BIN/$cli" ]]; then
    rm -f "$LOCAL_BIN/$cli"
    success "Removed $LOCAL_BIN/$cli"
  fi
done

# ============================================================================
# Phase 3: Remove shell shortcuts from ~/.bash_aliases
# ============================================================================
step "Phase 3: Removing shell shortcuts"

if [[ -f "$BASH_ALIASES" ]]; then
  CLEANED=false

  # Remove mm() block (from "# MetaMemory shortcuts" to closing "}")
  if grep -q 'mm()' "$BASH_ALIASES" 2>/dev/null; then
    # Use awk to remove the mm() block
    awk '
      /^# MetaMemory shortcuts/ { skip=1; next }
      skip && /^[^ \t]/ && !/^(export MEMORY|mm\(\))/ { skip=0 }
      skip { next }
      { print }
    ' "$BASH_ALIASES" > "$BASH_ALIASES.tmp" && mv "$BASH_ALIASES.tmp" "$BASH_ALIASES"
    CLEANED=true
    success "Removed mm() shortcut from ~/.bash_aliases"
  fi

  # Remove mb() block (from "# MetaBot API shortcuts" to closing "}")
  if grep -q 'mb()' "$BASH_ALIASES" 2>/dev/null; then
    awk '
      /^# MetaBot API shortcuts/ { skip=1; next }
      skip && /^[^ \t]/ && !/^(export METABOT|mb\(\))/ { skip=0 }
      skip { next }
      { print }
    ' "$BASH_ALIASES" > "$BASH_ALIASES.tmp" && mv "$BASH_ALIASES.tmp" "$BASH_ALIASES"
    CLEANED=true
    success "Removed mb() shortcut from ~/.bash_aliases"
  fi

  if [[ "$CLEANED" == "false" ]]; then
    info "No MetaBot shortcuts found in ~/.bash_aliases"
  fi

  # Remove empty file if nothing left
  if [[ -f "$BASH_ALIASES" ]] && [[ ! -s "$BASH_ALIASES" ]]; then
    rm -f "$BASH_ALIASES"
    info "Removed empty ~/.bash_aliases"
  fi
else
  info "~/.bash_aliases not found, skipping"
fi

# ============================================================================
# Phase 4: Remove skills from ~/.claude/skills
# ============================================================================
step "Phase 4: Removing Claude skills"

for skill in metaskill metamemory metabot feishu-doc; do
  if [[ -d "$SKILLS_DIR/$skill" ]]; then
    rm -rf "$SKILLS_DIR/$skill"
    success "Removed skill: $skill"
  fi
done

# Clean up old skill locations
if [[ -d "$HOME/.claude/skills/memory" ]]; then
  rm -rf "$HOME/.claude/skills/memory"
  success "Removed legacy skill: memory"
fi

# ============================================================================
# Phase 5: Remove MetaBot directory
# ============================================================================
step "Phase 5: Removing MetaBot installation"

if [[ -d "$METABOT_HOME" ]]; then
  # Check for data that might be worth keeping
  HAS_DATA=false
  if [[ -f "$METABOT_HOME/data/metamemory.db" ]]; then
    HAS_DATA=true
  fi

  if [[ "$HAS_DATA" == "true" ]]; then
    echo ""
    warn "MetaMemory database found at $METABOT_HOME/data/metamemory.db"
    if prompt_yn "Back up MetaMemory data to ~/metabot-backup/ before deleting?"; then
      BACKUP_DIR="$HOME/metabot-backup"
      mkdir -p "$BACKUP_DIR"
      cp -r "$METABOT_HOME/data" "$BACKUP_DIR/" 2>/dev/null || true
      [[ -f "$METABOT_HOME/.env" ]] && cp "$METABOT_HOME/.env" "$BACKUP_DIR/" 2>/dev/null || true
      [[ -f "$METABOT_HOME/bots.json" ]] && cp "$METABOT_HOME/bots.json" "$BACKUP_DIR/" 2>/dev/null || true
      success "Backed up data to $BACKUP_DIR"
    fi
  fi

  rm -rf "$METABOT_HOME"
  success "Removed $METABOT_HOME"
else
  info "MetaBot directory not found at $METABOT_HOME"
fi

# ============================================================================
# Phase 6: Remove workspace deployments (optional)
# ============================================================================
step "Phase 6: Cleanup workspace deployments"

# Check common workspace locations for deployed skills/CLAUDE.md
WORKSPACE_DIRS=()
# Try to find from backup or known locations
for dir in "$HOME/metabot-workspace" "$HOME/workspace" "$HOME/projects"; do
  if [[ -d "$dir/.claude/skills/metabot" ]] || [[ -d "$dir/.claude/skills/metamemory" ]]; then
    WORKSPACE_DIRS+=("$dir")
  fi
done

if [[ ${#WORKSPACE_DIRS[@]} -gt 0 ]]; then
  for ws in "${WORKSPACE_DIRS[@]}"; do
    echo ""
    info "Found deployed MetaBot skills in: $ws"
    if prompt_yn "Remove deployed skills from $ws?"; then
      for skill in metaskill metamemory metabot feishu-doc; do
        rm -rf "$ws/.claude/skills/$skill" 2>/dev/null || true
      done
      success "Removed deployed skills from $ws"
    fi
  done
else
  info "No workspace deployments found"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║        MetaBot — Uninstalled             ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo -e "  ${BOLD}Removed:${NC}"
echo "    - PM2 processes (metabot, metamemory)"
echo "    - CLI tools (mm, mb, metabot, fd)"
echo "    - Shell shortcuts from ~/.bash_aliases"
echo "    - Claude skills (metaskill, metamemory, metabot, feishu-doc)"
echo "    - MetaBot directory ($METABOT_HOME)"
if [[ -d "$HOME/metabot-backup" ]]; then
  echo ""
  echo -e "  ${BOLD}Backup:${NC} ~/metabot-backup/"
fi
echo ""
echo -e "  ${BOLD}Not removed (manual cleanup if needed):${NC}"
echo "    - PM2 global package (npm uninstall -g pm2)"
echo "    - Claude CLI (npm uninstall -g @anthropic-ai/claude-code)"
echo "    - Node.js"
echo ""
