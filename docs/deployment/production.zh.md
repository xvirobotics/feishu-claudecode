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
