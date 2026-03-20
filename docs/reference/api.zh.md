# REST API 参考

MetaBot 在端口 `9100`（通过 `API_PORT` 配置）暴露 REST API。

## 认证

如设置了 `API_SECRET`，所有请求需要：

```
Authorization: Bearer <API_SECRET>
```

## 端点

### 健康与信息

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查（含 Bot 数、peer 状态） |
| `GET` | `/api/stats` | 费用与使用统计（按 Bot/用户） |
| `GET` | `/api/metrics` | Prometheus 监控指标 |

### Bot 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/bots` | 列出所有 Bot（本地 + peer） |
| `POST` | `/api/bots` | 运行时创建 Bot |
| `GET` | `/api/bots/:name` | 获取 Bot 详情 |
| `DELETE` | `/api/bots/:name` | 删除 Bot |

### Agent 对话

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/talk` | 与 Bot 对话（自动路由到 peer） |

**请求体：**

```json
{
  "botName": "metabot",
  "chatId": "unique-chat-id",
  "prompt": "你的消息"
}
```

`botName` 字段支持[限定名](../features/peers.md#限定名)：`peerName/botName`。

!!! note "已弃用的别名"
    `POST /api/tasks` 仍可用但已弃用。请使用 `/api/talk`。

### Peers

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/peers` | 列出 peer 及健康状态 |

### 定时调度

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/schedule` | 创建一次性或周期性任务 |
| `GET` | `/api/schedule` | 列出定时任务 |
| `PATCH` | `/api/schedule/:id` | 更新定时任务 |
| `DELETE` | `/api/schedule/:id` | 取消定时任务 |
| `POST` | `/api/schedule/:id/pause` | 暂停周期性任务 |
| `POST` | `/api/schedule/:id/resume` | 恢复暂停的任务 |

**创建定时任务请求体：**

```json
{
  "botName": "metabot",
  "chatId": "oc_xxx",
  "prompt": "检查服务健康状态",
  "cron": "0 8 * * 1-5",
  "timezone": "Asia/Shanghai"
}
```

一次性任务用 `delayMs` 替代 `cron`：

```json
{
  "botName": "metabot",
  "chatId": "oc_xxx",
  "prompt": "提醒我关于部署的事",
  "delayMs": 1800000
}
```

### Wiki 同步

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sync` | 触发 MetaMemory → 知识库同步 |
| `GET` | `/api/sync` | 同步状态 |
| `POST` | `/api/sync/document` | 按 ID 同步单个文档 |

### 文字转语音

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tts` | 文字转语音（返回 MP3 音频） |

**请求体：**

```json
{
  "text": "你好世界",
  "provider": "doubao",
  "voice": "zh_female_wanqudashu_moon_bigtts"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `text` | 是 | 要转换的文本 |
| `provider` | 否 | `doubao`、`openai` 或 `elevenlabs`（根据已配置密钥自动选择） |
| `voice` | 否 | 声音/音色 ID（各服务商有默认值） |

**响应：** `audio/mpeg` 二进制数据，附带 `X-Text-Length`、`X-Provider`、`X-Voice` 响应头。

### 飞书文档

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/feishu/document` | 读取飞书文档并转为 Markdown |

**查询参数：**

- `url` — 飞书文档 URL，或
- `docId` — 文档 ID
- `botName` — Bot 名称（用于凭证）
