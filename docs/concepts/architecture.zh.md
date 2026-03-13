# 架构

MetaBot 是一个 TypeScript ESM 项目，连接 IM 平台（飞书、Telegram）与 Claude Code Agent SDK。

## 系统概览

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

## 三大支柱

| 支柱 | 组件 | 作用 |
|------|------|------|
| **受监督** | IM Bridge | 实时流式卡片展示每一步工具调用。人类看到 Agent 做的一切。通过飞书/Telegram 平台设置控制访问。 |
| **自我进化** | MetaMemory | 共享知识库。Agent 写入学到的东西，其他 Agent 检索引用。组织每天都在变聪明，无需重新训练。 |
| **Agent 组织** | MetaSkill + 调度器 + Agent 总线 | 一个命令生成完整 Agent 团队。Agent 互相委派任务。定时任务自主运行。Agent 可以创建新 Agent。 |

## 消息流

```
IM 客户端 → EventHandler（解析，@mention 过滤）
         → MessageBridge（命令路由，任务管理）
         → ClaudeExecutor（Agent SDK 查询）
         → StreamProcessor（卡片状态跟踪）
         → IM 卡片更新（流式）
```

## 核心模块

| 模块 | 说明 |
|------|------|
| `src/index.ts` | 入口。创建 IM 客户端，接线事件分发，优雅关闭。 |
| `src/config.ts` | 从 `bots.json` 或环境变量加载配置。 |
| `src/feishu/event-handler.ts` | 解析飞书事件，过滤 @mention，处理文本/图片。 |
| `src/bridge/message-bridge.ts` | 核心调度器。路由命令，管理每个 chat 的任务，执行 Claude 查询并流式更新。 |
| `src/claude/executor.ts` | 封装 Agent SDK 的 `query()` 为异步生成器。 |
| `src/claude/stream-processor.ts` | 将 SDK 消息转为卡片状态对象。 |
| `src/claude/session-manager.ts` | 内存中的会话存储，按 `chatId` 索引。24 小时过期。 |
| `src/feishu/card-builder.ts` | 构建飞书交互卡片 JSON，带颜色编码的标题。 |
| `src/feishu/message-sender.ts` | 飞书 API 封装：发送/更新卡片、上传图片。 |
| `src/bridge/rate-limiter.ts` | 卡片更新节流（默认 1.5 秒）避免 API 频率限制。 |
| `src/api/peer-manager.ts` | 跨实例 Bot 发现和任务转发。 |
| `src/bridge/outputs-manager.ts` | 输出文件生命周期（准备、扫描、清理、类型路由）。 |
