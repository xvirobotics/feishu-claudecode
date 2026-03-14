# 生产部署

## 快速启动

```bash
metabot start                       # 用 PM2 启动
metabot update                      # 拉取 + 构建 + 重启
```

## PM2 开机自启

```bash
pm2 startup && pm2 save
```

注册为系统服务，开机自动启动。

## 手动 PM2 命令

```bash
pm2 start ecosystem.config.cjs      # 启动
pm2 restart metabot                  # 重启
pm2 stop metabot                     # 停止
pm2 logs metabot                     # 查看日志
pm2 status                           # 进程状态
```

## 生产构建

```bash
npm run build                        # TypeScript 编译到 dist/
npm start                            # 运行编译后的 dist/index.js
```

## 不需要公网 IP

- **飞书** 使用 WebSocket（长连接）— 不需要入站端口
- **Telegram** 使用长轮询 — 不需要入站端口

唯一需要可访问的端口是 API 端口（默认 `9100`），用于远程 CLI 访问或 Peers 联邦。

## 远程 CLI 访问

配置 CLI 工具连接远程 MetaBot 实例：

```bash
# 在 ~/.metabot/.env 中
METABOT_URL=http://your-server:9100
META_MEMORY_URL=http://your-server:8100
API_SECRET=your-secret
```

这样 `mb` 和 `mm` 命令可以从任何机器使用。

## HTTPS（Caddy 反向代理）

移动端浏览器的 Web UI 电话语音模式需要 HTTPS（麦克风需要安全上下文）。推荐 [Caddy](https://caddyserver.com/) 做反向代理 — 自动管理 Let's Encrypt 证书。

```bash
# 安装 Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy

# 配置（替换为你的域名）
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
metabot.yourdomain.com {
    reverse_proxy localhost:9100
}
EOF
sudo systemctl restart caddy
```

**前提条件：**

- 域名 A 记录指向服务器公网 IP
- 开放 80 和 443 端口用于 Let's Encrypt 验证

Caddy 自动获取和续期证书。WebSocket 连接（`/ws`）透明代理，无需额外配置。

详细设置步骤见 [Web UI 文档](../features/web-ui.md#https)。
