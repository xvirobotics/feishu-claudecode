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

The only port that needs to be accessible is the API port (`9100` by default) if you want remote CLI access or Peers federation.

## Remote CLI Access

Configure CLI tools to connect to a remote MetaBot instance:

```bash
# In ~/.metabot/.env
METABOT_URL=http://your-server:9100
META_MEMORY_URL=http://your-server:8100
API_SECRET=your-secret
```

This allows `mb` and `mm` commands to work from any machine.

## HTTPS with Caddy

HTTPS is required for the Web UI's phone call voice mode on mobile browsers (microphone access needs a secure context). [Caddy](https://caddyserver.com/) is the recommended reverse proxy — it handles Let's Encrypt certificates automatically.

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
EOF
sudo systemctl restart caddy
```

**Prerequisites:**

- A domain with an A record pointing to your server's public IP
- Ports 80 and 443 open for Let's Encrypt validation

Caddy automatically obtains and renews certificates. WebSocket connections (`/ws`) are proxied transparently — no additional configuration needed.

For full setup details, see the [Web UI docs](../features/web-ui.md#https-setup).
