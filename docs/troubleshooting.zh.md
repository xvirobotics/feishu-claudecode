# 故障排除

先确认运行时版本，并执行内置诊断：

```bash
node --version                 # 必须 >= 22.19
metabot status
metabot doctor
metabot health
```

## Core Console 无法打开

个人版控制台地址是 `http://localhost:9200`；`9100` 是 Bridge API，不是第二套
Web UI。

```bash
metabot status
curl -fsS http://localhost:9200/health
metabot restart
```

使用 `~/.metabot-core/token` 中的 Token。该文件应仅允许当前用户读取：

```bash
stat -c '%a %n' ~/.metabot-core/token   # 预期：600
```

不要把 Token 发到 Issue 或日志中。远程访问时，只能放在自有鉴权 HTTPS 反向代理
或私有网络之后。

## Codex 无法启动

在独立终端完成登录，然后重启 MetaBot：

```bash
codex login
codex --version
metabot restart
```

MetaBot 使用 `codex exec --json` 与 resume。通过 `metabot logs` 查看准确的 CLI
退出原因，并确认 Bot 工作区存在且可写。

## Kimi Code 无法连接

Kimi 支持要求 Kimi Code 0.27 或更新版本，并使用官方 loopback Server API：

```bash
npm install -g @moonshot-ai/kimi-code@latest
kimi login
kimi --version
metabot restart
```

旧 Python `kimi-cli --wire` 配置不兼容此适配器。Kimi Server 应保持在 loopback；
MetaBot 默认拒绝非 loopback Server URL。

如果日志出现 `unknown option '--work-dir'`、`unknown option '--wire'`，或 SDK
命令行里仍带这些参数，说明当前运行的是旧版 Kimi 适配器。请更新 MetaBot 并重启
Bridge：

```bash
metabot update
metabot restart
```

当前适配器通过本地 `/api/v1` Server API 连接 Kimi Code 0.27+，不会再走已经
移除的 `--wire --work-dir` 路径。

## 飞书/Lark 收不到消息

1. 事件订阅选择**长连接**，不要使用 HTTP 回调。
2. 保存事件订阅前先启动 MetaBot。
3. 订阅 `im.message.receive_v1`。
4. 发布并启用应用版本。
5. 确认 App ID 与 Secret 属于同一个应用。

详见[飞书应用配置](getting-started/feishu-app-setup.md)。

## 群 Bot 不回复

群聊默认使用精确 `@Bot` 路由。@正确的 Bot 后检查当前回复模式：

```text
@Bot /group-reply status
@Bot /group-reply mention
@Bot /group-reply all
```

只有群主可以切换模式。应用需要 `im:chat:readonly` 来验证群主身份；查询失败时会
保持 fail-closed，不会修改设置。

## 更新失败

Package 更新会在覆盖代码前验证 `SHA256SUMS` 和个人版 Manifest：

```bash
metabot update
metabot doctor
```

需要可复现回退时，显式安装已知版本：

```bash
metabot update --package --version 1.3.0
```

更新会保留 `.env`、`bots.json`、`data/`、`logs/`、`~/.metabot/` 和
`~/.metabot-core/`。如果 checksum 或 Manifest 不匹配，不要绕过校验；应重新从
官方 GitHub Release 获取。

## Claude Code 兼容模式

Claude 仅用于已有工作区兼容。在独立终端运行 `claude login`，并为该 Bot 选择
`"engine": "claude"`。Codex 与 Kimi Code 是个人版的主要引擎。

### Claude 兼容 Provider 返回 `529 overloaded_error`

`529 overloaded_error` 来自上游 Claude 兼容 Provider 或模型网关。MetaBot
不能把上游容量错误变成本地容量，但可以帮助确认手机端/Bridge 路径是否使用了与
独立 Claude Code 不同的 Provider 配置：

1. 通过 Bridge 路径复现一次，只复制脱敏后的错误行、时间、模型和上游
   request id（如果有）。
2. 对比 Bridge 服务环境与可正常运行的独立终端：Provider base URL、API key
   来源、模型、profile、代理变量和工作区。
3. 检查 Bot 配置中的 `claude.model`、`claude.env`、`model` 以及任何
   Provider 覆盖项。
4. 如果环境一致，把它按上游限流处理：稍后重试、切换模型/Provider 账号，或向
   Provider 申请提高配额。

不要把 API key、Bearer token 或完整环境变量贴到 GitHub Issue。

问题仍未解决时，在 GitHub Issue 中提供 MetaBot 版本、操作系统、所选引擎、
已移除敏感信息的 `metabot doctor` 输出，以及最小相关日志片段。
