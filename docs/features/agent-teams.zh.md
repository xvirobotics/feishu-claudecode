# Agent 团队

主导 Agent 并行派遣专家队友，互相路由任务、汇总结果 —— 全部在一个飞书会话中完成。

## 功能

Agent 团队是单个会话内的**运行时**团队体验：

- **主导 Agent**接到你的需求，决定需要哪些专家。
- 主导 Agent 通过 `Agent` 工具派遣**队友**（前端、后端、Reviewer 等）。队友以子 Agent 形式运行在同一个会话进程下。
- 队友跨多轮可寻址：主导 Agent 用 `SendMessage` 路由任务、请队友汇报，并汇总结果。
- 所有交互都在一个飞书会话中 —— 你和主导 Agent 对话，主导 Agent 协调团队。

这是 [MetaSkill](metaskill.md) 的运行时对应：MetaSkill *生成* Agent 团队的配置（CLAUDE.md / AGENTS.md + skills），Agent 团队负责*运行*它。

## 用法

让主导 Agent 派出队友即可，不需要特殊命令 —— 把团队和工作描述出来：

```
你来当主导工程师。并行派出一个前端专家和一个后端专家：
前端负责 React UI 改造，后端加上新的 /api/reports 接口，
你负责 review 两边的 PR，全部通过后再合并。
```

```
派出一个研究员和一个写手队友。研究员从 MetaMemory 和网络
收集竞品 X 的定价策略；写手整理成一页纸。完成后交付。
```

如果你的 Bot 已经通过 `/metaskill` 生成了团队，里面的 orchestrator 就是主导 Agent —— 直接描述目标即可。

## 工作原理

- **每个会话一个常驻进程。**第 1 轮派出的队友，几小时后第 N 轮仍可寻址。原因是每个会话有一个长生命周期的 Claude 进程（见 [CLAUDE.md 中的说明](https://github.com/xvirobotics/metabot/blob/main/CLAUDE.md#persistent-claude-process-per-chat-stage-4--opt-in)）。如果没有这个机制，每轮都重新启动子进程，所有队友会被销毁。
- **Agent 工具派遣队友。**主导 Agent 用 Claude 原生的 `Agent` 工具加 `team_name=` 参数派出队友。队友继承同样的工作目录和工具集。
- **跨 Agent 消息。**队友和主导 Agent 通过 `SendMessage` 交换消息。回复会排队，接收方就绪后投递。
- **后台活动展示。**用户轮之间的队友进度，会在飞书以合并后的"Agent activity"卡片呈现（30 秒去抖，避免快速交互时刷屏）。

## 当前限制

- **专属团队面板即将上线。**专门的 `🧑‍🤝‍🧑 Team` 面板（队友列表带忙/闲图标 + 共享任务列表）渲染逻辑已经写好，但上游 SDK 的 hooks（`TaskCreated` / `TaskCompleted` / `TeammateIdle`）目前还不稳定触发。当前队友活动展示在运行期的**Agent activity 卡片**中。
- **仅 Claude 引擎。**队友派遣依赖 Claude 原生 `Agent` 工具，Kimi 和 Codex Bot 暂不支持 Agent 团队。
- **每个会话一个主导 Agent。**单会话单进程，只能有一个主导 Agent。需要并行运行多个独立团队时，用不同的飞书会话（或 [peers](peers.md)）。
- **预算共享。**所有队友共享同一个会话的 token 预算，重并行任务会快速计入 `maxBudgetUsd`。

## 相关

- [MetaSkill](metaskill.md) — 先用它生成团队配置，再运行
- [目标循环](goal-loops.md) — 给团队一个跨多轮的目标
- [Peers 联邦](peers.md) — 把团队跑在不同 MetaBot 实例上，跨实例路由
