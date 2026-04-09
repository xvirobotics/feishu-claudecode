# Production Deployment

## Quick Start

```bash
metabot start                       # start with PM2
metabot update                      # pull + rebuild + restart
```

## PM2 Auto-Start

Enable auto-start on boot:

```bash
pm2 startup && pm2 save
```

This registers MetaBot as a system service that starts automatically after reboot.

## Manual PM2 Commands

```bash
pm2 start ecosystem.config.cjs      # start
pm2 restart metabot                  # restart
pm2 stop metabot                     # stop
pm2 logs metabot                     # view logs
pm2 status                           # process status
```

## Build for Production

```bash
npm run build                        # TypeScript compile to dist/
npm start                            # run compiled output (dist/index.js)
```

## No Public IP Required

- **Feishu** uses WebSocket (persistent connection) — no incoming port needed
- **Telegram** uses long polling — no incoming port needed

For remote CLI access or Peers federation, do not expose the raw API ports (`9100` / `8100`) directly on the public internet. Prefer HTTPS behind Caddy, or keep the services on a private network such as Tailscale or WireGuard.

## Remote CLI Access

Generate a strong API secret first:

```bash
openssl rand -hex 32
```

Then configure CLI tools to connect through your HTTPS reverse proxy for internet-reachable deployments:

```bash
# In ~/.metabot/.env
METABOT_URL=https://metabot.yourdomain.com
META_MEMORY_URL=https://memory.yourdomain.com
API_SECRET=your-secret
```

This allows `mb` and `mm` commands to work from any machine while keeping TLS termination at the proxy. If your servers are reachable only over a private network such as Tailscale or WireGuard, use those private addresses instead.

## HTTPS with Caddy

HTTPS is required for the Web UI's phone call voice mode on mobile browsers (microphone access needs a secure context), and it is also the recommended default for remote CLI access and Peers federation. [Caddy](https://caddyserver.com/) is the recommended reverse proxy — it handles Let's Encrypt certificates automatically.

```bash
# Install Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy

# Configure (replace with your domain)
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
metabot.yourdomain.com {
    reverse_proxy localhost:9100
}

memory.yourdomain.com {
    reverse_proxy localhost:8100
}
EOF
sudo systemctl restart caddy
```

**Prerequisites:**

- A domain with an A record pointing to your server's public IP
- Ports 80 and 443 open for Let's Encrypt validation

Caddy automatically obtains and renews certificates. WebSocket connections (`/ws`) are proxied transparently — no additional configuration needed. Use the same HTTPS hostnames for `METABOT_URL`, `META_MEMORY_URL`, and remote peer entries in `METABOT_PEERS`.

For full setup details, see the [Web UI docs](../features/web-ui.md#https-setup).
