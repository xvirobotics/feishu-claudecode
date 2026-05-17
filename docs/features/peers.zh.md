# Peers 联邦

跨实例 Bot 发现和任务路由。连接多个 MetaBot 实例 — 同机或远程服务器。

## 概述

Peers 实现了**联邦架构**，多个 MetaBot 实例可以互相发现 Bot 并自动路由任务。适用于：

- 同一台机器上多个用户运行各自的 MetaBot 实例
- 团队在不同服务器上部署 MetaBot
- 跨环境共享专用 Bot

## 工作原理

1. **身份** — 每个实例在 `~/.metabot/identity.json` 中有稳定身份
2. **局域网自动发现** — 同内网的两台实例通过 mDNS（`_metabot._tcp.local`）在启动后约 30 秒内自动互相发现，无需任何配置
3. **拉取轮询** — 每个实例定期拉取 peer 的 `GET /api/bots` 和 `GET /api/skills`（每 30 秒）
4. **缓存** — Bot 和 Skill 列表本地缓存，快速查找
5. **路由** — 本地找不到的 Bot 名自动转发到对应 peer
6. **防循环** — 转发请求带 `X-MetaBot-Origin` header 防止循环委派
7. **防传递** — 来自 peer 的 Bot/Skill 不会再传播（无 transitive 转发）

## 局域网自动发现 (mDNS)

同内网的两台 MetaBot 实例在启动后约 30 秒内自动互相发现，**无需任何 `.env` 配置**。每个实例广播 `_metabot._tcp.local` 服务，TXT 字段包含 `instanceId`、`instanceName`、可选的 `clusterId` 以及 Ed25519 公钥的短 SHA-256 指纹（`pubkeyFp`）。**不广播任何 secret。**

自动发现的 peer 在 `GET /api/peers` 中以 `source: "mdns"` 出现。和现有握手流程合并 —— 通过 `METABOT_PEERS` 或 `bots.json` 配置的静态 peer **在 URL 冲突时优先**（保留预配置的 secret）。

### 控制发现行为

`METABOT_DISCOVERY_MODE`（默认 `auto`）：

- `auto` — 同时广播 + 浏览（默认）
- `static` — 仅浏览，不广播本实例
- `standalone` — 既不广播也不浏览
- `off` — 同 `standalone`

如果不想动 `discoveryMode`，可以单独设置 `METABOT_MDNS_ENABLED=false` 关闭 mDNS。

### 两台机器手工验证

1. 在两台机器各自跑 installer 默认 `.env`（不要配 `METABOT_PEERS`）。
2. 任一台机器上等约 30 秒，运行 `curl http://localhost:9100/api/peers`。
3. 应该能看到另一台，`"source": "mdns"`，`"healthy": true`。
4. `mm peer-search "<query>"` 能直接拿到对方的搜索结果——无需手动交换 secret。

## 自动 Token 握手

两个 MetaBot 实例发现彼此（mDNS 或运行时手动添加）后，会通过 `POST /api/peer-handshake` 自动交换 reader token。每个实例在首次启动时生成一个稳定的 reader token 存到 `~/.metabot/peer-token`，这就是对方读取本机已发布的 memory / skill 所需的唯一凭据。

握手是新装实例零配置互读的唯一路径。通过 `METABOT_PEERS` 或 `bots.json` 配置且显式带 `secret` 的静态 peer 会跳过握手——已配置的 secret 优先。若希望静态 peer 仍能接收你的 reader token（如反向读取），把 `secret` 留空即可。

收到的 token 在 memory-server 里被解析成 Pragmatic v1 **reader principal**，并附带 peer 的 `instanceId`。读权限由 folder visibility 把关——`private` 仍不可读，`shared` 可读。Peer 不能写。详细 ACL 模型见 [federated-memory-skill-hub-plan.md](../internal/federated-memory-skill-hub-plan.md) Phase 2，未来的细粒度读 ACL 见 Phase 7。

### Cluster ID 引导建议

同一个 LAN 上跑多个互相隔离的 MetaBot 集群（如 infra 团队 + 产品团队同一个办公网）时，给每个集群配一个稳定的 `METABOT_CLUSTER_ID`：

```bash
METABOT_CLUSTER_ID=infra-team
```

mDNS 发现只返回 `clusterId` TXT 字段一致的 peer——两个团队在同一网络里也彼此不可见。不设置则进入默认未分组池。

### 动态 Peer 降级

运行时加进来的 peer（mDNS / cluster / manual）连续 5 分钟不可达就会被**降级**——从内存注册表里清掉。这样可以避免离线的笔记本永远堆在 `GET /api/peers` 里。Operator 显式配置的 static peer 永远不会被降级。

通过 `METABOT_DYNAMIC_PEER_DEMOTE_MS`（毫秒）调阈值。

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
    - `METABOT_PEER_SECRETS` — 逗号分隔的密钥，按位置与 URL 对应（可选，peer 设置了 `API_SECRET` 时需要）
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
    - `secret` — 对方的 `API_SECRET`（可选，对方开启认证时需要）

!!! tip "不需要 bots.json"
    如果你只运行一个 Bot，直接在 `.env` 加 `METABOT_PEERS` 就行，不需要 `bots.json`。`bots.json` 的 peers 字段只是多 Bot 配置的便利选项。

### Cluster Bootstrap

内网中可以让每个实例指向一个稳定的 MetaBot/cluster 地址：

```bash
METABOT_CLUSTER_ID=xvirobotics-lan
METABOT_CLUSTER_URL=http://metabot.internal:9100
METABOT_CLUSTER_SECRET=optional-token
```

当前 bootstrap 阶段里，只要 `METABOT_DISCOVERY_MODE` 不是 `off`，`METABOT_CLUSTER_URL` 会自动作为 peer 加入。这样普通部署只需要一个 URL，高级部署仍可继续使用显式 `METABOT_PEERS`。

## 实例 Manifest

每个实例暴露一个低风险 federation manifest：

```bash
curl http://localhost:9100/api/manifest
```

manifest 包含实例 ID/name、公钥、能力标记、endpoint path、memory namespace、可写 memory namespaces、本地/peer Bot 和 Skill 数量，不包含 secret。

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
| `GET` | `/api/manifest` | 实例身份和能力 manifest |
| `GET` | `/api/bots` | 列出所有 Bot（本地 + peer） |
| `GET` | `/api/skills` | 列出所有 Skill（本地 + peer） |
| `POST` | `/api/talk` | 与 Bot 对话（自动路由到 peer） |

## CLI

```bash
mb peers                            # 列出 peer 及状态
mb bots                             # 列出所有 Bot（含 peer）
mb skills                           # 列出所有 Skill（含 peer）
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
    "botCount": 3,
    "source": "mdns",
    "instanceId": "alice-laptop-3f9a12"
  }
]
```

`source` 字段取值：`static`（来自 `METABOT_PEERS` 或 `bots.json`）、`cluster`（来自 `METABOT_CLUSTER_URL`）、`mdns`（局域网自动发现）、`manual`（运行时通过 API 添加）。

不健康的 peer 在下次拉取时重试。不可达时清空缓存的 Bot 列表。
