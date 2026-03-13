# MetaBot 贡献指南

感谢你对 MetaBot 项目的关注！本指南涵盖了开始贡献所需的一切 —— 无论你是人类开发者还是 AI 智能体。

**[English version / 英文版](./CONTRIBUTING.md)**

## 行为准则

我们致力于为每个人提供友好和尊重的环境。请保持善意、建设性沟通，并假定他人出于好意。不容忍骚扰、歧视和人身攻击。

## 前置要求

| 工具 | 版本 | 说明 |
|------|------|------|
| Node.js | 20+ | 运行环境 |
| npm | 10+ | 包管理器 |
| Git | 2.x+ | 版本控制 |
| Claude Code CLI | latest | `npm i -g @anthropic-ai/claude-code` — 需要完成认证 |
| 飞书开发者账号 | — | 可选，仅在测试机器人集成时需要 |

## 快速开始

```bash
# 1. Fork 并克隆
git clone https://github.com/<your-username>/metabot.git
cd metabot

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的飞书应用凭证（详见 CLAUDE.md 中的配置指南）

# 4. 构建
npm run build

# 5. 运行测试
npm test

# 6. 启动开发服务器（热重载）
npm run dev
```

### 验证环境

成功的环境配置应如下所示：

```bash
npm run build    # 无错误
npm test         # 所有测试套件通过
npm run lint     # 无 lint 错误
```

## 项目架构

### 消息流

```
飞书 WSClient
  -> EventHandler（解析消息，@提及过滤）
    -> MessageBridge（路由命令，管理任务）
      -> ClaudeExecutor（Agent SDK 查询）
        -> StreamProcessor（转换为卡片状态）
          -> 飞书卡片更新（流式）
```

### 模块概览

| 目录 | 用途 |
|------|------|
| `src/bridge/` | 消息路由、任务管理、限流、输出管理 |
| `src/claude/` | Claude Agent SDK 集成、会话管理、流式处理 |
| `src/feishu/` | 飞书 API 客户端、卡片构建、消息发送、文档读取 |
| `src/memory/` | MetaMemory 服务端客户端 |
| `src/sync/` | Wiki 同步（MetaMemory -> 飞书 Wiki） |
| `src/utils/` | 日志（pino）、工具函数 |
| `tests/` | Vitest 测试套件 |

详细架构文档请参阅 [CLAUDE.md](./CLAUDE.md)。

## 寻找 Issue

