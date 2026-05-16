# MetaMemory

内嵌知识库，全文搜索。Agent 跨会话读写 Markdown 文档；在内网联邦部署中，每个 MetaBot 实例默认写自己的 namespace，同时读取共享知识。

## 概述

MetaMemory 是基于 **SQLite 的文档存储**（使用 FTS5 全文搜索），为所有 Agent 提供持久化知识。

- **文档** 是 Markdown 文件，按文件夹树组织
- **全文搜索** 基于 SQLite FTS5
- **Web UI** 在 `http://localhost:8100?token=YOUR_TOKEN` 浏览和搜索
- **REST API** 程序化访问
- **CLI**（`mm`）终端访问
- **实例 namespace** 支持内网/联邦部署

## Agent 如何使用

Claude 通过 `metamemory` skill 自主读写知识文档。当用户说"记住这个"或 Claude 需要持久化知识时，它会调用 memory API。

```
把我们刚讨论的部署方案写入 MetaMemory，放到 /projects/deployment 下面。
```

```
搜索一下 MetaMemory 里有没有关于 API 设计规范的文档。
```

## 聊天命令

| 命令 | 说明 |
|------|------|
| `/memory list` | 浏览知识库目录 |
| `/memory search 关键词` | 搜索知识库 |
| `/memory status` | 查看 MetaMemory 状态 |

这些命令直接通过 `MemoryClient` HTTP 客户端响应，无需启动 Claude。

## CLI（`mm`）

```bash
# 读
mm search "部署指南"                 # 全文搜索
mm peer-search "部署指南"            # 搜索缓存的 peer memory
mm list                             # 列出文档
mm folders                          # 文件夹树
mm path /projects/my-doc            # 按路径获取文档
mm peer-get alice DOC_ID            # 读取缓存的 peer 文档

# 写
echo '# 笔记' | mm create "标题" --folder ID --tags "dev"
echo '# 更新内容' | mm update DOC_ID
mm mkdir "new-folder"               # 创建文件夹
mm delete DOC_ID                    # 删除文档
```

## Web UI 访问

配置了认证（`API_SECRET`、`MEMORY_ADMIN_TOKEN` 或 `MEMORY_TOKEN`）后，Web UI 需要 Token。通过 URL 参数传递：

```
http://localhost:8100?token=YOUR_TOKEN
```

启动日志会打印带 Token 的完整 URL。Token 会保存到浏览器的 `localStorage`，只需传递一次。也可以在 Web UI 的设置图标中设置或清除 Token。

## 访问控制

MetaMemory 支持文件夹级 ACL 和实例级 scoped token：

| Token | 访问权限 |
|-------|---------|
| `MEMORY_ADMIN_TOKEN` | 完整访问 — 可见所有文件夹 |
| `MEMORY_TOKEN` | 读者访问 — 仅可见 shared 文件夹 |
| `MEMORY_INSTANCE_TOKEN` | 实例访问 — 可写实例 namespace 以及已配置的 bot/project namespace，可读 shared 文件夹 |

每个 MetaBot 实例会从 `~/.metabot/identity.json` 获得稳定身份。默认可写 namespace：

```text
/instances/<instanceId>
```

这样多台开发机可以共享一个 MetaMemory 服务，同时避免每个实例都能写入别人的空间。管理员 token 仍保留完整访问权限，用于维护和迁移。

详见[安全](../concepts/security.md#metamemory-访问控制)。

## 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `MEMORY_ENABLED` | `true` | 启用 MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory 端口 |
| `MEMORY_ADMIN_TOKEN` | — | 管理员 Token（完整访问） |
| `MEMORY_TOKEN` | — | 读者 Token（仅 shared） |
| `MEMORY_INSTANCE_TOKEN` | — | 当前实例以及已配置 bot/project namespace 的 scoped token |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 地址（CLI 用） |
| `METABOT_MEMORY_NAMESPACE` | `/instances/<instanceId>` | 当前实例兜底 namespace |
| `METABOT_BOT_MEMORY_NAMESPACE` | `/bots/default` | 单 Bot 稳定 namespace 覆盖 |
| `METABOT_MEMORY_PROJECT` | — | 单 Bot 项目名；推导 `/projects/<slug>` |
| `METABOT_MEMORY_WRITE_NAMESPACES` | — | 额外可写 namespace，逗号分隔 |
| `METABOT_PEER_MEMORY_CACHE_ENABLED` | `true` | 将 peer MetaMemory 文档镜像到本地只读 cache |
| `METABOT_PEER_MEMORY_CACHE_LIMIT` | `200` | 每次 peer 拉取最多镜像的 memory 文档数 |

## 稳定项目 Namespace

MetaBot 保留 `/instances/<instanceId>` 作为安全兜底，但 bot 自己长期维护的知识应该使用重装机器也不变的稳定 namespace。在 `bots.json` 中可以设置：

```json
{
  "name": "metabot",
  "memoryProject": "metabot"
}
```

它会推导出 `/projects/metabot`。也可以显式指定：

```json
{
  "name": "metabot",
  "memoryNamespace": "/projects/metabot"
}
```

如果两个字段都没设置，bot 默认使用 `/bots/<botName>`。`MEMORY_INSTANCE_TOKEN` 会自动获得实例兜底 namespace 以及所有已配置 bot/project namespace 的写权限。

## Peer 镜像

配置 peers 后，MetaBot 会把可读的 peer MetaMemory 文档镜像到本地 peer artifact cache。镜像是只读的，owner 实例仍是 source of truth。某台开发机离线后，其他 MetaBot 仍可以搜索缓存的 peer memory：

```bash
mm peer-search "cluster bootstrap"
mm peer-get alice DOC_ID
```

API 为 `GET /api/peer-memory/search?q=` 和 `GET /api/peer-memory/documents/:peerName/:docId`。

## 自动同步到知识库

MetaMemory 变更可以自动同步到飞书知识库。详见 [Wiki 同步](wiki-sync.md)。
