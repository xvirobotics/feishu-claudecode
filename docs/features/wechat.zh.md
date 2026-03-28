# 微信接入

MetaBot 支持通过微信 ClawBot 插件（iLink Bot API）接入个人微信，让你直接在微信里与 Claude Code Agent 对话。

!!! info "灰测阶段"
    微信 ClawBot 目前处于灰度测试阶段，需要 iPhone 微信 8.0.70+ 版本。Android 支持即将推出。

## 前提条件

- **iPhone 微信 8.0.70+**
- 灰度资格：微信 → 我 → 设置 → 插件，能看到 **ClawBot** 入口
- MetaBot 已安装并可运行

!!! tip "没看到 ClawBot？"
    更新微信到最新版本（8.0.70+），从后台杀掉微信进程后重启，可能就能看到了。灰度正在逐步放量。

## 配置步骤

### 方式一：安装器（推荐）

运行安装器，IM 平台选择 `3) WeChat ClawBot`：

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

安装器会自动：

1. 生成 `bots.json` 中的 `wechatBots` 配置
2. 启动 MetaBot 后等待 QR 登录
3. **直接在终端显示 QR 登录链接** — 打开链接扫码即可绑定

```
  ╔══════════════════════════════════════════════╗
  ║  WeChat ClawBot — Scan QR Code to bind      ║
  ╚══════════════════════════════════════════════╝

  https://ilinkai.weixin.qq.com/...

  Open the URL above in your browser, then scan the QR code with WeChat.
```

也支持与飞书/Telegram 同时使用：选择 `5) Feishu + WeChat` 或 `6) All`。

### 方式二：手动配置

#### 1. 添加微信 Bot 配置

在 `bots.json` 中添加 `wechatBots` 配置段：

```json
{
  "wechatBots": [
    {
      "name": "wechat-assistant",
      "description": "微信 AI 助手",
      "defaultWorkingDirectory": "/home/user/project"
    }
  ]
}
```

或者与飞书/Telegram Bot 并存：

```json
{
  "feishuBots": [...],
  "telegramBots": [...],
  "wechatBots": [
    {
      "name": "wechat-bot",
      "defaultWorkingDirectory": "/home/user/project",
      "maxTurns": 50,
      "maxBudgetUsd": 1.0
    }
  ]
}
```

#### 2. 启动 MetaBot

```bash
npm run dev
```

首次启动时，终端会打印 QR 码 URL：

```
=== WeChat QR Login ===
Open this URL or scan the QR code: https://...
Waiting for scan...
```

#### 3. 扫码绑定

用微信扫描 QR 码，在手机上确认授权。确认后：

- Bot token 自动保存到 `data/wechat-tokens.json`
- 下次重启自动恢复，无需重新扫码
- 终端显示 `WeChat bot is running (long polling)`

### 开始对话

在微信中给 ClawBot 发消息，MetaBot 会自动处理并回复。

## 配置字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | — | Bot 标识名 |
| `description` | 否 | — | Bot 描述 |
| `defaultWorkingDirectory` | 是 | — | Claude 的工作目录 |
| `wechatBotToken` | 否 | — | 预认证的 iLink token（可选，不填则 QR 登录） |
| `ilinkBaseUrl` | 否 | `https://ilinkai.weixin.qq.com` | iLink API 地址 |
| `maxTurns` | 否 | 不限 | 最大对话轮次 |
| `maxBudgetUsd` | 否 | 不限 | 单次最大花费 |
| `model` | 否 | SDK 默认 | Claude 模型 |

## 环境变量模式

如果只需要一个微信 Bot，可以用环境变量代替 `bots.json`：

```bash
WECHAT_ILINK_ENABLED=true
CLAUDE_DEFAULT_WORKING_DIRECTORY=/home/user/project
```

## 消息支持

| 消息类型 | 接收 | 发送 | 说明 |
|----------|------|------|------|
| 文本 | ✅ | ✅ | 长文本自动分段（4000字限制） |
| 图片 | ✅ | ✅ | 通过 CDN 加密传输 |
| 语音 | ✅ | — | 优先使用语音转文字 |
| 文件 | ✅ | ✅ | 通过 CDN 加密传输 |
| 视频 | ✅ | — | 作为文件处理 |

## 与飞书/Telegram 的区别

| 特性 | 飞书 | Telegram | 微信 |
|------|------|----------|------|
| 连接方式 | WebSocket | 长轮询 | 长轮询 (35s) |
| 消息编辑 | ✅ 流式卡片 | ✅ 编辑消息 | ❌ 不支持 |
| 进度展示 | 实时更新卡片 | 实时编辑消息 | 工具进度消息 + 最终结果 |
| 群聊 | ✅ | ✅ | ❌ 仅私聊 |
| 公网 IP | 不需要 | 不需要 | 不需要 |

!!! note "消息更新方式"
    微信不支持编辑已发送的消息。MetaBot 处理请求时会每隔 5 秒发送工具调用进度（如 `🔧 运行中... ✓ Read file.ts`），完成后发送最终结果作为新消息。

## Token 管理

- Token 保存在 `data/wechat-tokens.json`
- Token 过期后需要重新扫码（删除 token 文件后重启即可）
- 支持多个微信 Bot，每个独立 token

## 故障排除

**Q: 扫码后没反应？**

确保微信已开启 ClawBot 插件，且在灰度范围内。

**Q: Token 过期了？**

删除 `data/wechat-tokens.json` 中对应的条目，重启 MetaBot 重新扫码。

**Q: 消息发不出去？**

检查 `context_token` 是否有效。微信要求用户先发消息，Bot 才能回复（不支持主动发消息）。

**Q: 连接不稳定？**

iLink 长轮询超时为 35 秒，网络中断后会自动重连（指数退避，最大 60 秒）。
