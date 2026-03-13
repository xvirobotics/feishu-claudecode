# 聊天命令

在飞书或 Telegram 中发送给 MetaBot 的命令。

## 可用命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除会话 — 开始全新对话 |
| `/stop` | 中止当前任务 |
| `/status` | 查看会话信息（会话 ID、工作目录） |
| `/memory list` | 浏览 MetaMemory 知识库目录 |
| `/memory search 关键词` | 搜索 MetaMemory 知识库 |
| `/sync` | 触发 MetaMemory → 飞书知识库同步 |
| `/sync status` | 查看知识库同步统计 |
| `/help` | 显示可用命令 |
| `/metaskill ...` | 生成 Agent 团队、Agent 或 Skill |
| `/metabot` | 加载 Agent 总线文档（调度、Bot 管理、跨实例对话） |
| `/任意命令` | 非内置命令自动转发给 Claude Code 作为 skill |

## 说明

- **群聊**中，Bot 仅在被 **@提及** 时响应（2 人群除外）
- **私聊**中，Bot 回复所有消息
- `/memory` 和 `/sync` 等命令直接快速响应，无需启动 Claude
- `/metaskill` 和 `/metabot` 是按需加载到 Claude 上下文的 skill
