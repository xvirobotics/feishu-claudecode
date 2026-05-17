#!/usr/bin/env bash
#
# MetaBot Central — one-shot installer for Ubuntu 22.04+
#
# Usage:
#   DOMAIN=central.example.com sudo bash deploy/install.sh
#
# Idempotent: safe to re-run. Will:
#   - create `central` system user
#   - install Node 20 (NodeSource) + Caddy if missing
#   - copy this repo to /opt/metabot
#   - npm install + npm run build inside /opt/metabot/central
#   - install systemd unit + Caddyfile + env file
#   - enable + start central.service and caddy
#
set -euo pipefail

DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "error: DOMAIN env var required (e.g. DOMAIN=central.example.com)" >&2
  exit 2
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "error: must run as root (try sudo)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTRAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_PARENT="/opt/metabot"
INSTALL_DIR="$INSTALL_PARENT/central"
DATA_DIR="/var/lib/central"
ETC_DIR="/etc/central"

echo "==> Ensuring system user 'central'"
if ! id -u central >/dev/null 2>&1; then
  useradd -m -s /bin/bash central
fi

echo "==> Creating directories"
mkdir -p "$INSTALL_PARENT" "$DATA_DIR" "$ETC_DIR"
chown -R central:central "$DATA_DIR"

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v2[0-9]\.'; then
  echo "==> Installing Node 20 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "==> Syncing source to $INSTALL_DIR"
rsync -a --delete --exclude='node_modules/' --exclude='dist/' --exclude='data/' \
  "$CENTRAL_DIR/" "$INSTALL_DIR/"
chown -R central:central "$INSTALL_DIR"

echo "==> Building (npm install + npm run build) as 'central'"
sudo -u central -H bash -lc "cd '$INSTALL_DIR' && npm install --omit=dev=false && npm run build"

echo "==> Writing /etc/central/env"
cat > "$ETC_DIR/env" <<EOF
CENTRAL_PORT=8200
CENTRAL_DATA_DIR=$DATA_DIR
CENTRAL_AUDIT_DIR=$DATA_DIR/audit
LOG_FORMAT=json
EOF
chmod 640 "$ETC_DIR/env"
chown root:central "$ETC_DIR/env"

echo "==> Installing systemd unit"
cp "$INSTALL_DIR/deploy/central.service" /etc/systemd/system/central.service
# Patch WorkingDirectory if needed (default in unit is /opt/metabot/central)
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|" /etc/systemd/system/central.service
systemctl daemon-reload
systemctl enable central.service

echo "==> Installing Caddyfile (DOMAIN=$DOMAIN)"
DOMAIN="$DOMAIN" envsubst < "$INSTALL_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile || \
  sed "s|{\$DOMAIN:central.example.com}|$DOMAIN|" "$INSTALL_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable caddy

echo "==> Starting central + caddy"
systemctl restart central.service
systemctl restart caddy

echo "==> Done"
echo "Health check: curl -fsS https://$DOMAIN/health"
echo "Bootstrap admin token (first run only): cat $DATA_DIR/admin-bootstrap-token.txt"
