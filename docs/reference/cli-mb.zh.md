# mb CLI（Agent 总线）

`mb` 命令提供终端访问 MetaBot Agent 总线 API。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/mb`。

## 命令

### Bot 管理

```bash
mb bots                             # 列出所有 Bot（本地 + peer）
mb bot <name>                       # 获取 Bot 详情
```

### Agent 对话

```bash
mb talk <bot> <chatId> <prompt>     # 与 Bot 对话
mb talk alice/bot <chatId> <prompt> # 指定 peer 的 Bot 对话
```

Bot 名称支持[限定名](../features/peers.md#限定名)（`peerName/botName`）实现跨实例路由。

### Peers

```bash
mb peers                            # 列出 peer 及状态
```

### 定时任务

```bash
mb schedule list                                              # 列出全部
mb schedule cron <bot> <chatId> '<cron>' <prompt>            # 创建周期性任务
mb schedule add <bot> <chatId> <delayMs> <prompt>            # 创建一次性任务
mb schedule pause <id>                                        # 暂停
mb schedule resume <id>                                       # 恢复
mb schedule cancel <id>                                       # 取消
```

### 统计与健康

```bash
mb stats                            # 费用与使用统计
mb health                           # 健康检查
```

### 管理

```bash
mb update                           # 拉取 + 构建 + 重启
mb help                             # 显示帮助
```

## 远程访问

默认连接 `http://localhost:9100`。配置远程访问：

```bash
# 在 ~/.metabot/.env 或 ~/metabot/.env 中
METABOT_URL=http://your-server:9100
API_SECRET=your-secret
```
