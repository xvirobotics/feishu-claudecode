# 贡献指南

感谢你对 MetaBot 的关注！

## 开发环境

```bash
# 1. 克隆仓库
git clone https://github.com/xvirobotics/metabot.git
cd metabot

# 2. 安装依赖
npm install

# 3. 复制环境配置
cp .env.example .env
# 编辑 .env 填入凭证

# 4. 构建
npm run build

# 5. 开发模式运行
npm run dev
```

**前置条件：** Node.js 20+，Claude Code CLI 已安装并认证。

## 开发命令

```bash
npm run dev          # 热重载开发服务器（tsx）
npm test             # 运行测试（vitest）
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
npm run build        # TypeScript 编译到 dist/
```

## 如何贡献

### 报告 Bug

- 使用 [Bug Report](https://github.com/xvirobotics/metabot/issues/new?template=bug_report.md) 模板
- 附上日志（脱敏处理）和复现步骤

### 功能建议

- 使用 [Feature Request](https://github.com/xvirobotics/metabot/issues/new?template=feature_request.md) 模板
- 描述使用场景，而非仅描述方案

### 提交 PR

1. Fork 仓库，从 `main` 创建分支
2. 清晰的 commit 信息
3. 确保 `npm run build` 通过
4. 运行 `npm test` 和 `npm run lint`
5. 提交 PR 并清晰描述改了什么、为什么

## 代码风格

- TypeScript 严格模式
- 使用 `async/await` 而非原始 Promise
- 函数保持小且专注
- ESM 导入使用 `.js` 扩展名
