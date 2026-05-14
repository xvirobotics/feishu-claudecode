# HTTPS Setup

← back to [CLAUDE.md](../../CLAUDE.md)

(Required for Web Voice Mode)

The Web UI's phone call mode requires HTTPS for microphone access (`getUserMedia`). The recommended approach is [Caddy](https://caddyserver.com/) as a reverse proxy — it handles Let's Encrypt certificates automatically.

## Step 1: Install Caddy

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy
```

## Step 2: Configure DNS

Add an A record for your domain (e.g. `metabot.xvirobotics.com`) pointing to your server's public IP. Wait for DNS propagation (check with `host <domain> 1.1.1.1`).

## Step 3: Configure Caddy

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
metabot.yourdomain.com {
    reverse_proxy localhost:9100
}
EOF
sudo systemctl restart caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates. Ports 80 and 443 must be open. Check status with `sudo journalctl -u caddy` — look for "certificate obtained successfully".

## Step 4: Access

Open `https://metabot.yourdomain.com/web/` in a browser. The phone call button in Chat now has microphone access.

**Note**: WebSocket connections (`/ws`) are automatically proxied by Caddy. No additional WebSocket configuration is needed.
