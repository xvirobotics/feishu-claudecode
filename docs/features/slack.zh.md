# Slack

MetaBot 可以通过 Slack Events API 接收 DM 和 @mention 事件，再用 Slack Web
API 回复，并复用和其他渠道一致的 Bridge 流水线。

## Slack App 配置

1. 在 Slack workspace 中创建一个 Slack app。
2. 添加 Bot Token Scopes：
   - `chat:write`
   - `files:read`
   - `files:write`
   - `app_mentions:read`
   - `im:history`
   - 如果需要频道 @ 路由，再添加 `channels:history` 或对应私有频道权限
3. 安装 app，复制 Bot Token（`xoxb-...`）。
4. 复制 app 的 Signing Secret。
5. 在 Event Subscriptions 中把 Request URL 配为：

   ```text
   https://<your-bridge-host>/api/slack/events/<botName>
   ```

6. 订阅 Bot Events：
   - `app_mention`
   - `message.im`
   - 需要频道 @ 路由时再订阅 `message.channels` / `message.groups`

## bots.json

```json
{
  "slackBots": [
    {
      "name": "codex-slack",
      "engine": "codex",
      "slackBotToken": "xoxb-...",
      "slackSigningSecret": "...",
      "defaultWorkingDirectory": "/home/me/project"
    }
  ]
}
```

可选字段：

- `slackBotUserId`：Bot 用户 ID（`U...`）。省略时 MetaBot 会在启动时调用
  Slack `auth.test` 获取。
- `groupNoMention`：设为 `true` 后频道内所有消息都路由给 Bot。更安全的默认
  行为是仅响应 @mention。

## 单 Bot 环境变量模式

```bash
METABOT_ENGINE=codex
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/me/project
```

如果启动环境不能访问 Slack `auth.test`，可以显式设置
`SLACK_BOT_USER_ID=U...`。

## 安全说明

Slack 事件投递是公网 HTTP，因此 Bridge 会校验 `X-Slack-Signature` 并拒绝过期
timestamp。除非 Bridge 放在你自己的 HTTPS 反向代理后，否则保持 `API_HOST`
为 loopback；只暴露你明确转发的 Slack event 路径。
