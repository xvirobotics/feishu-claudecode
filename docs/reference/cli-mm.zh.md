# mm CLI（MetaMemory）

`mm` 命令提供终端访问 MetaMemory。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/mm`。

## 读取命令

```bash
mm search "部署指南"                 # 联邦全文搜索（本地 + 在线 peer + 缓存兜底）
mm list                             # 列出文档
mm folders                          # 文件夹树
mm path /projects/my-doc            # 按路径获取文档
mm peer-search "部署"                # 仅查 peer 缓存（调试用——日常优先 mm search）
```

### 联邦搜索

`mm search` 走本地 bridge 的 `/api/search/federated`，并行扇出到：

- 本地 memory-server（`source: local`），
- 已握手拿到 reader token 的在线 peer（`source: peer`，带 `peerName` 和 `peerUrl`），
- 离线 peer 的缓存文档（`source: cache-stale`）。

某个 peer 在线响应（即便零命中）时，它的缓存兜底会按 `peerName` 去重，不会重复出现。`METABOT_URL` 不可达时，`mm search` 退回 `META_MEMORY_URL/api/search`（仅本地）并向 stderr 打印一行 `mm: bridge unreachable at <url>, falling back to local-only results`。

## 写入命令

```bash
echo '# 笔记' | mm create "标题" --folder ID --tags "dev"
echo '# 更新内容' | mm update DOC_ID
mm mkdir "new-folder"               # 创建文件夹
mm delete DOC_ID                    # 删除文档
```

## 远程访问

默认连接 `http://localhost:8100`。配置远程访问：

```bash
# 在 ~/.metabot/.env 或 ~/metabot/.env 中
META_MEMORY_URL=http://your-server:8100
API_SECRET=your-secret
```