- 查找标记为 [`good first issue`](https://github.com/xvirobotics/metabot/labels/good%20first%20issue) 或 [`help wanted`](https://github.com/xvirobotics/metabot/labels/help%20wanted) 的 Issue
- 在开始工作前，先在 Issue 中留言认领
- 如果你想做的事情没有现有 Issue，请先创建一个来讨论方案

## 开发工作流

### 分支策略

```
main（稳定分支，生产环境）
  └── dev（活跃开发）
       ├── feat/your-feature
       ├── fix/your-bugfix
       └── docs/your-docs-change
```

- **`main`** — 稳定分支。只接收来自 `dev` 的合并或热修复 PR。
- **`dev`** — 活跃开发。所有日常工作在此进行。
- 从 `dev` 创建功能分支，而不是 `main`。

### 分支命名

| 前缀 | 用途 |
|------|------|
| `feat/` | 新功能 |
| `fix/` | Bug 修复 |
| `docs/` | 文档变更 |
| `refactor/` | 代码重构 |
| `test/` | 添加或更新测试 |
| `ci/` | CI/CD 变更 |

### 保持同步

```bash
git checkout dev
git pull origin dev
git checkout feat/your-feature
git rebase dev
```

## 提交规范

我们遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范。每条提交信息应符合以下格式：

```
<type>(<可选 scope>): <描述>

[可选正文]

[可选页脚]
```

### 类型

| 类型 | 使用场景 |
|------|---------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 仅文档变更 |
| `refactor` | 既不修复 bug 也不添加功能的代码变更 |
| `test` | 添加或更新测试 |
| `ci` | CI/CD 变更 |
| `chore` | 维护性任务 |

### 来自我们 Git 日志的示例

```
feat: remote URL config for CLI tools (#48)
fix: replace grep -oP with sed for macOS compatibility (#50)
docs: add Star History chart to READMEs (#51)
refactor: rename MEMORY_SERVER_URL to META_MEMORY_URL (#49)
fix: mb CLI auth reads .env instead of stale env vars (#44)
feat: auto-reply in 2-member group chats without @mention (#35)
```

### 规则

- 使用祈使语气："add feature" 而不是 "added feature"
- 主题行不超过 72 个字符
- 在主题中引用 Issue 编号：`fix: crash on empty message (#42)`
- 正文部分说明 _为什么_，而不是 _做了什么_（diff 会展示做了什么）

## Pull Request 流程

### 提交前

1. 确保所有检查在本地通过：
   ```bash
   npx tsc --noEmit    # 类型检查
   npm test             # 测试
   npm run lint         # Lint
   npm run build        # 构建
   ```
2. 在最新的 `dev` 上 rebase 以避免合并冲突
3. 如果你的变更影响了用户可见的行为，更新文档

### 提交 PR

1. 推送你的分支并创建 PR，目标分支为 `dev`（仅热修复才用 `main`）
2. 填写 [PR 模板](./.github/pull_request_template.md) 的所有部分
3. 确保 CI 通过（流水线包括：类型检查 -> 测试 -> lint -> 构建）
4. 请求审核

### 审核流程

- 通常在 48 小时内完成审核
- 在重新请求审核前，处理所有审核意见
- PR 使用 squash merge 以保持 `main` 历史整洁
- 合并需要至少一个批准

## 测试指南

### 应该测试什么

- 纯逻辑模块（解析器、构建器、处理器、工具函数）
- 状态管理（会话管理器、同步存储）
- 数据转换中的边缘情况（卡片构建器、markdown-to-blocks）

### 不需要测试什么

- 飞书 API 调用（外部服务 — 在边界处 mock）
- Claude Agent SDK 调用（外部服务）
- 简单的配置加载或重导出

### 测试模式

我们使用 [Vitest](https://vitest.dev/) 和 ESM 导入：

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock 外部模块
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('MyModule', () => {
  it('should do the expected thing', () => {
    // 准备、执行、断言
  });
});
```

关键约定：
- 测试文件放在 `tests/` 目录下，使用 `.test.ts` 扩展名
- 导入路径使用 `.js` 扩展名（ESM 项目）
- Mock 外部依赖，而不是内部逻辑
- 使用 `npm test` 运行测试（执行 `vitest run`）

## 代码风格

### TypeScript

- **严格模式**已启用（tsconfig 中 `"strict": true`）
- **ESM 项目** — 所有导入使用 `.js` 扩展名（即使是 `.ts` 文件）
- **Target**: ES2022, **Module**: Node16
- 使用 `async/await` 而非原始 Promise
- 使用 `pino` 记录日志（不用 `console.log`）

### 格式化与 Lint

格式化由 Prettier 处理，lint 由 ESLint 处理：

```bash
npm run format        # 自动格式化
npm run format:check  # 检查格式化（CI 使用此命令）
npm run lint          # 运行 ESLint
npm run lint:fix      # 自动修复 lint 问题
```

**Prettier 配置**（`.prettierrc`）：
- 单引号、尾逗号、120 字符行宽、2 空格缩进、分号

**ESLint 配置**（`eslint.config.js`）：
- TypeScript-ESLint 推荐规则
- `@typescript-eslint/no-explicit-any`: 关闭
- 未使用变量警告（`_` 前缀例外）
- 允许空函数

### EditorConfig

为你的编辑器安装 [EditorConfig 插件](https://editorconfig.org/#download) 以自动应用一致的空白设置。

## CI 流水线

每次推送和 PR 都会触发 CI 流水线（`.github/workflows/ci.yml`）：

```
Job: check（Node 20 + 22 矩阵）
  1. 类型检查    — npx tsc --noEmit
  2. 运行测试    — npm test
  3. Lint        — npm run lint

Job: build（Node 22，依赖 check）
  4. 完整构建    — npm run build
```

所有四个步骤必须通过才能合并 PR。

## 发布流程

MetaBot 采用手动发布流程：

1. 开发期间将 PR 合并到 `dev`
2. 准备发布时，从 `dev` 创建 PR 到 `main`
3. 合并后，通过 PM2 在生产服务器上部署
4. 回同步：`git checkout dev && git merge main && git push`

## AI 智能体贡献指南

本节面向**AI 智能体**（Claude Code、Codex、Cursor、Copilot、Devin 等）。无论你是自主工作还是与人类协作编程，请遵循以下指南。

### 开始之前

1. **首先阅读 CLAUDE.md。** 它包含完整的架构、消息流、模块描述和配置细节，是了解本项目工作方式的唯一权威来源。
2. **阅读本 CONTRIBUTING.md。** 你现在正在做的事 — 很好。
3. **检查现有 Issue 和 PR。** 不要重复已在进行中的工作。

### 智能体 PR 要求

智能体创建的 PR 必须达到与人类 PR 相同的质量标准，此外还需：

- **所有 CI 检查必须通过** — 类型检查、测试、lint、构建。没有例外。
- **在提交信息中包含 `Co-Authored-By`：**
  ```
  feat: add widget support

  Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
  ```
- **完整填写 PR 模板** — What/Why/How 部分帮助审核者理解你的推理过程。
- **保持变更聚焦。** 一个 PR = 一个逻辑变更。不要捆绑不相关的修复。

### 智能体上下文文件

| 文件 | 用途 | 何时阅读 |
|------|------|---------|
| `CLAUDE.md` | 完整架构、模块映射、配置参考 | 始终 — 在任何代码变更之前 |
| `CONTRIBUTING.md` | 开发工作流、规范、CI | 始终 — 在提交之前 |
| `.env.example` | 所有环境变量及其描述 | 涉及配置变更时 |
| `bots.example.json` | 多机器人配置格式 | 涉及机器人配置时 |
| `SECURITY.md` | 安全策略和范围 | 涉及认证、会话或输入处理时 |

### 代码库使用指南

- **ESM 导入**：导入路径必须使用 `.js` 扩展名，即使是 TypeScript 文件。这是智能体最常犯的错误。
  ```typescript
  // 正确
  import { something } from './my-module.js';
  // 错误 — 运行时会失败
  import { something } from './my-module';
  import { something } from './my-module.ts';
  ```

- **日志**：通过 `createLogger()` 使用 `pino`，绝不使用 `console.log`。
  ```typescript
  import { createLogger } from '../utils/logger.js';
  const logger = createLogger('my-module');
  logger.info({ data }, 'Something happened');
  ```

- **飞书卡片内容限制**：卡片内容在 28KB 处截断。如果你在修改卡片构建器逻辑，请记住这一点。

- **会话隔离**：会话以 `chatId` 为键，而非 `userId`。每个聊天有独立的会话、工作目录和对话历史。

### 常见智能体错误

| 错误 | 如何避免 |
|------|---------|
| 缺少 `.js` 导入扩展名 | 始终在相对导入中添加 `.js` |
| 使用 `console.log` | 使用 `src/utils/logger.js` 中的 `createLogger()` |
| 直接修改 `main` 分支 | 在 `dev` 或功能分支上工作 |
| 跳过测试 | 每次提交前运行 `npm test` |
| 变更范围过大 | 保持 PR 聚焦于单一关注点 |
| 未更新文档 | 如果行为变更，更新 README.md、README_zh.md 和 CLAUDE.md |
| 添加不必要的依赖 | 优先使用 Node.js 内置 API 和现有依赖 |
| 硬编码 URL 或凭证 | 通过 `src/config.ts` 使用环境变量 |
| 忽略 TypeScript 错误 | `strict: true` 不可商量 — 修复所有类型错误 |

### 智能体测试清单

提交 PR 之前，请验证：

```bash
# 1. 类型检查通过
npx tsc --noEmit

# 2. 所有测试通过
npm test

# 3. 无 lint 错误
npm run lint

# 4. 构建成功
npm run build

# 5. 如果添加了新功能，是否添加了测试？
# 6. 如果修改了行为，是否更新了文档？
# 7. PR 是否指向正确的分支（dev）？
```

### 智能体自主权指南

- **可以直接做的事**：读取文件、运行测试、运行 lint、运行构建、创建分支、编写代码
- **需要先询问的事**：强制推送、删除分支、修改 CI 配置、变更依赖、修改 `.env.example`
- **绝不可以做的事**：提交密钥、直接推送到 `main`、跳过 CI 检查、合并自己的 PR

### 与智能体协作编程

如果你是与 AI 智能体协作开发 MetaBot 的人类开发者：

1. 首先将智能体指向 `CLAUDE.md` — 它包含所有必要的上下文
2. 使用 Conventional Commits 格式 — 智能体可以很好地遵循它
3. 让智能体在推送之前在本地运行完整的 CI 检查
4. 以与审核人类 PR 相同的严格度审核智能体 PR — 智能体可能在业务逻辑上犯细微错误
5. 智能体 PR 应与人类 PR 一样使用 squash merge

## 文档维护

### 何时更新文档

| 变更类型 | 需要更新的文件 |
|---------|---------------|
| 新功能 | README.md, README_zh.md, CLAUDE.md |
| 新环境变量 | `.env.example`, CLAUDE.md |
| 架构变更 | CLAUDE.md |
| 新 CLI 命令 | README.md, README_zh.md |
| API 变更 | CLAUDE.md |
| Bug 修复 | 通常无需更新，除非改变了已记录的行为 |

### 文档风格

- README 面向用户（安装、使用、功能）
- CLAUDE.md 面向开发者/智能体（架构、内部实现、配置参考）
- 使用双语文档：英文（`README.md`）和中文（`README_zh.md`）

## 有问题？

- 在 [Issue](https://github.com/xvirobotics/metabot/issues/new) 中报告 bug 或提出功能请求
- 创建新 Issue 前，请先检查是否已有相关 Issue
