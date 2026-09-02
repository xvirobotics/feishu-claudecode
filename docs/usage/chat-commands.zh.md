# 聊天命令

在飞书或 Telegram 中发送给 MetaBot 的命令。

## 可用命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除会话 — 开始全新对话 |
| `/stop` | 中止当前任务 |
| `/status` | 查看会话信息（会话 ID、工作目录） |
| `/model` | 查看或切换当前引擎和模型；使用 `/model list` 查看可用选项 |
| `/effort low\|medium\|high\|xhigh\|max\|ultra` | 设置本聊天的 Codex 推理强度；使用 `/effort reset` 清除覆盖设置 |
| `/resume` | 列出并切换到此前的 Claude、Codex 或 Kimi 会话；`/resume <id>` 可按 ID 前缀直接恢复 |
| `/goal <条件>` | 设置目标，Agent 跨多轮持续推进直到达成。`/goal clear` 停止。 |
| `/background <提示词>` | 在继续聊天的同时后台运行任务；使用 `/background list\|logs <id>\|stop <id>` 管理 Codex 后台任务 |
| `/memory list` | 浏览 MetaMemory 知识库目录 |
| `/memory search 关键词` | 搜索 MetaMemory 知识库 |
| `/sync` | 触发 MetaMemory → 飞书知识库同步 |
| `/sync status` | 查看知识库同步统计 |
| `@Bot /group-reply mention\|all\|status` | 查看或修改飞书群中当前 Bot 的回复模式 |
| `/help` | 显示可用命令 |
| `/metaskill ...` | 生成 Agent 团队、Agent 或 Skill |
| `/metabot` | 加载 Agent 总线文档（调度、Bot 管理、跨实例对话） |
| `/任意命令` | 非内置命令自动转发给当前 Agent 引擎作为 skill |

## 说明

- **私聊**中，Bot 回复所有消息
- `/memory` 和 `/sync` 等命令直接快速响应，无需启动 Claude
- `/metaskill` 和 `/metabot` 是按需加载到 Claude 上下文的 skill

## 飞书群聊行为

### 回复模式与 @提及路由 {#group-reply-modes}

每个飞书 Bot 默认按以下规则回复：

| 场景 | 默认模式 | 说明 |
|------|---------|------|
| **私聊** | 回复全部消息 | 群回复模式不适用 |
| **两人群**（你 + Bot） | `all` | 自动识别为类私聊，无需 @ |
| **多人群聊** | `mention` | 只有准确 @ 当前 Bot 的消息才会触发回复 |

群主可以单独覆盖某个 Bot 在某个群中的默认模式：

```text
@MetaBot /group-reply mention  # 只有 @ 当前 Bot 时才回复
@MetaBot /group-reply all      # 回复群里的所有消息
@MetaBot /group-reply status   # 查看当前模式及其来源
```

中文别名支持相同操作：`@MetaBot /群回复 仅@`、`@MetaBot /群回复 全部`、
`@MetaBot /群回复 状态`。

群内路由是精确的：命令必须 @ 当前 Bot。裸发 `/group-reply ...`，或只 @
了其他 Bot 的命令，当前 Bot 都会忽略，避免同一群里的多个 MetaBot Agent
被一条命令同时改写。普通消息按选定模式处理；在 `mention` 模式下，@
其他用户或其他 Bot 不算 @ 当前 Bot。

只有飞书群主可以执行 `mention` 或 `all` 修改模式，所有群成员都可以执行
`status`。MetaBot 通过公开的 Lark 群信息 API 校验群主身份，并采用失败关闭
策略：查询失败或应用权限不足时不会修改模式。请确保应用已开通
`im:chat:readonly` 权限。

设置按 **Bot + 群聊** 保存到本地，重启后仍然有效。群内显式设置优先于
Bot 的 `groupNoMention` 配置和“两人群视为私聊”的默认规则。例如，
`mention` 会让两人群也必须 @Bot；`all` 会让多人群无需 @ 当前 Bot。

!!! tip "推荐：建两人群"
    建一个只有你和 Bot 的两人群聊。无需 @Bot 即可对话，还能享受群聊功能（置顶、分类管理等）。

### 在群聊中发送文件和图片

在 `mention` 模式下，飞书上传文件/图片时无法同时 @Bot（尤其是手机端）。
MetaBot 支持 **先传后 @**：

1. 先在群里上传文件或图片（不用 @ 任何人）
2. **5 分钟**内 @Bot 说「分析一下」或任何指令
3. Bot 自动把你之前上传的文件附上一起处理

```
[上传 report.pdf]          ← 先传文件
[上传 screenshot.png]      ← 可以传多个
@MetaBot 帮我分析这些文件   ← 再 @Bot，文件自动附上
```

在 `all` 模式下，未 @ 的文件和图片会立即处理；在 `mention` 模式下，
它们会缓存到下一条 @Bot 指令。私聊也会直接处理；两人群默认直接处理，
但如果显式切换为 `mention`，则同样需要先传后 @。

### 智能合并

连续发送多个文件或图片（2 秒内），会自动合并为一次请求。所有聊天类型均支持。
