# metabot CLI

`metabot` 命令管理 MetaBot 服务生命周期。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/metabot`。

## 命令

```bash
metabot update                      # 拉取最新代码，重新构建，更新 skills，重启
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
3. 复制 MetaBot 内置 skills 到 Claude/Codex skill 目录
4. 如果本机已安装 `lark-cli` 或 lark skills，自动更新 `@larksuite/cli` 并刷新 lark AI Agent skills
5. 同步 skills 到已配置的 bot 工作目录
6. `pm2 restart` — 重启服务

一条命令搞定。
