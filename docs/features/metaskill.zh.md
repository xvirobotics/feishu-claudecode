# MetaSkill

Agent 工厂。一条命令生成完整的 Agent 团队、单个 Agent 或自定义 Skill。

## 功能

`/metaskill` 会调研最佳实践，然后生成完整的 `.claude/` Agent 配置：

- **Orchestrator** — 协调团队的主 Agent
- **专家 Agent** — 特定领域的 Agent（前端、后端、运维等）
- **Code Reviewer** — 审查 PR 和代码质量
- **Skills** — 扩展 Agent 能力的自定义技能

生成的 Agent 通过 MetaMemory 实现跨会话的知识共享。

## 用法

在聊天中发送 `/metaskill` 加你的需求：

```
/metaskill 给这个 React Native 项目创建一个 agent 团队 ——
我需要一个前端专家、一个后端 API 专家、一个 code reviewer。
```

```
/metaskill 创建一个 skill，能读取我们的 Jira 看板并汇总待办事项。
```

## 工作原理

1. Claude 调研项目结构和最佳实践
2. 生成 `.claude/` 配置文件（agents、skills、settings）
3. 保存到 Bot 的工作目录
4. 新 Agent/Skill 立即可用

## 输出

MetaSkill 在 `.claude/` 目录下生成文件：

```
.claude/
├── agents/
│   ├── orchestrator.md
│   ├── frontend.md
│   ├── backend.md
│   └── reviewer.md
├── skills/
│   └── custom-skill/
│       └── SKILL.md
└── settings.json
```
