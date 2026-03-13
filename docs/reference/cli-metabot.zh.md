# metabot CLI

`metabot` 命令管理 MetaBot 服务生命周期。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/metabot`。

## 命令

```bash
metabot update                      # 拉取最新代码，重新构建，重启
metabot start                       # 启动（PM2）
metabot stop                        # 停止
metabot restart                     # 重启
metabot logs                        # 查看实时日志
metabot status                      # PM2 进程状态
```

## 更新

`metabot update` 是推荐的更新方式。它依次执行：

1. `git pull` — 拉取最新代码
2. `npm install && npm run build` — 重新构建
3. `pm2 restart` — 重启服务

一条命令搞定。
