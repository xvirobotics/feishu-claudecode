# feishu-claudecode

[English](#english) | [中文](#中文)

<p align="center">
  <img src="docs/screenshot-help.png" width="45%" />
  <img src="docs/screenshot-chat.png" width="45%" />
</p>

---

<a id="english"></a>

## English

A bridge service connecting Feishu (Lark) Bot to Claude Code CLI. Chat with Claude Code from Feishu on any device (including mobile), with real-time streaming updates via interactive cards.

### Features

- **Remote access** - Use Claude Code from any Feishu device, including mobile
- **Streaming updates** - Real-time execution progress via interactive card updates
- **Multi-bot support** - Run multiple bots in one process, each bound to a different project directory and Feishu app
- **Multi-user parallel** - Independent sessions per chat (each group/DM has its own session)
- **Multi-turn conversations** - Automatic context persistence across messages
- **Image support** - Send images to Claude for analysis; Claude-generated images are sent back
- **MCP integration** - Automatically loads MCP server configs from Claude Code settings
- **Status cards** - Color-coded status, tool call tracking, cost/duration stats

### Prerequisites

- **Node.js 18+**
- **Claude Code authentication** - Either logged in via `claude login` (subscription) or `ANTHROPIC_API_KEY` env var
- **Feishu Open Platform account** - To create a bot application

### Feishu Bot Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn/) and create an enterprise app
2. Go to **App Capabilities** → Add **Bot**
3. Go to **Events & Callbacks** → **Event Configuration**:
   - Select **"Use persistent connection to receive events"** (WebSocket mode, no public IP needed)
   - Add event: `im.message.receive_v1`
4. Go to **Permissions** and enable:
   - `im:message` - Send and receive messages
   - `im:message:readonly` - Read messages
   - `im:resource` - Upload images and files (required for sending output files back to chat)
5. Publish the app version and get approval

### Installation

```bash
git clone <your-repo-url>
cd feishu-claudecode
npm install
```

### Configuration

```bash
cp bots.example.json bots.json   # edit with your bot configs
cp .env.example .env              # edit global settings
```

**`bots.json`** — defines one or more bots (see `bots.example.json`):

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | - | Bot identifier (used in logs) |
| `feishuAppId` | Yes | - | Feishu App ID |
| `feishuAppSecret` | Yes | - | Feishu App Secret |
| `defaultWorkingDirectory` | Yes | - | Fixed working directory for this bot |
| `authorizedUserIds` | No | (allow all) | Array of user open_ids |
| `authorizedChatIds` | No | (allow all) | Array of chat_ids |
| `allowedTools` | No | Read,Edit,Write,Glob,Grep,Bash | Allowed Claude tools |
| `maxTurns` | No | unlimited | Max conversation turns per query |
| `maxBudgetUsd` | No | unlimited | Max cost per query (USD) |
| `model` | No | SDK default | Claude model |

**`.env`** — global settings:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOTS_CONFIG` | No | - | Path to `bots.json`. If unset, falls back to single-bot env vars |
| `LOG_LEVEL` | No | info | Log level |

<details>
<summary>Single-bot mode (legacy env var config)</summary>

If `BOTS_CONFIG` is not set, a single bot is configured from env vars:

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_APP_ID` | Yes | Feishu App ID |
| `FEISHU_APP_SECRET` | Yes | Feishu App Secret |
| `CLAUDE_DEFAULT_WORKING_DIRECTORY` | Yes | Working directory |
| `AUTHORIZED_USER_IDS` | No | Comma-separated user open_ids |
| `CLAUDE_ALLOWED_TOOLS` | No | Comma-separated tools |
| `CLAUDE_MAX_TURNS` | No | Max turns (unlimited if unset) |
| `CLAUDE_MAX_BUDGET_USD` | No | Max budget (unlimited if unset) |
| `CLAUDE_MODEL` | No | Claude model |

</details>

### Usage

```bash
# Development (hot reload)
npm run dev

# Production (PM2 — auto-restart on crash & code changes)
pm2 start ecosystem.config.cjs

# PM2 common commands
pm2 status              # View process status
pm2 logs                # Tail logs in real-time
pm2 restart all         # Manual restart
pm2 stop all            # Stop service
```

To enable auto-start on server reboot:

```bash
pm2 startup             # Follow the printed sudo command
pm2 save                # Save current process list
```

### Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clear session, start fresh |
| `/stop` | Abort current running task |
| `/status` | Show current session info |
| `/help` | Show help message |

### Image Support

**Send images to Claude:** Send an image in Feishu chat, and Claude will analyze it.

**Receive images from Claude:** When Claude generates or writes image files (via Write tool, Bash, or MCP tools), they are automatically uploaded and sent back to Feishu.

Supported formats: PNG, JPEG, GIF, WEBP, BMP, SVG, TIFF (max 10MB per Feishu limit).

### MCP Server Configuration

MCP servers are loaded from Claude Code's standard config files — no extra setup needed:

- **Global (all projects):** `~/.claude/settings.json`
- **Per-project:** `<working-directory>/.claude/settings.json`

Example config:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

The bot loads MCP servers based on the bot's configured working directory. If you already have MCP servers configured for Claude Code CLI, they work automatically.

### Security Note

This service runs Claude Code in **`bypassPermissions` mode** — Claude can read, write, and execute commands without interactive approval, since there is no terminal for user confirmation in a chat bot context.

**Make sure you understand the implications before deploying:**

- Claude has full read/write access to the working directory
- Claude can execute arbitrary shell commands if `Bash` is in the allowed tools
- Use `CLAUDE_ALLOWED_TOOLS` to restrict capabilities (e.g. remove `Bash` for read-only use)
- Use `maxBudgetUsd` in bot config to cap per-request cost
- Use `authorizedUserIds` in bot config to restrict who can access the bot
- **Never point the bot at directories containing sensitive data without proper access controls**

### Architecture

```
Feishu User
  → [WSClient] receives message event
  → [Event Handler] auth check, extract text, strip @mentions
  → [Message Bridge] orchestrates:
      1. Send "thinking" card
      2. Call Claude Code Agent SDK
      3. Stream process → throttled card updates (1.5s interval)
      4. Final result card
  → User sees real-time progress and results in Feishu
```

---

<a id="中文"></a>

## 中文

飞书 Bot 连接 Claude Code 的桥接服务。在飞书（包括手机端）通过聊天远程控制本机的 Claude Code，实时查看执行过程和结果。

### 功能特性

- **远程访问** - 在飞书任意设备上使用 Claude Code，手机也能写代码
- **流式更新** - 通过飞书交互卡片实时展示执行进度
- **多机器人支持** - 单进程运行多个 Bot，每个 Bot 绑定不同项目目录和飞书应用
- **多用户并行** - 每个会话（群聊/私聊）独立会话，互不干扰
- **多轮对话** - 自动维护对话上下文，支持连续交互
- **图片支持** - 发图片给 Claude 分析；Claude 生成的图片自动回传飞书
- **MCP 集成** - 自动加载 Claude Code 配置文件中的 MCP 服务器
- **状态卡片** - 颜色标识状态、工具调用追踪、费用/耗时统计

### 前置条件

- **Node.js 18+**
- **Claude Code 认证** - 通过 `claude login` 登录（订阅用户），或设置 `ANTHROPIC_API_KEY` 环境变量
- **飞书开放平台账号** - 用于创建机器人应用

---

### 第一步：创建飞书机器人

#### 1.1 创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/)，登录后点击「创建企业自建应用」
2. 填写应用名称（如 `Claude Code Bot`）和描述，点击创建

#### 1.2 获取凭证

1. 进入应用详情页，左侧菜单找到「凭证与基础信息」
2. 记录 **App ID** 和 **App Secret**，后面配置要用

#### 1.3 开启机器人能力

1. 左侧菜单 →「应用能力」→「添加应用能力」
2. 选择「机器人」，点击添加

#### 1.4 配置事件订阅

1. 左侧菜单 →「事件与回调」→「事件配置」
2. **订阅方式选择「使用长连接接收事件」**（这样不需要公网 IP，本地即可运行）
3. 添加事件：搜索并添加 `接收消息 im.message.receive_v1`

#### 1.5 配置权限

1. 左侧菜单 →「权限管理」
2. 搜索并开通以下权限：
   - `im:message` - 获取与发送单聊、群组消息
   - `im:message:readonly` - 读取消息（如已有 `im:message` 可跳过）
   - `im:resource` - 上传图片和文件（用于将 Claude 产出的文件发回聊天）

#### 1.6 发布应用

1. 左侧菜单 →「版本管理与发布」
2. 创建版本并提交审核
3. 管理员在飞书管理后台审核通过后即可使用

> **提示**：如果是个人测试，可以在「应用发布」中选择仅对自己可见的测试范围。

---

### 第二步：安装项目

```bash
git clone <your-repo-url>
cd feishu-claudecode
npm install
```

---

### 第三步：配置

```bash
cp bots.example.json bots.json   # 编辑 Bot 配置
cp .env.example .env              # 编辑全局设置
```

**`bots.json`** — 定义一个或多个 Bot（参考 `bots.example.json`）：

```json
[
  {
    "name": "my-project",
    "feishuAppId": "cli_xxxxxxxxxx",
    "feishuAppSecret": "xxxxxxxxxxxxxxxxxx",
    "defaultWorkingDirectory": "/path/to/your/project",
    "authorizedUserIds": ["ou_xxxx"],
    "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"]
  }
]
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | - | Bot 标识名（用于日志区分） |
| `feishuAppId` | 是 | - | 飞书应用 App ID |
| `feishuAppSecret` | 是 | - | 飞书应用 App Secret |
| `defaultWorkingDirectory` | 是 | - | 固定工作目录 |
| `authorizedUserIds` | 否 | 不限制 | 允许使用的用户 open_id 数组 |
| `authorizedChatIds` | 否 | 不限制 | 允许使用的 chat_id 数组 |
| `allowedTools` | 否 | Read,Edit,Write,Glob,Grep,Bash | Claude 可用工具 |
| `maxTurns` | 否 | 不限制 | 每次请求最大对话轮数 |
| `maxBudgetUsd` | 否 | 不限制 | 每次请求最大花费（美元） |
| `model` | 否 | SDK 默认 | 指定 Claude 模型 |

**`.env`** — 全局设置：

```bash
# 指向 Bot 配置文件
BOTS_CONFIG=./bots.json

# 日志级别
LOG_LEVEL=info
```

> **多 Bot 模式**：在 `bots.json` 中定义多个条目即可。每个 Bot 绑定不同的飞书应用和项目目录，在单个进程内同时运行。

#### 关于 Claude Code 认证

有两种方式，任选其一：

**方式一：订阅用户（推荐）**

如果你有 Claude Pro/Max 订阅，直接登录即可：

```bash
claude login
```

**方式二：API Key**

设置 `ANTHROPIC_API_KEY` 环境变量：

```bash
# 加到你的 ~/.bashrc 或 ~/.zshrc 中
export ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxx
```

---

### 第四步：启动服务

#### 开发模式（推荐先用这个测试）

```bash
npm run dev
```

#### 生产模式（PM2）

使用 PM2 进程管理器，支持崩溃自动重启、代码变更自动重启：

```bash
# 安装 PM2（如未安装）
npm install -g pm2

# 启动服务
pm2 start ecosystem.config.cjs
```

PM2 常用命令：

```bash
pm2 status              # 查看进程状态
pm2 logs                # 实时查看日志
pm2 restart all         # 手动重启
pm2 stop all            # 停止服务
```

设置开机自启：

```bash
pm2 startup             # 按照提示执行打印出的 sudo 命令
pm2 save                # 保存当前进程列表
```

看到类似以下日志表示启动成功：

```
[INFO] All bots started — bots: ["feishu-claudecode"]
[ws] ws client ready
```

---

### 第五步：开始使用

#### 基本流程

1. 在飞书中找到你的机器人（私聊或拉入群组）
2. 直接发送消息开始和 Claude Code 对话（工作目录已在配置中固定）
3. 卡片会实时更新执行进度，完成后显示最终结果

#### 可用命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除对话历史，重新开始 |
| `/stop` | 中止当前正在执行的任务 |
| `/status` | 查看当前会话状态 |
| `/help` | 显示帮助信息 |

#### 使用示例

```
你：帮我看看这个项目的结构，有哪些主要模块
Bot：🔵 Thinking... → 🔵 Running... → 🟢 Complete
    （卡片实时更新，展示 Claude 正在读取哪些文件、分析结果等）

你：给 utils.ts 加上单元测试
Bot：（Claude 会读取文件、编写测试、运行测试，全程卡片更新）

你：/reset
Bot：✅ Session Reset - 开始新对话
```

---

### 卡片状态说明

| 颜色 | 状态 | 含义 |
|------|------|------|
| 🔵 蓝色 | Thinking | Claude 正在思考 |
| 🔵 蓝色 | Running | 正在执行工具（读文件、写代码、运行命令等） |
| 🟢 绿色 | Complete | 执行完成 |
| 🔴 红色 | Error | 执行出错 |

卡片底部会显示：耗时、API 花费等统计信息。

---

### 多用户 / 多 Bot 说明

- 会话按**聊天**（chat_id）隔离，每个群聊和私聊都有独立的会话
- 每个 Bot 绑定固定的工作目录，不同 Bot 对应不同项目
- 不同聊天的任务可以同时并行执行
- 多个 Bot 在单进程中运行，各自独立的飞书 WebSocket 连接

---

### 图片支持

**发送图片给 Claude：** 在飞书中直接发送图片，Claude 会自动分析图片内容。

**接收 Claude 生成的图片：** 当 Claude 通过工具（Write、Bash、MCP 等）生成图片文件时，图片会自动上传并发送到飞书聊天中。

支持格式：PNG、JPEG、GIF、WEBP、BMP、SVG、TIFF（单张最大 10MB，飞书限制）。

---

### MCP 服务器配置

MCP 服务器配置直接复用 Claude Code 的标准配置文件，无需额外设置：

- **全局配置（所有项目共用）：** `~/.claude/settings.json`
- **项目配置（特定目录生效）：** `<工作目录>/.claude/settings.json`

配置示例：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

Bot 会根据配置中的工作目录加载对应的 MCP 配置。如果你已经为 Claude Code CLI 配置过 MCP 服务器，它们会自动生效。

---

### 架构概览

```
飞书用户发消息
  → [WSClient 长连接] 接收消息事件
  → [Event Handler] 鉴权、提取文本、去除 @
  → [Message Bridge] 编排核心流程：
      1. 发送"思考中"卡片
      2. 调用 Claude Code Agent SDK
      3. 流式处理 → 节流更新卡片（1.5s 间隔）
      4. 完成后更新为最终结果卡片
  → 用户在飞书看到实时过程和结果
```

---

### 安全说明

本服务以 **`bypassPermissions`（跳过权限确认）模式** 运行 Claude Code —— Claude 可以直接读写文件和执行命令，无需交互式确认（因为聊天机器人场景下没有终端来审批）。

**部署前请确保你了解以下影响：**

- Claude 对工作目录拥有完整的读写权限
- 如果允许工具列表中包含 `Bash`，Claude 可以执行任意 Shell 命令
- 通过 `allowedTools` 限制可用工具（例如去掉 `Bash` 实现只读模式）
- 通过 `maxBudgetUsd` 限制单次请求的最大花费
- 通过 `authorizedUserIds` 限制谁可以使用机器人
- **不要将机器人指向包含敏感数据的目录，除非已做好访问控制**

---

### 常见问题

**Q: 需要公网 IP 吗？**

不需要。本项目使用飞书的 **WebSocket 长连接**模式接收事件，只需要能访问外网即可，无需域名或公网 IP。

**Q: 为什么消息没有响应？**

检查以下几点：
1. 应用是否已发布并审核通过
2. 事件订阅是否选择了「长连接」模式
3. 是否添加了 `im.message.receive_v1` 事件
4. 权限 `im:message` 是否已开通
5. 如果配置了 `authorizedUserIds`，确认你的 open_id 在列表中

**Q: 如何获取用户的 open_id？**

发送 `/status` 命令，卡片中会显示当前用户的 open_id。

**Q: 如何限制只有特定人可以使用？**

在 `bots.json` 中设置 `authorizedUserIds`：

```json
{
  "name": "my-bot",
  "authorizedUserIds": ["ou_xxxx1", "ou_xxxx2"],
  ...
}
```

**Q: Claude 执行超时了怎么办？**

默认 10 分钟超时。如果任务确实需要更长时间，可以拆分为多个小任务。也可以用 `/stop` 手动中止后重试。

---

## License

[MIT](LICENSE)
