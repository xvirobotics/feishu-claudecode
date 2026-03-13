# 飞书文档阅读

读取飞书文档（独立 docx 和知识库页面）并转为 Markdown。

## 概述

用户在聊天中分享飞书文档链接时，Claude 可以自动读取内容。支持：

- **独立 docx 文档**
- **知识库页面**
- **块类型**：标题、代码块、列表、表格、引用、待办、行内格式

## 用法

在聊天中分享飞书链接，Claude 会自动读取。也可以使用 CLI：

```bash
fd read <飞书链接>                    # 按 URL 读取文档
fd read-id <docId>                  # 按文档 ID 读取
fd info <飞书链接>                    # 获取文档元信息
```

## 支持的链接格式

- `https://xxx.feishu.cn/docx/xxxxx` — 独立 docx
- `https://xxx.feishu.cn/wiki/xxxxx` — 知识库页面
- `https://xxx.larksuite.com/docx/xxxxx` — Lark docx
- `https://xxx.larksuite.com/wiki/xxxxx` — Lark 知识库

## API

```
GET /api/feishu/document?url=<飞书链接>&botName=<名称>
GET /api/feishu/document?docId=<id>&botName=<名称>
```

## 配置

| 变量 | 说明 |
|------|------|
| `FEISHU_SERVICE_APP_ID` | 专用飞书应用（回退到第一个 Bot） |
| `FEISHU_SERVICE_APP_SECRET` | 服务应用密钥 |

## 所需飞书权限

- `docx:document:readonly` — 读取文档
- `wiki:wiki` — 读取知识库页面
