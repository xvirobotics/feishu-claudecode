# Peers 联邦

跨实例 Bot 发现和任务路由。连接多个 MetaBot 实例 — 同机或远程服务器。

## 概述

Peers 实现了**联邦架构**，多个 MetaBot 实例可以互相发现 Bot 并自动路由任务。适用于：

- 同一台机器上多个用户运行各自的 MetaBot 实例
- 团队在不同服务器上部署 MetaBot
- 跨环境共享专用 Bot

## 工作原理

1. **发现** — 每个实例定期拉取 peer 的 `GET /api/bots`（每 30 秒）
2. **缓存** — Bot 列表本地缓存，快速查找
3. **路由** — 本地找不到的 Bot 名自动转发到对应 peer
4. **防循环** — 转发请求带 `X-MetaBot-Origin` header 防止循环委派
5. **防传递** — 来自 peer 的 Bot 不会再传播（无 transitive 转发）

## 配置

=== "bots.json"

    ```json
    {
      "feishuBots": [{ "..." }],
      "peers": [
        {
          "name": "alice",
          "url": "http://localhost:9200",
          "secret": "alice-api-secret"
        },
        {
          "name": "bob",
          "url": "http://192.168.1.50:9100",
          "secret": "bob-api-secret"
        }
      ]
    }
    ```

=== "环境变量"

    ```bash
    METABOT_PEERS=http://localhost:9200,http://192.168.1.50:9100
    METABOT_PEER_SECRETS=alice-secret,bob-secret
    METABOT_PEER_NAMES=alice,bob
    METABOT_PEER_POLL_INTERVAL_MS=30000
    ```

`secret` 字段是对方的 `API_SECRET` — 对方开启认证时需要。

Peer 名称可选。未指定时从 URL 自动推导（如 `localhost-9200`）。

## 限定名

使用 `peerName/botName` 语法精确路由：

```bash
# 自动路由 — 先查本地，再按顺序查 peer
mb talk backend-bot chatId "修复这个 bug"

# 指定 peer — 直接路由到 alice 的 backend-bot
mb talk alice/backend-bot chatId "修复这个 bug"
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/peers` | 列出 peer 及健康状态 |
| `GET` | `/api/bots` | 列出所有 Bot（本地 + peer） |
| `POST` | `/api/talk` | 与 Bot 对话（自动路由到 peer） |

## CLI

```bash
mb peers                            # 列出 peer 及状态
mb bots                             # 列出所有 Bot（含 peer）
mb talk alice/bot chatId "prompt"   # 指定 peer 的 Bot 对话
```

## 健康监控

每 30 秒拉取一次 peer 状态。`GET /api/peers` 返回健康信息：

```json
[
  {
    "name": "alice",
    "url": "http://localhost:9200",
    "healthy": true,
    "lastChecked": 1710000000000,
    "lastHealthy": 1710000000000,
    "botCount": 3
  }
]
```

不健康的 peer 在下次拉取时重试。不可达时清空缓存的 Bot 列表。
