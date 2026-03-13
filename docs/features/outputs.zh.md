# 输出文件

Claude 生成的输出文件（图片、PDF、文档等）会自动发送给聊天中的用户。

## 工作原理

1. **每次对话独立目录** — 每次执行前在 `/tmp/metabot-outputs/<chatId>/` 创建新目录
2. **系统提示注入** — 告诉 Claude 将输出文件 `cp` 到该目录
3. **执行后扫描** — 执行完成后扫描目录并发送所有文件
4. **文件类型路由** — 图片通过图片 API 上传，其他文件通过文件 API 上传

## 文件类型支持

| 类型 | 扩展名 | 飞书 API | 大小限制 |
|------|--------|---------|---------|
| 图片 | png, jpg, gif, webp, bmp, tiff | `im.v1.image.create` | 10 MB |
| 文件 | pdf, docx, zip, xlsx, pptx 等 | `im.v1.file.create` | 30 MB |

## 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `outputsBaseDir` | `/tmp/metabot-outputs` | 输出文件基目录（`bots.json` 中按 Bot 配置） |

## 回退机制

旧的图片检测方式（追踪 `Write` 工具文件路径 + 响应文本正则匹配）仍作为回退，处理未放入输出目录的图片。
