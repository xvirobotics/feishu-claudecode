# 环境变量

每个 Bot 的引擎、工作区和渠道设置放在 `bots.json`；整套部署共享的运行时设置放在
`.env`。复制 `.env.example` 后，只添加实际需要的变量。

## Core 与 Bridge

| 变量 | 默认值 | 作用 |
|---|---|---|
| `BOTS_CONFIG` | — | 多 Bot 配置路径，通常为 `./bots.json` |
| `METABOT_ENGINE` | `codex` | 单 Bot 默认引擎：`codex`、`kimi` 或兼容 `claude` |
| `API_PORT` | `9100` | 本地 Bridge API 端口 |
| `API_SECRET` | — | Bridge Bearer Secret；非健康检查 API 会拒绝匿名请求 |
| `API_HOST` / `METABOT_API_HOST` | `127.0.0.1` | Bridge 监听地址；只有放在自有私网/TLS 边界后才应使用 `0.0.0.0` |
| `METABOT_URL` | `http://localhost:9100` | Bridge CLI 命令使用的地址 |
| `METABOT_CORE_URL` | `http://localhost:9200` | Core Console 与委托 CLI 地址 |
| `METABOT_CORE_TOKEN` | Token 文件 | 覆盖 `~/.metabot-core/token` |
| `METABOT_CORE_HOST` | `127.0.0.1` | Core 监听地址 |
| `METABOT_CORE_PORT` | `9200` | Core 端口 |
| `METABOT_CORE_DATA_DIR` | `~/.metabot-core/data` | Core 数据目录 |
| `METABOT_PUBLIC_DISTRIBUTION` | `0` | 匿名提供 Core 安装/CLI 资源；仅在明确需要时开启 |
| `LOG_LEVEL` | `info` | Bridge 日志级别 |

Memory、Skills、Agents 和 T5T 都由 `METABOT_CORE_URL` 指向的 Core 提供。旧的独立
MetaMemory 变量和 `8100` 端口不属于当前个人版。

## 工作区与引擎

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CLAUDE_DEFAULT_WORKING_DIRECTORY` | — | 历史单 Bot 工作区变量，所有引擎都会使用 |
| `CODEX_MODEL` | Codex 默认 | Codex 模型 |
| `CODEX_PROFILE` | — | Codex 配置 Profile |
| `CODEX_API_KEY` | 登录状态 | OpenAI 兼容 Key，会映射到 `OPENAI_API_KEY` |
| `CODEX_BASE_URL` | Codex 默认 | OpenAI 兼容 API 地址 |
| `CODEX_APPROVAL_POLICY` | `never` | Codex 批准策略 |
| `CODEX_SANDBOX` | `workspace-write` | Codex Sandbox 模式 |
| `CODEX_REASONING_EFFORT` | — | `low`、`medium`、`high`、`xhigh`、`max` 或 `ultra` |
| `CODEX_EXECUTABLE_PATH` | 自动 | Codex 二进制路径 |
| `KIMI_CODE_SERVER_URL` | `http://127.0.0.1:58627` | 已有本地 Kimi Server；否则按需启动 |
| `KIMI_CODE_HOME` | `~/.kimi-code` | Kimi 配置和本地 Token 目录 |
| `KIMI_API_KEY` | 登录状态 | 本地 Kimi Server 继承的可选 Provider Key |
| `CLAUDE_MODEL` | Claude 默认 | 兼容引擎模型 |
| `CLAUDE_EXECUTABLE_PATH` | 自动 | Claude 兼容二进制路径 |

工作区、引擎、模型、Sandbox 和 Kimi 权限优先在每个 Bot 的 `bots.json` 中配置。
详见[多 Bot 与引擎](multi-bot.md)。

## 渠道

| 变量 | 默认值 | 作用 |
|---|---|---|
| `FEISHU_APP_ID` | — | 单 Bot 飞书/Lark App ID |
| `FEISHU_APP_SECRET` | — | 单 Bot 飞书/Lark App Secret |
| `TELEGRAM_BOT_TOKEN` | — | 单 Bot Telegram Token |
| `METABOT_FEISHU_WS_PING_TIMEOUT_SEC` | `20` | 飞书 WebSocket Pong 超时 |
| `METABOT_FEISHU_WS_HANDSHAKE_TIMEOUT_MS` | `15000` | 飞书连接/重连超时 |
| `METABOT_LOCAL_ADDRESS` | — | 飞书 Socket 可选源 IP |

多 Bot 部署应把渠道凭证放在受保护的 `bots.json`，不要在 `.env` 中重复维护。

## 可选服务

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SCHEDULE_TIMEZONE` | 系统时区 | Cron 任务使用的 IANA 时区 |
| `METABOT_PEERS` | — | 逗号分隔的 Peer URL |
| `METABOT_PEER_SECRETS` | — | 与 Peer URL 对应的 Secret |
| `METABOT_PEER_NAMES` | 自动 | Peer 显示名称 |
| `METABOT_ALLOWED_PEER_CIDRS` | — | 可选 IPv4 CIDR 转发白名单 |
| `FEISHU_SERVICE_APP_ID` | 第一个飞书 Bot | 可选 Wiki/文档读取 Service App |
| `FEISHU_SERVICE_APP_SECRET` | 第一个飞书 Bot | Service App Secret |
| `WIKI_SYNC_ENABLED` | `true` | 启用可选 Memory-to-Wiki 同步 |
| `WIKI_SPACE_ID` | — | 已有 Wiki Space ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | Wiki Space 名称 |
| `VOLCENGINE_TTS_APPID` | — | 豆包 STT/TTS App ID |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | 豆包 STT/TTS Access Key |
| `OPENAI_API_KEY` | — | 可选 Whisper/OpenAI TTS Fallback |
| `ELEVENLABS_API_KEY` | — | 可选 ElevenLabs TTS Key |

完整 Provider 与 RTC 变量仍以内联注释写在 `.env.example` 中；源码部署以它为真值。

## 代理

支持标准 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`。应在 `NO_PROXY` 中包含
`localhost` 和 `127.0.0.1`，保证 Core、Bridge 与本地 Kimi Server 流量不经过代理。

不要提交已填写的 `.env` 或 `bots.json`。
