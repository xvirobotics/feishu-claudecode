# 快速配置

## Telegram（30 秒）

1. 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 复制 token
2. 写入 `bots.json` → 完成（长轮询，无需 Webhook）

```json
{
  "telegramBots": [{
    "name": "my-tg-bot",
    "telegramBotToken": "123456:ABC...",
    "defaultWorkingDirectory": "/home/user/project"
  }]
}
```

## 飞书（4 步）

1. 在 [open.feishu.cn](https://open.feishu.cn/) 创建应用 → 添加「机器人」能力
2. 开通权限：`im:message`、`im:message:readonly`、`im:resource`、`im:chat:readonly`（群聊检测）、`docx:document:readonly`、`wiki:wiki`（文档阅读和知识库同步）
3. 先启动 MetaBot，再开启「长连接」+ `im.message.receive_v1` 事件
4. 发布应用

```json
{
  "feishuBots": [{
    "name": "metabot",
    "feishuAppId": "cli_xxx",
    "feishuAppSecret": "...",
    "defaultWorkingDirectory": "/home/user/project"
  }]
}
```

!!! tip "不需要公网 IP"
    飞书使用 WebSocket（长连接），Telegram 使用长轮询。都不需要公网 IP，可以在 NAT/防火墙后运行。

详细飞书配置请参见[飞书应用配置指南](feishu-app-setup.md)。
