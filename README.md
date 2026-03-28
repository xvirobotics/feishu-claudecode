# MetaBot

**构建受监督的、自我进化的 Agent 组织的基础设施。**

[![CI](https://img.shields.io/github/actions/workflow/status/xvirobotics/metabot/ci.yml?branch=main&style=flat-square)](https://github.com/xvirobotics/metabot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=flat-square)](https://github.com/xvirobotics/metabot)

[English](README_EN.md) | 中文

---

![MetaBot 架构图](resources/metabot.png)

### 效果演示

> 在飞书中设定一个每天早上9点自动搜索 AI 新闻并保存到 MetaMemory 的定时任务 — Thinking → Running → Complete，全程流式展示。

![MetaBot Demo](resources/metabot-demo.gif)

## 为什么做 MetaBot

Claude Code 是最强的 AI 编码 Agent —— 但它被锁在笔记本终端里。

MetaBot 解放了它。给每个 Agent 一个 Claude Code 大脑、持久化的共享记忆、创建新 Agent 的能力、以及通信总线。全部可以从飞书、Telegram 或微信手机端控制。

我们做 MetaBot 是为了把 [XVI Robotics](https://xvirobotics.com) 打造成一个 **Agent Native 公司** —— 一个小团队的人类，监督一个自我进化的 AI Agent 组织。这是让这一切成为可能的基础设施。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│                       MetaBot                            │
│                                                          │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────┐  │
│  │ MetaSkill│ │MetaMemory │ │IM Bridge │ │  定时任务  │  │
│  │  Agent   │ │   共享    │ │飞书+TG+微信│ │   调度器   │  │
│  │  工厂    │ │   知识库  │ │          │ │           │  │
│  └────┬─────┘ └─────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       └──────────────┴────────────┴─────────────┘        │
│                       ↕                                  │
│            Claude Code Agent SDK                         │
│         （bypassPermissions，流式输出）                    │
│                       ↕                                  │
│             HTTP API (:9100) — Agent 总线                │
│          任务委派 · Bot 管理 · 定时调度                    │
└──────────────────────────────────────────────────────────┘
```

**自我进化 Agent 组织的三大支柱：**

| 支柱 | 组件 | 作用 |
|------|------|------|
| **受监督 (Supervised)** | IM Bridge | 实时流式卡片展示每一步工具调用。人类看到 Agent 做的一切。通过飞书/Telegram/微信平台设置控制访问。 |
| **自我进化 (Self-Improving)** | MetaMemory | 共享知识库。Agent 写入学到的东西，其他 Agent 检索引用。组织每天都在变聪明，无需重新训练。 |
| **Agent 组织 (Organization)** | MetaSkill + 调度器 + Agent 总线 | 一个命令生成完整 Agent 团队。Agent 互相委派任务。定时任务自主运行。Agent 可以创建新 Agent。 |

## 核心组件

| 组件 | 说明 |
|------|------|
| **Claude Code 内核** | 每个 Bot 都是完整的 Claude Code 实例 — Read, Write, Edit, Bash, Glob, Grep, WebSearch, MCP 等。`bypassPermissions` 模式自主运行。 |
| **MetaSkill** | Agent 工厂。`/metaskill ios app` 调研最佳实践后生成完整的 `.claude/` Agent 团队（orchestrator + 专家 + reviewer）。通过 MetaMemory 实现 Agent 间共享知识。 |
| **MetaMemory** | 内嵌 SQLite 知识库，全文搜索，Web UI。Agent 跨会话读写 Markdown 文档。所有 Agent 共享。变更自动同步到飞书知识库（带防抖）。Web UI：`http://localhost:8100?token=YOUR_TOKEN`（启动日志会打印完整 URL）。 |
| **飞书 Lark CLI** | 集成飞书官方 CLI（`lark-cli`），200+ 命令覆盖文档、消息、日历、任务等 11 大业务域。19 个 AI Agent Skills 自动安装，Claude 可直接读写文档、发消息、管理日历等。 |
| **IM Bridge** | 飞书、Telegram 或微信（含手机端）与任意 Agent 对话。带颜色状态的流式卡片 + 工具调用追踪。微信通过 ClawBot 插件（iLink API）接入。 |
| **Agent 总线** | 9100 端口 REST API。Agent 通过 `mb talk` 互相对话。运行时创建/删除 Bot。以 `/metabot` skill 形式按需加载，不注入每次对话。 |
| **Peers 联邦** | 跨实例 Bot 发现和任务路由。配置 `METABOT_PEERS` 连接多个 MetaBot 实例 — 同机或远程。`mb talk alice/backend-bot` 自动路由。 |
| **定时任务调度器** | 一次性延迟和周期性 cron 任务。`0 8 * * 1-5` = 工作日早8点新闻简报。支持时区配置（默认 Asia/Shanghai）。跨重启持久化，忙时自动重试。 |
| **CLI 工具** | `metabot`、`mm`、`mb` 命令安装到 `~/.local/bin/`。`metabot update` 一键更新重启。`mm` 管理 MetaMemory，`mb` 管理 Agent 总线。飞书 Bot 额外安装 `lark-cli`。 |

## 安装

**Linux / macOS：**

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

**Windows (PowerShell)：**

```powershell
irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
```

安装器引导：工作目录 → Claude 认证 → IM 平台（飞书/Telegram/微信 ClawBot）→ PM2 自动启动。选择微信后安装器会自动显示 QR 登录链接，扫码即可绑定。飞书用户可选装 lark-cli 及 19 个 AI Agent Skills（安装时会提示）。

**随时更新** — 已安装？一条命令拉取、构建、重启：

```bash
metabot update
```

**完全卸载** — 移除 MetaBot、CLI 工具、技能和 PM2 进程：

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/uninstall.sh | bash
```

> **Windows 说明：** PowerShell 安装器自动检测 `winget`/`choco`/`scoop` 来安装 Node.js。CLI 工具（`mm`、`mb`、`metabot`、`fd`）通过 `.cmd` 包装器安装，需要 [Git for Windows](https://git-scm.com)（提供 Git Bash）。

<details>
<summary><strong>手动安装</strong></summary>

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # 编辑 Bot 配置
cp .env.example .env              # 编辑全局设置
npm run dev
```

前置条件：Node.js 20+，[Claude Code CLI](https://github.com/anthropics/claude-code) 已安装并认证。支持 Linux、macOS 和 Windows。

</details>

## 快速配置

**Telegram**（30秒）：
1. 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 复制 token
2. 写入 `bots.json` → 完成（长轮询，无需 Webhook）

**微信**（灰测中）：
1. iPhone 微信 8.0.70+ → 设置 → 插件 → 开启 **ClawBot**
2. 运行 `install.sh`，IM 平台选 `3) WeChat ClawBot` — 安装完成后自动显示 QR 链接，扫码绑定
3. 或手动：在 `bots.json` 添加 `wechatBots` → `npm run dev` → 终端扫码
4. 详见 [微信接入指南](https://xvirobotics.com/metabot/zh/features/wechat/)

**飞书**：
1. [open.feishu.cn](https://open.feishu.cn/) 创建应用 → 添加「机器人」能力
2. 开通权限：`im:message`、`im:message:readonly`、`im:resource`、`im:chat:readonly`（群聊检测）、`docx:document:readonly`、`wiki:wiki`（文档阅读和知识库同步）
3. 先启动 MetaBot，再开启「长连接」+ `im.message.receive_v1` 事件
4. 发布应用

## 飞书使用技巧

### 私聊 vs 群聊

| 场景 | @提及 | 说明 |
|------|-------|------|
| **私聊** | 不需要 | 所有消息直接发送给 Bot |
| **1对1 群聊**（你 + Bot 两人群） | 不需要 | 自动识别为类私聊，无需 @ |
| **多人群聊** | 需要 @Bot | 只有 @Bot 的消息才会触发回复 |

> **推荐**：建一个只有你和 Bot 的两人群聊。这样既不需要每次 @Bot，又能保留群聊的好处（如置顶、分类管理）。

### 发送文件和图片

**私聊 / 两人群**：直接发送文件或图片，Bot 自动处理。支持多文件批量发送（2 秒内的文件自动合并为一次请求）。

**多人群聊**：飞书限制 — 上传文件/图片时无法同时 @Bot。解决方案：**先传后 @**

1. 先在群里上传文件或图片（不用 @ 任何人）
2. 5 分钟内 @Bot 说「分析一下」或任何指令
3. Bot 自动把你之前上传的文件附上一起处理

```
[上传 report.pdf]          ← 先传文件
[上传 screenshot.png]      ← 可以传多个
@MetaBot 帮我分析这些文件   ← 再 @Bot，文件自动附上
```

### 支持的消息类型

- **文本** — 普通对话
- **图片** — 自动分析（Claude 多模态）
- **文件** — PDF、代码、文档等
- **富文本** — 飞书 Post 格式（含图文混排）
- **多文件批量** — 连续发送多个文件/图片，自动合并

## 你可以构建什么

- **个人 AI 开发者** — 手机上用飞书/Telegram/微信远程写代码，绑定你的项目
- **多 Agent 团队** — 前端 Bot、后端 Bot、运维 Bot，各自独立工作空间，通过 Agent 总线协作
- **自生长的组织** — 管理者 Bot 按需创建新 Agent，分配任务，安排后续跟进
- **自主研究流水线** — Agent 搜索、分析、将发现存入 MetaMemory、安排下一步
- **语音助手（Jarvis 模式）** — AirPods 说 "Hey Siri, Jarvis"，免手免屏语音控制任意 Agent。服务端 Whisper STT 高质量语音识别。见 [语音设置指南](docs/features/voice-jarvis.zh.md)

## 示例 Prompt

刚接触 MetaBot？以下是你可以直接在飞书/Telegram 中发送的真实 prompt，帮你解锁高级功能。

### MetaMemory — 持久化知识库

```
把我们刚讨论的部署方案写入 MetaMemory，放到 /projects/deployment 下面。
```

```
搜索一下 MetaMemory 里有没有关于 API 设计规范的文档。
```

```
总结今天 code review 的结论，保存到 MetaMemory，方便团队以后查阅。
```

### MetaSkill — Agent 与 Skill 工厂

```
/metaskill 给这个 React Native 项目创建一个 agent 团队 ——
我需要一个前端专家、一个后端 API 专家、一个 code reviewer。
```

```
/metaskill 创建一个 skill，能读取我们的 Jira 看板并汇总待办事项。
```

### 定时任务 — 自动化调度

```
设一个每天早上9点的定时任务：搜索 Hacker News 和 TechCrunch 的 AI 新闻，
总结 Top 5，保存到 MetaMemory。
```

```
30分钟后提醒我检查一下刚才的部署有没有成功。
```

```
设一个每周一早上8点的任务：review 上周的 git commit，生成进度报告，
保存到 MetaMemory 的 /reports 目录下。
```

### Agent-to-Agent — 跨 Agent 协作

```
把这个 bug 委派给 backend-bot 处理："修复 /api/users/:id 接口的空指针异常，
错误日志在 MetaMemory /logs/errors 里"。
```

```
让 frontend-bot 更新仪表盘 UI，同时让 backend-bot 加上新的 API 接口。
两边都把进度记录到 MetaMemory 的 /projects/dashboard 下。
```

### 组合工作流

```
调研 WebSocket 认证的最佳实践，写一份详细的实现方案，
然后保存到 MetaMemory 的 /architecture/websocket-auth 下面供团队评审。
```

```
读一下这个飞书文档 [粘贴链接]，提取产品需求，拆成任务，
然后设一个每天下午6点的定时任务，对照需求跟踪开发进度。
```

```
/metaskill 创建一个 "daily-ops" agent，每天早上8点自动运行：
检查服务健康状态、review 昨晚的错误日志、发一份运维摘要。
```

## 配置

**`bots.json`** — 定义你的 Bot：

```json
{
  "feishuBots": [{
    "name": "metabot",
    "feishuAppId": "cli_xxx",
    "feishuAppSecret": "...",
    "defaultWorkingDirectory": "/home/user/project"
  }],
  "telegramBots": [{
    "name": "tg-bot",
    "telegramBotToken": "123456:ABC...",
    "defaultWorkingDirectory": "/home/user/project"
  }],
  "wechatBots": [{
    "name": "wechat-bot",
    "defaultWorkingDirectory": "/home/user/project"
  }]
}
```

<details>
<summary><strong>所有 Bot 配置字段</strong></summary>

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | — | Bot 标识名 |
| `defaultWorkingDirectory` | 是 | — | Claude 的工作目录 |
| `feishuAppId` / `feishuAppSecret` | 飞书 | — | 飞书应用凭证 |
| `telegramBotToken` | Telegram | — | Telegram Bot Token |
| `wechatBotToken` | 微信(可选) | — | 预认证 iLink token（不填则 QR 登录） |
| `maxTurns` / `maxBudgetUsd` | 否 | 不限 | 执行限制 |
| `model` | 否 | SDK 默认 | Claude 模型 |
| `apiKey` | 否 | — | 显式 Anthropic API Key（不设则从 `~/.claude/.credentials.json` 动态读取，兼容 cc-switch） |

</details>

<details>
<summary><strong>环境变量 (.env)</strong></summary>

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTS_CONFIG` | — | bots.json 路径 |
| `API_PORT` | 9100 | HTTP API 端口 |
| `API_SECRET` | — | Bearer 认证 |
| `MEMORY_ENABLED` | true | 启用 MetaMemory |
| `MEMORY_PORT` | 8100 | MetaMemory 端口 |
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory 认证（旧版） |
| `MEMORY_ADMIN_TOKEN` | — | 管理员 Token（完整访问，可见所有文件夹） |
| `MEMORY_TOKEN` | — | 读者 Token（仅可见 shared 文件夹） |
| `FEISHU_SERVICE_APP_ID` | — | 飞书服务应用（用于知识库同步和文档读取，未设置时回退到第一个 Bot） |
| `FEISHU_SERVICE_APP_SECRET` | — | 飞书服务应用密钥 |
| `WIKI_SYNC_ENABLED` | true | 启用 MetaMemory→飞书知识库同步 |
| `WIKI_SPACE_ID` | — | 飞书知识库空间 ID |
| `WIKI_SPACE_NAME` | MetaMemory | 飞书知识库空间名称 |
| `WIKI_AUTO_SYNC` | true | MetaMemory 变更时自动同步（带防抖） |
| `WIKI_AUTO_SYNC_DEBOUNCE_MS` | 5000 | 自动同步防抖延迟 |
| `CLAUDE_EXECUTABLE_PATH` | 自动检测 | `claude` 二进制路径（未设置时通过 `which` 解析） |
| `METABOT_URL` | `http://localhost:9100` | MetaBot API 地址（CLI 远程访问） |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 服务地址（CLI 远程访问） |
| `METABOT_PEERS` | — | 逗号分隔的 Peer MetaBot 地址，用于跨实例发现 |
| `METABOT_PEER_SECRETS` | — | 逗号分隔的 Peer Secret（与 PEERS 位置对应） |
| `METABOT_PEER_NAMES` | 自动 | 逗号分隔的 Peer 名称 |
| `LOG_LEVEL` | info | 日志级别 |

</details>

<details>
<summary><strong>第三方 AI 服务商</strong></summary>

支持任何 Anthropic 兼容 API：

```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic    # Kimi/月之暗面
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   # DeepSeek
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic       # GLM/智谱
ANTHROPIC_AUTH_TOKEN=你的key
```

</details>

<details>
<summary><strong>cc-switch 兼容</strong></summary>

MetaBot 兼容 [cc-switch](https://github.com/farion1231/cc-switch)、[cc-switch-cli](https://github.com/SaladDay/cc-switch-cli)、[CCS](https://github.com/kaitranntt/ccs) 等认证切换工具。

MetaBot 不会从 PM2 进程环境继承 `ANTHROPIC_API_KEY`，而是让每个 Claude Code 子进程从 `~/.claude/.credentials.json` 动态读取认证。因此用 `cc switch` 切换 API/订阅模式后，MetaBot **无需重启**即可生效。

如需固定使用某个 API Key，在 `bots.json` 中设置 `apiKey` 字段：

```json
{
  "feishuBots": [{
    "name": "metabot",
    "apiKey": "sk-ant-api03-...",
    "..."
  }]
}
```

</details>

## 安全

MetaBot 以 `bypassPermissions` 模式运行 Claude Code — 无交互式确认：

- Claude 对工作目录有完整读写执行权限
- 通过飞书/Telegram/微信平台设置控制访问（应用可见范围、群成员管理）
- 用 `maxBudgetUsd` 限制单次花费
- `API_SECRET` 同时保护 API 服务器和 MetaMemory
- MetaMemory Web UI 需要 Token：浏览器打开 `http://localhost:8100?token=YOUR_TOKEN`。启动日志会打印带 Token 的完整 URL。Token 会保存到 `localStorage`，只需传递一次
- MetaMemory 支持**文件夹级 ACL**：设置 `MEMORY_ADMIN_TOKEN` 和 `MEMORY_TOKEN` 实现双角色访问。Admin 可见所有文件夹；Reader 仅可见 `visibility: shared` 的文件夹

## 聊天命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除会话 |
| `/stop` | 中止当前任务 |
| `/status` | 查看会话状态 |
| `/memory list` | 浏览知识库目录 |
| `/memory search 关键词` | 搜索知识库 |
| `/sync` | 同步 MetaMemory 到飞书知识库 |
| `/sync status` | 查看同步状态 |
| `/help` | 帮助 |
| `/metaskill ...` | 生成 Agent 团队、Agent 或 Skill |
| `/metabot` | Agent 总线、定时任务、Bot 管理 API 文档（按需加载） |
| `/任意命令` | 非内置命令自动转发给 Claude Code |

## API 参考

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/bots` | 列出 Bot（本地 + Peer） |
| `POST` | `/api/bots` | 运行时创建 Bot |
| `GET` | `/api/bots/:name` | 获取 Bot 详情 |
| `DELETE` | `/api/bots/:name` | 删除 Bot |
| `POST` | `/api/talk` | 与 Bot 对话（自动路由到 peer，支持 `peerName/botName`） |
| `GET` | `/api/peers` | 列出 Peer 及状态 |
| `POST` | `/api/schedule` | 创建一次性或周期性 (cron) 定时任务 |
| `GET` | `/api/schedule` | 列出定时任务（一次性 + 周期性） |
| `PATCH` | `/api/schedule/:id` | 更新定时任务 |
| `DELETE` | `/api/schedule/:id` | 取消定时任务 |
| `POST` | `/api/schedule/:id/pause` | 暂停周期性任务 |
| `POST` | `/api/schedule/:id/resume` | 恢复已暂停的周期性任务 |
| `POST` | `/api/sync` | 触发 MetaMemory → Wiki 同步 |
| `GET` | `/api/sync` | 查看同步状态 |
| `POST` | `/api/sync/document` | 按 ID 同步单个文档 |
| `GET` | `/api/feishu/document` | 读取飞书文档并转为 Markdown |
| `GET` | `/api/stats` | 费用与使用统计（按 Bot/用户） |
| `GET` | `/api/metrics` | Prometheus 监控指标 |
| `POST` | `/api/tts` | 文字转语音（JSON 文本输入，MP3 音频输出） |

## CLI 工具

安装器将 `metabot`、`mm`、`mb` 可执行文件放到 `~/.local/bin/`（Linux/macOS）或 `%USERPROFILE%\.local\bin\` 并创建 `.cmd` 包装器（Windows），安装后立即可用。

```bash
# MetaBot 管理
metabot update                      # 拉取最新代码，重新构建，重启
metabot start                       # 启动（PM2）
metabot stop                        # 停止
metabot restart                     # 重启
metabot logs                        # 查看实时日志
metabot status                      # PM2 进程状态

# MetaMemory — 读
mm search "部署指南"                 # 全文搜索
mm list                             # 列出文档
mm folders                          # 文件夹树
mm path /projects/my-doc            # 按路径获取文档

# MetaMemory — 写
echo '# 笔记' | mm create "标题" --folder ID --tags "dev"
echo '# 更新内容' | mm update DOC_ID
mm mkdir "new-folder"               # 创建文件夹
mm delete DOC_ID                    # 删除文档

# 飞书 Lark CLI（飞书 Bot 专属，自动安装配置）
lark-cli docs +fetch --doc <飞书链接>                         # 读取文档
lark-cli docs +create --title "标题" --markdown "内容"        # 创建文档
lark-cli im +messages-send --chat-id oc_xxx --text "Hi"     # 发消息
lark-cli calendar +agenda --as user                         # 查看日程

# Agent 总线
mb bots                             # 列出所有 Bot（本地 + Peer）
mb talk <bot> <chatId> <prompt>     # 与 Bot 对话（自动路由到 Peer）
mb talk alice/bot <chatId> <prompt> # 指定 Peer 的 Bot 对话
mb peers                            # 列出 Peer 及状态
mb schedule list                    # 列出定时任务
mb schedule cron <bot> <chatId> '<cron>' <prompt>  # 创建周期性任务
mb schedule pause <id>              # 暂停周期性任务
mb schedule resume <id>             # 恢复周期性任务
mb stats                            # 费用和使用统计
mb health                           # 状态检查
mb update                           # 一键更新：拉取 + 构建 + 重启

# 文字转语音
mb voice "你好世界"                   # 生成 MP3，输出文件路径
mb voice "你好" --play               # 生成并播放音频
mb voice "你好" -o greeting.mp3      # 保存到指定文件
echo "长文本" | mb voice             # 从标准输入读取
```

### 远程访问

CLI 工具（`mb`、`mm`）支持连接远程 MetaBot/MetaMemory 服务器。在本地 `.env` 文件中配置 URL：

```bash
# 在 ~/.metabot/.env 或 ~/metabot/.env 中
METABOT_URL=http://your-server:9100      # mb 命令连接的服务器
META_MEMORY_URL=http://your-server:8100 # mm 命令连接的服务器
API_SECRET=your-secret                    # 共享认证 Token
```

这样多台机器可以共享同一个 MetaBot 和 MetaMemory 实例 —— 本地 Bot 可以向远程 Agent Bus 委派任务，任何机器都能读写共享记忆。

## 开发

```bash
npm run dev          # 热重载开发服务器（tsx）
npm test             # 运行测试（vitest，155 个测试）
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
npm run build        # TypeScript 编译到 dist/
```

## 生产部署

```bash
metabot start                       # 或: pm2 start ecosystem.config.cjs
metabot update                      # 拉取 + 构建 + 重启
pm2 startup && pm2 save             # 开机自启
```

## FAQ

**需要公网 IP 吗？** — 不需要。飞书用 WebSocket，Telegram 和微信用长轮询。

**可以用国产模型吗？** — 可以。支持 Kimi、DeepSeek、GLM 等 Anthropic 兼容 API。

**Agent 间通信是实时的吗？** — 目前是同步请求-响应模式。异步双向协议在规划中。

## 关于

MetaBot 由 [XVI Robotics](https://xvirobotics.com) 打造，我们做人形机器人大脑。我们在内部用 MetaBot 把公司打造成 Agent Native 组织 —— 一个小团队的人类，监督自我进化的 AI Agent。我们开源它，因为我们相信这是未来公司的运行方式。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=xvirobotics/metabot&type=Date)](https://star-history.com/#xvirobotics/metabot&Date)

## License

[MIT](LICENSE)
