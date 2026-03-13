# 故障排除

## "Error: Claude Code process exited with code 1"

Bot 启动正常，但发消息时回复此错误。

**原因：** Claude CLI 未认证。SDK 以子进程启动 `claude` — 没有有效凭证时立即以 code 1 退出。

**修复**（在**独立终端**中运行，不要在 Claude Code 内）：

```bash
# 方案 A：OAuth 登录
claude login

# 方案 B：API Key — 写入 .env
echo 'ANTHROPIC_API_KEY=sk-ant-your-key' >> /path/to/metabot/.env
```

然后重启服务：

```bash
metabot restart
# 或: pkill -f "tsx src/index.ts" && cd /path/to/metabot && npm run dev
```

!!! warning "注意"
    不能在 Claude Code 会话内运行 `claude login` 或 `claude auth status`（不支持嵌套）。务必使用独立终端。

## 服务无法连接飞书

服务启动但收不到飞书事件：

1. 确认飞书应用事件订阅模式是 **「长连接」**（WebSocket），而非 HTTP 回调
2. 保存事件订阅配置前**服务必须已在运行** — 飞书会验证 WebSocket 连接
3. 检查 `im.message.receive_v1` 事件已订阅
4. 确认应用版本已**发布并启用**

## Bot 在群聊中不回复

Bot 在群聊中仅在被 **@提及** 时响应。私聊中回复所有消息。这是设计如此。

例外：**2 人群**（1 个用户 + 1 个 Bot）视为私聊 — 无需 @提及。

## 常见问题

**需要公网 IP 吗？**
:   不需要。飞书用 WebSocket，Telegram 用长轮询。不需要入站端口。

**可以用国产模型吗？**
:   可以。支持 Kimi、DeepSeek、GLM 等 Anthropic 兼容 API。设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`。

**Agent 间通信是实时的吗？**
:   目前是同步请求-响应模式，通过 Agent 总线。Agent 通过 `mb talk` 或 `/api/talk` 互相对话。异步双向协议在规划中。
