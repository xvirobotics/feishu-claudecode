# 定时任务调度器

一次性延迟和周期性 cron 任务。支持时区，跨重启持久化，忙时自动重试。

## 概述

调度器让你自动化 Agent 任务：

- **一次性任务** — 延迟执行（如 "30 分钟后"）
- **周期性任务** — cron 调度（如 "工作日早 8 点"）
- **时区感知** — 默认 `Asia/Shanghai`，可按任务配置
- **持久化** — 重启后恢复
- **自动重试** — Bot 忙时重新排队

## 用法

在聊天中用自然语言描述调度需求：

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

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/schedule` | 创建任务 |
| `GET` | `/api/schedule` | 列出任务 |
| `PATCH` | `/api/schedule/:id` | 更新任务 |
| `DELETE` | `/api/schedule/:id` | 取消任务 |
| `POST` | `/api/schedule/:id/pause` | 暂停周期性任务 |
| `POST` | `/api/schedule/:id/resume` | 恢复暂停的任务 |

### 创建周期性任务

```bash
curl -X POST http://localhost:9100/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "botName": "metabot",
    "chatId": "oc_xxx",
    "prompt": "检查服务健康状态并报告",
    "cron": "0 8 * * 1-5",
    "timezone": "Asia/Shanghai"
  }'
```

## CLI

```bash
mb schedule list                                              # 列出全部
mb schedule cron metabot chatId '0 8 * * 1-5' "每日报告"       # 创建 cron
mb schedule pause <id>                                        # 暂停
mb schedule resume <id>                                       # 恢复
```
