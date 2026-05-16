# 目标循环（Goal Loops）

设一个目标，MetaBot 让 Claude 跨多轮持续推进，直到目标达成。

## 功能

`/goal` 让你把"目标"交给 Claude，而不是单条指令。Agent 会**跨多轮**自动驱动：检查、重试、等待外部状态，达成条件时回来汇报（或者你主动叫停）。

飞书卡片会在多轮之间持续显示 `🎯 Goal: <condition>` 徽标，你随时知道 Agent 在追什么。

## 用法

发 `/goal` 加目标条件：

```
/goal PR #123 的 CI 全绿、部署成功。
每 10 分钟检查一次，搞定后告诉我。
```

```
/goal Linear INGEST 项目下所有 open ticket 都已解决或分派给人。
每 30 分钟复查一次。
```

其他形式：

| 命令 | 效果 |
|------|------|
| `/goal <条件>` | 设置或替换当前目标 |
| `/goal` | 查询当前目标（不修改） |
| `/goal clear`（或 `stop` / `off` / `reset` / `none` / `cancel`） | 清除当前目标 |

## 工作原理

`/goal` 是 **Claude Code 原生命令**，循环机制本身跑在 Claude Code 内部：

1. 设置目标时，Claude 注册一个会话级 **Stop hook**。
2. 每轮结束时，Stop hook 调用快速模型评估目标是否达成。
3. **未达成**则自动排队下一轮；**已达成**则结束循环并汇报结果。

MetaBot 的贡献是让这套机制能跨飞书消息工作：

- **每个会话一个常驻 Claude 进程**（一个长生命周期的 SDK 会话 per `chatId`），这是 Stop hook 跨用户轮存活的前提。没有它的话，每轮都重新启动子进程，hook 会被杀掉。该机制默认开启，无需配置。
- 飞书卡片把目标条件镜像成持久徽标，让用户看到 Agent 在追什么。

## 限制

- 自动驱动的轮次和手动轮次一样，计入 Bot 的 token 预算（`maxBudgetUsd`）和轮次上限（`maxTurns`）。
- 每个会话只能有一个活跃目标。再次设置会替换原目标。
- `/stop` 中止当前轮次；`/goal clear` 完全停止循环。
- 目标作用域是单个会话（`chatId`），`/reset` 后不保留。

## 相关

- [Agent 团队](agent-teams.md) — 把目标和并行队友组合使用
- [聊天命令](../usage/chat-commands.md) — 完整命令参考
