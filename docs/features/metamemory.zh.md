# MetaMemory

内嵌知识库，全文搜索。Agent 跨会话读写 Markdown 文档，所有 Agent 共享。

## 概述

MetaMemory 是基于 **SQLite 的文档存储**（使用 FTS5 全文搜索），为所有 Agent 提供持久化知识。

- **文档** 是 Markdown 文件，按文件夹树组织
- **全文搜索** 基于 SQLite FTS5
- **Web UI** 在 `http://localhost:8100` 浏览和搜索
- **REST API** 程序化访问
- **CLI**（`mm`）终端访问

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
mm list                             # 列出文档
mm folders                          # 文件夹树
mm path /projects/my-doc            # 按路径获取文档

# 写
echo '# 笔记' | mm create "标题" --folder ID --tags "dev"
echo '# 更新内容' | mm update DOC_ID
mm mkdir "new-folder"               # 创建文件夹
mm delete DOC_ID                    # 删除文档
```

## 访问控制

MetaMemory 支持文件夹级 ACL：

| Token | 访问权限 |
|-------|---------|
| `MEMORY_ADMIN_TOKEN` | 完整访问 — 可见所有文件夹 |
| `MEMORY_TOKEN` | 读者访问 — 仅可见 shared 文件夹 |

详见[安全](../concepts/security.md#metamemory-访问控制)。

## 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `MEMORY_ENABLED` | `true` | 启用 MetaMemory |
| `MEMORY_PORT` | `8100` | MetaMemory 端口 |
| `MEMORY_ADMIN_TOKEN` | — | 管理员 Token（完整访问） |
| `MEMORY_TOKEN` | — | 读者 Token（仅 shared） |
| `META_MEMORY_URL` | `http://localhost:8100` | MetaMemory 地址（CLI 用） |

## 自动同步到知识库

MetaMemory 变更可以自动同步到飞书知识库。详见 [Wiki 同步](wiki-sync.md)。
