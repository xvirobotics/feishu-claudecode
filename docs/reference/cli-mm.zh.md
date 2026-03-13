# mm CLI（MetaMemory）

`mm` 命令提供终端访问 MetaMemory。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/mm`。

## 读取命令

```bash
mm search "部署指南"                 # 全文搜索
mm list                             # 列出文档
mm folders                          # 文件夹树
mm path /projects/my-doc            # 按路径获取文档
```

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
