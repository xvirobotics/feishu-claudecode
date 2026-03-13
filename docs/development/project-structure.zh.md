# 项目结构

MetaBot 是 TypeScript ESM 项目（`"type": "module"`，所有导入使用 `.js` 扩展名）。

## 目录布局

```
metabot/
├── src/
│   ├── index.ts                    # 入口
│   ├── config.ts                   # 配置加载器
│   ├── bridge/
│   │   ├── message-bridge.ts       # 核心调度器
│   │   ├── rate-limiter.ts         # 卡片更新节流
│   │   └── outputs-manager.ts      # 输出文件生命周期
│   ├── claude/
│   │   ├── executor.ts             # Agent SDK 封装
│   │   ├── stream-processor.ts     # SDK 消息 → 卡片状态
│   │   └── session-manager.ts      # 会话存储
│   ├── feishu/
│   │   ├── event-handler.ts        # 飞书事件解析
│   │   ├── card-builder.ts         # 交互卡片构建器
│   │   ├── message-sender.ts       # 飞书 API 客户端
│   │   └── doc-reader.ts           # 文档 → Markdown
│   ├── telegram/
│   │   └── ...                     # Telegram Bot 集成
│   ├── api/
│   │   ├── http-server.ts          # REST API 服务
│   │   ├── bot-registry.ts         # Bot 注册表
│   │   └── peer-manager.ts         # 跨实例联邦
│   ├── memory/
│   │   ├── memory-client.ts        # MetaMemory HTTP 客户端
│   │   └── memory-events.ts        # 变更事件发射器
│   ├── sync/
│   │   ├── doc-sync.ts             # 知识库同步服务
│   │   ├── sync-store.ts           # SQLite 持久化
│   │   └── markdown-to-blocks.ts   # MD → 飞书块
│   ├── skills/
│   │   └── metabot/
│   │       └── SKILL.md            # Agent 总线 skill
│   └── utils/
│       └── logger.ts               # 日志
├── bin/
│   ├── metabot                     # 服务管理 CLI
│   ├── mb                          # Agent 总线 CLI
│   ├── mm                          # MetaMemory CLI
│   └── fd                          # 飞书文档阅读 CLI
├── tests/                          # Vitest 测试文件
├── docs/                           # 文档（MkDocs）
├── dist/                           # 编译输出
├── mkdocs.yml                      # MkDocs 配置
├── bots.example.json               # 多 Bot 配置示例
├── .env.example                    # 环境配置示例
└── package.json
```

## 核心依赖

| 包 | 用途 |
|---|------|
| `@anthropic-ai/claude-agent-sdk` | Claude Code Agent SDK |
| `@anthropic-ai/claude-code` | Claude Code CLI（peer 依赖） |
| `@larksuiteoapi/node-sdk` | 飞书 SDK |
| `tsx` | TypeScript 执行（开发） |
| `vitest` | 测试框架 |
