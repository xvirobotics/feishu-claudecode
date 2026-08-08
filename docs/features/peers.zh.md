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

通过**任一种**方式配置即可 — 也可以两种混用（按 URL 自动去重合并）：

=== "环境变量 (.env)"

    最简单的方式 — 直接加到 `.env` 文件。单 Bot 和多 Bot 模式都支持。

    ```bash
    METABOT_PEERS=http://localhost:9200,http://192.168.1.50:9100
    METABOT_PEER_SECRETS=alice-secret,bob-secret
    METABOT_PEER_NAMES=alice,bob
    ```

    - `METABOT_PEERS` — 逗号分隔的 peer URL 列表（必填）
    - `METABOT_PEER_SECRETS` — 逗号分隔的 Bridge API 密钥，按位置与 URL 对应（非健康检查 peer API 调用必需）
    - `METABOT_PEER_NAMES` — 逗号分隔的显示名称（可选，不填会从 URL 自动推导，如 `localhost-9200`）

=== "bots.json"

    如果你已经使用 `bots.json` 进行多 Bot 配置，可以在同一个文件里添加 peers。

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

    - `name` — peer 的显示名称（必填）
    - `url` — peer 的 API 地址（必填）
    - `secret` — 对方的 `API_SECRET`（非健康检查 peer API 调用必需）

Peer URL 只应暴露在 loopback、私有网络，或自有鉴权 HTTPS 反向代理之后。

!!! tip "不需要 bots.json"
    如果你只运行一个 Bot，直接在 `.env` 加 `METABOT_PEERS` 就行，不需要 `bots.json`。`bots.json` 的 peers 字段只是多 Bot 配置的便利选项。

## 限定名 {#qualified-names}

使用 `peerName/botName` 语法精确路由：

```bash
# 自动路由 — 先查本地，再按顺序查 peer
metabot talk backend-bot chatId "修复这个 bug"

# 指定 peer — 直接路由到 alice 的 backend-bot
metabot talk alice/backend-bot chatId "修复这个 bug"
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/peers` | 列出 peer 及健康状态 |
| `GET` | `/api/bots` | 列出所有 Bot（本地 + peer） |
| `POST` | `/api/talk` | 与 Bot 对话（自动路由到 peer） |

## CLI

```bash
metabot peers                            # 列出 peer 及状态
metabot bots                             # 列出所有 Bot（含 peer）
metabot talk alice/bot chatId "prompt"   # 指定 peer 的 Bot 对话
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
