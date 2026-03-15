# MetaBot

**构建受监督的、自我进化的 Agent 组织的基础设施。**

[![CI](https://img.shields.io/github/actions/workflow/status/xvirobotics/metabot/ci.yml?branch=main&style=flat-square)](https://github.com/xvirobotics/metabot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=flat-square)](https://github.com/xvirobotics/metabot)

[English](README.md) | 中文

---

![MetaBot 架构图](resources/metabot.png)

## 为什么做 MetaBot

Claude Code 是最强的 AI 编码 Agent —— 但它被锁在笔记本终端里。

MetaBot 解放了它。给每个 Agent 一个 Claude Code 大脑、持久化的共享记忆、创建新 Agent 的能力、以及通信总线。全部可以从飞书或 Telegram 手机端控制。

我们做 MetaBot 是为了把 [XVI Robotics](https://xvirobotics.com) 打造成一个 **Agent Native 公司** —— 一个小团队的人类，监督一个自我进化的 AI Agent 组织。这是让这一切成为可能的基础设施。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│                       MetaBot                            │
│                                                          │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────┐  │
│  │ MetaSkill│ │MetaMemory │ │IM Bridge │ │  定时任务  │  │
│  │  Agent   │ │   共享    │ │  飞书 +  │ │   调度器   │  │
│  │  工厂    │ │   知识库  │ │ Telegram │ │           │  │
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
| **受监督 (Supervised)** | IM Bridge | 实时流式卡片展示每一步工具调用。人类看到 Agent 做的一切。通过飞书/Telegram 平台设置控制访问。 |
| **自我进化 (Self-Improving)** | MetaMemory | 共享知识库。Agent 写入学到的东西，其他 Agent 检索引用。组织每天都在变聪明，无需重新训练。 |
| **Agent 组织 (Organization)** | MetaSkill + 调度器 + Agent 总线 | 一个命令生成完整 Agent 团队。Agent 互相委派任务。定时任务自主运行。Agent 可以创建新 Agent。 |

## 核心组件

| 组件 | 说明 |
|------|------|
| **Claude Code 内核** | 每个 Bot 都是完整的 Claude Code 实例 — Read, Write, Edit, Bash, Glob, Grep, WebSearch, MCP 等。`bypassPermissions` 模式自主运行。 |
| **MetaSkill** | Agent 工厂。`/metaskill ios app` 调研最佳实践后生成完整的 `.claude/` Agent 团队（orchestrator + 专家 + reviewer）。通过 MetaMemory 实现 Agent 间共享知识。 |
| **MetaMemory** | 内嵌 SQLite 知识库，全文搜索，Web UI。Agent 跨会话读写 Markdown 文档。所有 Agent 共享。变更自动同步到飞书知识库（带防抖）。Web UI：`http://localhost:8100?token=YOUR_TOKEN`（启动日志会打印完整 URL）。 |
| **飞书文档阅读** | 读取飞书文档/知识库页面并转为 Markdown。CLI `fd read <url>`，或用户分享飞书链接时 Claude 自动读取。以 `feishu-doc` skill 形式提供。 |
| **IM Bridge** | 飞书或 Telegram（含手机端）与任意 Agent 对话。带颜色状态的流式卡片 + 工具调用追踪。 |
| **Agent 总线** | 9100 端口 REST API。Agent 通过 `mb talk` 互相对话。运行时创建/删除 Bot。以 `/metabot` skill 形式按需加载，不注入每次对话。 |
| **Peers 联邦** | 跨实例 Bot 发现和任务路由。配置 `METABOT_PEERS` 连接多个 MetaBot 实例 — 同机或远程。`mb talk alice/backend-bot` 自动路由。 |
| **定时任务调度器** | 一次性延迟和周期性 cron 任务。`0 8 * * 1-5` = 工作日早8点新闻简报。支持时区配置（默认 Asia/Shanghai）。跨重启持久化，忙时自动重试。 |
| **CLI 工具** | `metabot`、`mm`、`mb`、`fd` 命令安装到 `~/.local/bin/`。`metabot update` 一键更新重启。`mm` 管理 MetaMemory，`mb` 管理 Agent 总线，`fd` 读取飞书文档。 |

## 安装

**Linux / macOS：**

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

**Windows (PowerShell)：**

```powershell
irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
```

安装器引导：工作目录 → Claude 认证 → IM 平台凭证 → PM2 自动启动。

**随时更新** — 已安装？一条命令拉取、构建、重启：

```bash
metabot update
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

**飞书**：
1. [open.feishu.cn](https://open.feishu.cn/) 创建应用 → 添加「机器人」能力
2. 开通权限：`im:message`、`im:message:readonly`、`im:resource`、`im:chat:readonly`（群聊检测）、`docx:document:readonly`、`wiki:wiki`（文档阅读和知识库同步）
3. 先启动 MetaBot，再开启「长连接」+ `im.message.receive_v1` 事件
4. 发布应用

## 你可以构建什么

- **个人 AI 开发者** — 手机上用飞书/Telegram 远程写代码，绑定你的项目
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
| `maxTurns` / `maxBudgetUsd` | 否 | 不限 | 执行限制 |
| `model` | 否 | SDK 默认 | Claude 模型 |

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

## 安全

MetaBot 以 `bypassPermissions` 模式运行 Claude Code — 无交互式确认：

- Claude 对工作目录有完整读写执行权限
- 通过飞书/Telegram 平台设置控制访问（应用可见范围、群成员管理）
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
| `/report-bug <描述>` | 报告 Bug — 引导描述并创建 GitHub Issue |
| `/request-feature <想法>` | 请求功能 — 梳理想法并创建 GitHub Issue |
| `/fix-issue <编号\|list>` | 认领并修复 GitHub Issue — 创建分支、提交、发起 PR |
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

## CLI 工具

安装器将 `metabot`、`mm`、`mb`、`fd`（飞书 Bot 专属）可执行文件放到 `~/.local/bin/`（Linux/macOS）或 `%USERPROFILE%\.local\bin\` 并创建 `.cmd` 包装器（Windows），安装后立即可用。

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

# 飞书文档阅读（飞书 Bot 专属）
fd read <飞书链接>                    # 按 URL 读取文档（docx 或 wiki）
fd read-id <docId>                  # 按文档 ID 读取
fd info <飞书链接>                    # 获取文档元信息

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

## 参与贡献

MetaBot 内置了 Claude Code 技能，简化贡献流程。可以在终端或飞书/Telegram 聊天中直接使用。

| 命令 | 说明 |
|------|------|
| `/report-bug` | 引导你描述 Bug，自动收集环境信息，草拟 GitHub Issue 并在你确认后创建。 |
| `/request-feature` | 帮你梳理功能想法，检查是否已有类似功能，创建结构化的功能需求 Issue。 |
| `/fix-issue [编号]` | 认领 Issue，创建分支，实现修复，运行 CI，提交 PR —— 全程引导。 |

**终端使用：**

```bash
claude "/report-bug 空内容时卡片构建器崩溃"
claude "/request-feature 支持 Slack 作为 IM 平台"
claude "/fix-issue 42"
claude "/fix-issue list"
```

**飞书/Telegram 使用：** 直接在聊天中发送相同命令（如 `/report-bug ...`）。Bot 会将命令转发给 Claude Code，以交互式卡片展示过程和结果。

完整贡献指南（代码风格、分支策略、PR 清单）请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

**需要公网 IP 吗？** — 不需要。飞书用 WebSocket，Telegram 用长轮询。

**可以用国产模型吗？** — 可以。支持 Kimi、DeepSeek、GLM 等 Anthropic 兼容 API。

**Agent 间通信是实时的吗？** — 目前是同步请求-响应模式。异步双向协议在规划中。

## 关于

MetaBot 由 [XVI Robotics](https://xvirobotics.com) 打造，我们做人形机器人大脑。我们在内部用 MetaBot 把公司打造成 Agent Native 组织 —— 一个小团队的人类，监督自我进化的 AI Agent。我们开源它，因为我们相信这是未来公司的运行方式。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=xvirobotics/metabot&type=Date)](https://star-history.com/#xvirobotics/metabot&Date)

## License

[MIT](LICENSE)
