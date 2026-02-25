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

我们做 MetaBot 是为了把 [XVI Robotics](https://github.com/xvirobotics) 打造成一个 **Agent Native 公司** —— 一个小团队的人类，监督一个自我进化的 AI Agent 组织。这是让这一切成为可能的基础设施。

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
| **受监督 (Supervised)** | IM Bridge + 权限控制 | 实时流式卡片展示每一步工具调用。用户/群白名单访问控制。人类看到 Agent 做的一切。 |
| **自我进化 (Self-Improving)** | MetaMemory | 共享知识库。Agent 写入学到的东西，其他 Agent 检索引用。组织每天都在变聪明，无需重新训练。 |
| **Agent 组织 (Organization)** | MetaSkill + 调度器 + Agent 总线 | 一个命令生成完整 Agent 团队。Agent 互相委派任务。定时任务自主运行。Agent 可以创建新 Agent。 |

## 核心组件

| 组件 | 说明 |
|------|------|
| **Claude Code 内核** | 每个 Bot 都是完整的 Claude Code 实例 — Read, Write, Edit, Bash, Glob, Grep, WebSearch, MCP 等。`bypassPermissions` 模式自主运行。 |
| **MetaSkill** | Agent 工厂。`/metaskill ios app` 调研最佳实践后生成完整的 `.claude/` Agent 团队（tech-lead + 专家 + reviewer）。 |
| **MetaMemory** | 内嵌 SQLite 知识库，全文搜索，Web UI。Agent 跨会话读写 Markdown 文档。所有 Agent 共享。 |
| **IM Bridge** | 飞书或 Telegram（含手机端）与任意 Agent 对话。带颜色状态的流式卡片 + 工具调用追踪。 |
| **Agent 总线** | 9100 端口 REST API。Agent 通过 `curl` 互相委派任务。运行时创建/删除 Bot。以 `/metabot-api` skill 形式按需加载，不注入每次对话。 |
| **定时任务调度器** | Agent 安排未来的工作 —— "2小时后检查一下"。跨重启持久化，忙时自动重试。 |
| **CLI 工具** | `mm` 和 `mb` 命令安装到 `~/.local/bin/`。在任意终端管理 MetaMemory 和 Agent 总线 —— 无需 source。 |

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
```

安装器引导：工作目录 → Claude 认证 → IM 平台凭证 → PM2 自动启动。

<details>
<summary><strong>手动安装</strong></summary>

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # 编辑 Bot 配置
cp .env.example .env              # 编辑全局设置
npm run dev
```

前置条件：Node.js 18+，[Claude Code CLI](https://github.com/anthropics/claude-code) 已安装并认证。

</details>

## 快速配置

**Telegram**（30秒）：
1. 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 复制 token
2. 写入 `bots.json` → 完成（长轮询，无需 Webhook）

**飞书**（[详细指南](docs/feishu-setup.md)）：
1. [open.feishu.cn](https://open.feishu.cn/) 创建应用 → 添加「机器人」能力
2. 开通权限：`im:message`、`im:message:readonly`、`im:resource`
3. 先启动 MetaBot，再开启「长连接」+ `im.message.receive_v1` 事件
4. 发布应用

## 你可以构建什么

- **个人 AI 开发者** — 手机上用飞书/Telegram 远程写代码，绑定你的项目
- **多 Agent 团队** — 前端 Bot、后端 Bot、运维 Bot，各自独立工作空间，通过 Agent 总线协作
- **自生长的组织** — 管理者 Bot 按需创建新 Agent，分配任务，安排后续跟进
- **自主研究流水线** — Agent 搜索、分析、将发现存入 MetaMemory、安排下一步

## Agent 间通信

Agent 通过 HTTP API 互相通信。Claude 自主使用 `curl`：

```bash
# 委派任务给另一个 Bot
curl -X POST localhost:9100/api/tasks \
  -H "Authorization: Bearer $SECRET" \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"跑一下迁移脚本"}'

# 安排 1 小时后的跟进
curl -X POST localhost:9100/api/schedule \
  -d '{"botName":"backend-bot","chatId":"oc_xxx","prompt":"检查迁移结果","delaySeconds":3600}'

# 运行时创建新 Bot
curl -X POST localhost:9100/api/bots \
  -d '{"platform":"telegram","name":"data-bot","telegramBotToken":"...","defaultWorkingDirectory":"/data"}'
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
| `allowedTools` | 否 | Read,Edit,Write,Glob,Grep,Bash | Claude 可用工具 |
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
| `MEMORY_SECRET` | `API_SECRET` | MetaMemory 认证 |
| `WEBHOOK_URLS` | — | 逗号分隔的 Webhook URL，任务完成后发通知 |
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
- 用 `allowedTools` 限制工具（去掉 `Bash` = 只读模式）
- 用 `maxBudgetUsd` 限制单次花费
- `API_SECRET` 同时保护 API 服务器和 MetaMemory

## 聊天命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除会话 |
| `/stop` | 中止当前任务 |
| `/status` | 查看会话状态 |
| `/memory list` | 浏览知识库目录 |
| `/memory search 关键词` | 搜索知识库 |
| `/help` | 帮助 |
| `/metaskill ...` | 生成 Agent 团队、Agent 或 Skill |
| `/metabot-api` | Agent 总线、定时任务、Bot 管理 API 文档（按需加载） |
| `/任意命令` | 非内置命令自动转发给 Claude Code |

## API 参考

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/bots` | 列出 Bot |
| `POST` | `/api/bots` | 运行时创建 Bot |
| `GET` | `/api/bots/:name` | 获取 Bot 详情 |
| `DELETE` | `/api/bots/:name` | 删除 Bot |
| `POST` | `/api/tasks` | 委派任务给 Bot |
| `POST` | `/api/schedule` | 创建定时任务 |
| `GET` | `/api/schedule` | 列出定时任务 |
| `PATCH` | `/api/schedule/:id` | 更新定时任务 |
| `DELETE` | `/api/schedule/:id` | 取消定时任务 |
| `GET` | `/api/stats` | 费用与使用统计（按 Bot/用户） |
| `GET` | `/api/metrics` | Prometheus 监控指标 |

## CLI 工具

安装器将 `mm` 和 `mb` 可执行文件放到 `~/.local/bin/`，安装后立即可用，无需 `source`。

```bash
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

# Agent 总线
mb bots                             # 列出所有 Bot
mb task <bot> <chatId> <prompt>     # 委派任务
mb schedule list                    # 列出定时任务
mb stats                            # 费用和使用统计
mb health                           # 状态检查
```

## 开发

```bash
npm run dev          # 热重载开发服务器（tsx）
npm test             # 运行测试（vitest，71 个测试）
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
npm run build        # TypeScript 编译到 dist/
```

## 生产部署

```bash
pm2 start ecosystem.config.cjs
pm2 startup && pm2 save
```

## FAQ

**需要公网 IP 吗？** — 不需要。飞书用 WebSocket，Telegram 用长轮询。

**可以用国产模型吗？** — 可以。支持 Kimi、DeepSeek、GLM 等 Anthropic 兼容 API。

**Agent 间通信是实时的吗？** — 目前是同步请求-响应模式。异步双向协议在规划中。

## 关于

MetaBot 由 [XVI Robotics](https://github.com/xvirobotics) 打造，我们做人形机器人大脑。我们在内部用 MetaBot 把公司打造成 Agent Native 组织 —— 一个小团队的人类，监督自我进化的 AI Agent。我们开源它，因为我们相信这是未来公司的运行方式。

## License

[MIT](LICENSE)
