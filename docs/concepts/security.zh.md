# 安全

MetaBot 以 `bypassPermissions` 模式运行 Claude Code — 无交互式确认。请了解其影响。

## 权限模型

Claude 对 Bot 配置的工作目录拥有 **完整读写执行权限**。没有交互式终端做权限提示，所有工具调用自动批准。

## 访问控制

控制谁可以使用你的 Bot：

- **飞书** — 通过飞书开发者控制台设置应用可见范围、群成员管理和组织级控制
- **Telegram** — 配置 Bot 隐私模式和群访问

## 费用限制

使用 `maxBudgetUsd`（在 `bots.json` 中每个 Bot 设置，或通过 `CLAUDE_MAX_BUDGET_USD` 环境变量）限制每次请求的费用上限。

## API 认证

在 `.env` 中设置 `API_SECRET` 启用 Bearer Token 认证：

```bash
API_SECRET=your-secret-token
```

所有 API 请求需要带上：
```
Authorization: Bearer your-secret-token
```

## MetaMemory 访问控制

MetaMemory 支持 **文件夹级 ACL**，双角色访问：

| Token | 访问权限 |
|-------|---------|
| `MEMORY_ADMIN_TOKEN` | 完整访问 — 可见所有文件夹（private 和 shared） |
| `MEMORY_TOKEN` | 读者访问 — 仅可见 `visibility: shared` 的文件夹 |

锁定文件夹：
```bash
curl -X PUT http://localhost:8100/api/folders/:id \
  -H "Authorization: Bearer $MEMORY_ADMIN_TOKEN" \
  -d '{"visibility": "private"}'
```

## 建议

1. **限制工作目录** — 给每个 Bot 只分配需要的目录
2. **设置 `maxBudgetUsd`** — 为每次请求设置合理的费用上限
3. **启用 `API_SECRET`** — 生产环境务必设置
4. **监控 Agent 活动** — 流式卡片实时展示每一步工具调用
5. **使用 MetaMemory ACL** — 敏感知识文件夹设为 private
