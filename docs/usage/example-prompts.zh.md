# 示例提示词

直接在飞书/Telegram 中发送这些 prompt，解锁 MetaBot 高级功能。

## MetaMemory — 持久化知识库

```
把我们刚讨论的部署方案写入 MetaMemory，放到 /projects/deployment 下面。
```

```
搜索一下 MetaMemory 里有没有关于 API 设计规范的文档。
```

```
总结今天 code review 的结论，保存到 MetaMemory，方便团队以后查阅。
```

## MetaSkill — Agent 与 Skill 工厂

```
/metaskill 给这个 React Native 项目创建一个 agent 团队 ——
我需要一个前端专家、一个后端 API 专家、一个 code reviewer。
```

```
/metaskill 创建一个 skill，能读取我们的 Jira 看板并汇总待办事项。
```

## 定时任务 — 自动化调度

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

## Agent-to-Agent — 跨 Agent 协作

```
把这个 bug 委派给 backend-bot 处理："修复 /api/users/:id 接口的空指针异常，
错误日志在 MetaMemory /logs/errors 里"。
```

```
让 frontend-bot 更新仪表盘 UI，同时让 backend-bot 加上新的 API 接口。
两边都把进度记录到 MetaMemory 的 /projects/dashboard 下。
```

## 组合工作流

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
