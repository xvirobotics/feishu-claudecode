# fd CLI（飞书文档阅读）

`fd` 命令读取飞书文档并转为 Markdown。仅飞书 Bot 可用。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/fd`。

## 命令

```bash
fd read <飞书链接>                    # 按 URL 读取文档（docx 或 wiki）
fd read-id <docId>                  # 按文档 ID 读取
fd info <飞书链接>                    # 获取文档元信息
```

## 选项

| 参数 | 说明 |
|------|------|
| `--bot <name>` | 指定使用哪个 Bot 的凭证 |

## 支持的链接格式

- `https://xxx.feishu.cn/docx/xxxxx` — 独立 docx
- `https://xxx.feishu.cn/wiki/xxxxx` — 知识库页面
- `https://xxx.larksuite.com/docx/xxxxx` — Lark docx
- `https://xxx.larksuite.com/wiki/xxxxx` — Lark 知识库

## 示例

```bash
fd read https://your-org.feishu.cn/docx/ABC123
```

输出为 Markdown 文本，打印到 stdout。
