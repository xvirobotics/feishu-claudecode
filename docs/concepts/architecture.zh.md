# 架构

MetaBot 是 Node.js >= 22.19 的 TypeScript ESM monorepo。Bridge 把飞书/Lark、
Telegram、Slack、微信和 Web 客户端接入引擎无关的消息流水线；每个 Bot 或 Chat
可以运行 Codex、Kimi Code 或 Claude 兼容引擎。

## 系统概览

```text
飞书/Lark · Telegram · Slack · 微信 · Web
                    │
             事件与 API 适配器
                    │
             MessageBridge
         命令 · 任务 · 会话 · 媒体
                    │
                引擎路由
          ┌─────────┼──────────┐
          │         │          │
   Codex CLI    Kimi Code    Claude Code
   exec JSONL   本地 Server   兼容路径
   + resume     API 0.27+     CLI / SDK
          └─────────┼──────────┘
                    │
          共享流式/卡片事件模型
                    │
          渠道卡片与 Web 更新

个人 Core (:9200)            Bridge (:9100)
Agents · Memory · Skills     IM · 本地 API · WebSocket
T5T · Teams · Chat      ↔     会话 · 文件 · Peers
```

Codex 是默认引擎，当前使用 `codex exec --json` 和 `codex exec resume`；
公开版尚未使用 Codex app-server 或原生执行中 steering。Kimi Code 0.27+
使用官方 loopback Server API，提供持久 Session、原子快照、问题交互、
工具、子 Agent、Goal 和完成状态。本版本暂不开放飞书执行中 steering。Claude 作为现有 Bot 和
工作区的显式兼容引擎保留。

## 三大支柱

| 支柱           | 组件                             | 作用                                                             |
| -------------- | -------------------------------- | ---------------------------------------------------------------- |
| **受监督**     | IM Bridge + Web UI               | 流式展示工具和状态，让用户监控、停止、回答，并在引擎支持时插话。 |
| **自我进化**   | MetaMemory + Skills + T5T        | 把可复用知识、工作流和项目检查点保存在单个模型会话之外。         |
| **Agent 组织** | Agent Teams + Agent Bus + 调度器 | 协调持久队友、任务、运行、跨 Agent 消息和可选周期工作。          |

## 消息流

**IM 渠道：**

```text
渠道事件
  → EventHandler（解析、媒体、精确 @Bot 路由）
  → MessageBridge（命令、队列、任务/会话状态）
  → Engine.createExecutor()（Codex、Kimi 或 Claude 兼容）
  → 原生输出转换为共享 SDKMessage/CardState 事件
  → 节流后的流式卡片或渠道回复
```

**个人 Web UI：**

```text
浏览器
  → Token 鉴权的 Core API (:9200)
  → Chat / Agents / Memory / Skills / T5T / Teams
  → 已注册的 Bridge Agent
  → 选定的引擎和工作区
```

个人版 Package 将 Core 和 Bridge 作为独立 PM2 应用运行。Core 使用本地
Bearer Token 鉴权，Bridge 渠道凭证留在 Bridge 侧。

## 引擎边界

`src/engines/index.ts` 解析配置的引擎，缺省为 Codex。所有适配器都实现共享
`Engine` / `Executor` contract，并把各自原生协议转换成 Bridge 和卡片渲染器
消费的事件格式。

| 引擎        | 原生协议                       | 会话行为                                |
| ----------- | ------------------------------ | --------------------------------------- |
| Codex       | `codex exec --json` JSONL      | 使用 `codex exec resume` 续接已保存会话 |
| Kimi Code   | 官方 `/api/v1` 本地 Server API | 持久 Kimi Session 和原子前端快照        |
| Claude 兼容 | Claude CLI / Agent SDK         | 现有 Claude 会话和持久 Executor 行为    |

## 核心模块

| 模块                                           | 说明                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| `src/index.ts`                                 | 入口；创建渠道客户端、注册表、存储和关闭处理器。       |
| `src/config.ts`                                | 加载引擎、渠道、Core、工作区和每 Bot 配置。            |
| `src/bridge/message-bridge.ts`                 | 命令、队列、任务、会话、媒体和引擎执行的核心调度器。   |
| `src/engines/index.ts`                         | 引擎选择和共享边界。                                   |
| `src/engines/codex/executor.ts`                | 启动 Codex exec/resume 并转换 JSONL 事件。             |
| `src/engines/kimi/daemon-client.ts`            | 启动或连接 Kimi Code 本地 Server API。                 |
| `src/engines/kimi/executor.ts`                 | 驱动 Kimi Session、快照、插话、问题、Goal 和完成状态。 |
| `src/engines/claude/`                          | Claude 兼容 Executor、会话和流处理代码。               |
| `src/feishu/event-handler.ts`                  | 飞书事件解析、媒体缓存、群模式和精确 @ 路由。          |
| `src/telegram/` / `src/slack/` / `src/wechat/` | Telegram、Slack 和微信渠道适配器。                     |
| `src/agent-teams/`                             | 持久本地 Team、任务、成员和运行编排。                  |
| `packages/server/`                             | 个人 Core HTTP 后端和 Token 鉴权。                     |
| `packages/web-ui/`                             | 个人 Core 浏览器应用。                                 |
