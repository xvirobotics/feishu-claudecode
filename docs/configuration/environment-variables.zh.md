# 环境变量

所有配置通过 `.env` 文件或系统环境变量。复制 `.env.example` 到 `.env` 开始使用。

## MetaBot 核心

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTS_CONFIG` | — | `bots.json` 路径（多 Bot 模式） |
| `FEISHU_APP_ID` | — | 飞书 App ID（单 Bot 模式） |
| `FEISHU_APP_SECRET` | — | 飞书 App Secret（单 Bot 模式） |
| `API_PORT` | `9100` | HTTP API 端口 |
| `API_SECRET` | — | Bearer Token 认证 |
| `LOG_LEVEL` | `info` | 日志级别（debug, info, warn, error） |

## Claude Code

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEFAULT_WORKING_DIRECTORY` | — | Claude 工作目录（单 Bot 模式） |
| `CLAUDE_MAX_TURNS` | 不限 | 每次请求最大轮次 |
| `CLAUDE_MAX_BUDGET_USD` | 不限 | 每次请求费用上限（美元） |
| `CLAUDE_MODEL` | SDK 默认 | Claude 模型 |
| `CLAUDE_EXECUTABLE_PATH` | 自动检测 | `claude` 二进制路径 |

## MetaMemory

| 变量 | 默认 | 说明 |
|------|------|------|
| `MEMORY_ENABLED` | `true` | 启用内嵌 MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory 端口 |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory 认证（旧版） |
| `MEMORY_ADMIN_TOKEN` | — | 管理员 Token（完整访问） |
| `MEMORY_TOKEN` | — | 读者 Token（仅 shared 文件夹） |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 地址（CLI 远程访问） |

## 飞书服务应用

| 变量 | 默认 | 说明 |
|------|------|------|
| `FEISHU_SERVICE_APP_ID` | — | 专用于知识库同步和文档阅读的飞书应用 |
| `FEISHU_SERVICE_APP_SECRET` | — | 服务应用密钥 |

未设置时回退到第一个飞书 Bot 的凭证。

## Wiki 同步

| 变量 | 默认 | 说明 |
|------|------|------|
| `WIKI_SYNC_ENABLED` | `true` | 启用 MetaMemory → 知识库同步 |
| `WIKI_SPACE_ID` | — | 飞书知识库空间 ID |
| `WIKI_SPACE_NAME` | `MetaMemory` | 知识库空间名称 |
| `WIKI_AUTO_SYNC` | `true` | 变更时自动同步 |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | `5000` | 防抖延迟 |
| `WIKI_SYNC_THROTTLE_MS` | `300` | API 调用间隔 |

## Peers 联邦

| 变量 | 默认 | 说明 |
|------|------|------|
| `METABOT_PEERS` | — | 逗号分隔的 peer URL |
| `METABOT_PEER_SECRETS` | — | 逗号分隔的 peer secret（位置对应） |
| `METABOT_PEER_NAMES` | 自动 | 逗号分隔的 peer 名称 |
| `METABOT_PEER_POLL_INTERVAL_MS` | `30000` | peer 拉取间隔 |

## 远程访问

| 变量 | 默认 | 说明 |
|------|------|------|
| `METABOT_URL` | `http://localhost:9100` | MetaBot API 地址（CLI 用） |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 地址（CLI 用） |

## 语音

| 变量 | 默认 | 说明 |
|------|------|------|
| `VOLCENGINE_TTS_APPID` | — | 豆包 STT + TTS（推荐） |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | 豆包 STT + TTS（推荐） |
| `VOLCENGINE_TTS_RESOURCE_ID` | `volc.service_type.10029` | 豆包 TTS 资源 ID |
| `OPENAI_API_KEY` | — | Whisper STT + OpenAI TTS 备选 |
| `ELEVENLABS_API_KEY` | — | ElevenLabs TTS |
| `VOICE_MODEL` | — | 语音模式使用的 Claude 模型（可选覆盖） |

## 第三方 AI 服务商

支持任何 Anthropic 兼容 API：

```bash
# Kimi/月之暗面
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=你的key

# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=你的key

# GLM/智谱
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=你的key
```
