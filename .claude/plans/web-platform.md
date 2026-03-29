# MetaBot Web Platform — 完整规划

## 目标

在 MetaBot 现有架构（Feishu + Telegram）之上，增加一个独立的 **Web 端**，包含：

1. **Chat UI** — 实时流式对话，等同甚至超越飞书体验
2. **MetaMemory UI** — 现有文档/知识管理功能迁移到 React
3. **Voice Mode** — 流式语音交互（Whisper STT + 流式 TTS）
4. **统一 SPA** — 一个页面，侧边栏切换 Chat / Memory / Settings
5. **未来路径** — 从 Web → PWA → React Native (iOS/Mac) → 去掉飞书依赖

## 技术选型

| 层 | 技术 | 理由 |
|---|------|------|
| 前端框架 | **React 19 + Vite** | 组件化、TS 支持、未来 React Native 迁移 |
| 实时通信 | **WebSocket (ws)** | 双向通信、流式输出、语音流式传输 |
| 状态管理 | **Zustand** | 轻量、TypeScript 友好、不需要 Redux 的重量 |
| 路由 | **React Router v7** | SPA 内页面切换 |
| Markdown | **react-markdown + rehype** | React 生态，支持代码高亮 |
| 样式 | **CSS Modules** | 无额外依赖，保持轻量 |
| 打包 | **Vite → dist/web/** | 构建产物由 MetaBot HTTP server 静态服务 |

## 现有架构优势

MetaBot 已有优秀的平台抽象层，Web 端可以复用：

- `IMessageSender` 接口 — 实现 `WebSender` 即可接入
- `MessageBridge` — 所有核心逻辑（命令、执行、会话）平台无关
- `CardState` — 完整的流式状态结构，直接通过 WebSocket 推送
- `BotRegistry` — 注册 `platform: 'web'`，与飞书/Telegram 并存
- `SessionManager` — 按 `chatId` 隔离，Web 端用 userId 或 sessionToken 做 chatId

## 分阶段计划

---

### Phase 1: WebSocket 基础 + 最小可用 Chat（MVP）

**目标**：能在浏览器里跟 Agent 对话，实时看到流式输出。

#### 后端

1. **安装 `ws` 包**，在现有 HTTP server 上添加 WebSocket 升级
2. **创建 `src/web/ws-server.ts`**
   - WebSocket 连接管理（认证、房间、心跳）
   - 连接时验证 Bearer token（复用 `API_SECRET`）
   - 消息协议定义：
     ```typescript
     // Client → Server
     type ClientMessage =
       | { type: 'chat'; botName: string; chatId: string; text: string }
       | { type: 'stop'; chatId: string }
       | { type: 'answer'; chatId: string; toolUseId: string; answer: string }

     // Server → Client
     type ServerMessage =
       | { type: 'state'; chatId: string; messageId: string; state: CardState }
       | { type: 'complete'; chatId: string; messageId: string; state: CardState }
       | { type: 'error'; chatId: string; error: string }
       | { type: 'connected'; bots: BotInfo[] }
     ```
3. **创建 `src/web/web-sender.ts`** — 实现 `IMessageSender`
   - `sendCard()` / `updateCard()` → 通过 WebSocket 推送 `CardState` 给客户端
   - `sendImageFile()` / `sendLocalFile()` → 保存到静态目录，推送 URL
   - 不需要真正的飞书卡片构建，直接发结构化数据
4. **在 `http-server.ts` 中注册 WebSocket 升级路由**
   - `GET /ws` → 升级为 WebSocket 连接
5. **静态文件服务** — `GET /web/*` → 从 `dist/web/` 或 `web/dist/` 提供前端资源

#### 前端

6. **初始化 React + Vite 项目** — `web/` 目录（monorepo 风格）
   - `web/src/`, `web/index.html`, `web/vite.config.ts`
   - TypeScript，共享类型定义（`CardState`、`ToolCall` 等从 `src/types.ts` 导出）
7. **WebSocket hook** — `useWebSocket(url, token)` 管理连接、重连、消息派发
8. **最小 Chat UI**
   - 消息列表（用户消息 + Agent 回复）
   - Agent 回复实时流式渲染（`status: thinking → running → complete`）
   - 工具调用折叠显示（和飞书卡片一致）
   - Markdown 渲染 + 代码高亮
   - 输入框 + 发送按钮
   - Bot 选择器（从 `/api/bots` 获取列表）
9. **登录页** — 简单的 token 输入（`API_SECRET`），存 localStorage

**交付物**：打开 `http://server:9100/web/` 即可对话，效果等同飞书但有实时流式。

**预计工作量**：后端 ~400 行，前端 ~1200 行

---

### Phase 2: 完整 Chat 功能

**目标**：对齐飞书端的全部聊天功能。

1. **会话管理**
   - 侧边栏会话列表（新建 / 切换 / 删除会话）
   - 会话持久化（chatId 列表存 localStorage，可选后端存储）
   - `/reset` 命令（清除会话）
2. **文件交互**
   - 图片上传（拖拽 / 粘贴 / 点击选择）→ 上传到 `/api/upload` → 转发给 Claude
   - Agent 输出文件显示（图片内联、其他文件下载链接）
3. **Pending Question 交互**
   - Agent 问用户问题时，渲染选项卡片
   - 用户选择后通过 WebSocket 回复 `answer` 消息
4. **命令支持**
   - `/reset`、`/stop`、`/status`、`/help`、`/memory` 等
   - 命令自动补全
5. **Plan Mode 显示**
   - 当 Agent 进入 plan mode 时，渲染 plan 内容
6. **Cost / Duration 显示**
   - 每条消息显示 cost 和耗时
7. **暗色模式**

**预计工作量**：~1500 行

---

### Phase 3: MetaMemory 集成 — 统一 SPA

**目标**：把 MetaMemory Web UI 迁移到 React，和 Chat 合并为统一 SPA。

1. **React 化 MetaMemory**
   - `<FolderTree>` — 文件夹树导航
   - `<DocumentList>` — 文档列表
   - `<DocumentView>` — Markdown 渲染
   - `<DocumentEditor>` — 创建/编辑文档
   - `<SearchResults>` — 全文搜索
   - 复用现有 MetaMemory API（`/api/documents`、`/api/folders`、`/api/search`）
2. **统一布局**
   - 左侧主导航栏：Chat（💬）/ Memory（📚）/ Settings（⚙️）
   - Chat 和 Memory 各自有次级侧边栏（会话列表 / 文件夹树）
3. **统一认证**
   - 一个 token 同时访问 Chat API 和 MetaMemory API
   - MetaMemory server 代理请求复用 token 验证
4. **移除旧 MetaMemory 静态文件**
   - `src/memory/static/` 的 vanilla JS 代码退役
   - MetaMemory server 路由到新的 React 构建产物

**预计工作量**：~2000 行

---

### Phase 4: 流式语音交互

**目标**：在 Web 端实现 Jarvis 式语音交互，真正的流式。

1. **浏览器端音频录制**
   - MediaRecorder API 捕获麦克风
   - VAD（Voice Activity Detection）— 用 `@ricky0123/vad-web` 或简单的音量阈值
   - 录完发送音频 chunk 到 WebSocket
2. **服务端流式处理**
   - WebSocket 接收音频 → Whisper STT
   - Agent 执行（复用现有流程）
   - TTS 流式返回：逐句合成，句子级别流式推送音频 chunk
3. **浏览器端音频播放**
   - Web Audio API 播放接收到的 TTS 音频 chunk
   - 句子级别流式播放（~50% 感知延迟降低）
4. **UI**
   - 麦克风按钮（按住说话 / 点击切换）
   - 音频可视化波形
   - 转录文本实时显示

**预计工作量**：~1500 行

---

### Phase 5: 高级功能 + 原生端准备

**目标**：完善 Web 端，为原生应用铺路。

1. **PWA 支持**
   - Service Worker、离线缓存、添加到主屏幕
   - Push Notification（任务完成通知）
2. **多 Bot 管理面板**
   - 查看所有 bot 状态
   - 创建/删除/配置 bot（复用 `/api/bots` CRUD）
   - 调度任务管理（复用 `/api/schedule`）
3. **Peer 管理**
   - 查看远程 peer 状态
   - 跨 peer 对话
4. **响应式设计**
   - 移动端完美适配
   - iPad 分屏支持
5. **React Native 调研**
   - 评估 Chat 组件复用度
   - 核心 hooks（useWebSocket、useChat、useMemory）100% 可复用
   - UI 组件需要用 RN 原生组件重写

**预计工作量**：~2000 行

---

## 项目结构

```
metabot/
├── src/                        # 后端（现有）
│   ├── api/
│   │   ├── http-server.ts      # 新增 WS 升级 + 静态文件服务
│   │   └── ...
│   ├── web/                    # 新目录：Web 平台后端
│   │   ├── ws-server.ts        # WebSocket 服务器（连接管理、消息路由）
│   │   ├── ws-handler.ts       # WebSocket 消息处理（chat/stop/answer）
│   │   └── web-sender.ts       # IMessageSender 实现（WS 推送）
│   └── ...
├── web/                        # 新目录：前端 React 应用
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json            # 前端依赖（独立 node_modules）
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── hooks/
│       │   ├── useWebSocket.ts
│       │   ├── useChat.ts
│       │   └── useMemory.ts
│       ├── stores/
│       │   └── chatStore.ts    # Zustand store
│       ├── components/
│       │   ├── chat/
│       │   │   ├── ChatView.tsx
│       │   │   ├── MessageList.tsx
│       │   │   ├── MessageBubble.tsx
│       │   │   ├── ToolCallList.tsx
│       │   │   ├── InputBox.tsx
│       │   │   └── BotSelector.tsx
│       │   ├── memory/
│       │   │   ├── MemoryView.tsx
│       │   │   ├── FolderTree.tsx
│       │   │   ├── DocumentList.tsx
│       │   │   ├── DocumentView.tsx
│       │   │   └── DocumentEditor.tsx
│       │   ├── voice/
│       │   │   ├── VoiceButton.tsx
│       │   │   └── AudioVisualizer.tsx
│       │   └── layout/
│       │       ├── Sidebar.tsx
│       │       ├── Header.tsx
│       │       └── AuthGate.tsx
│       └── styles/
│           └── *.module.css
└── dist/
    ├── ...                     # 后端编译输出（现有）
    └── web/                    # 前端构建产物（Vite → 这里）
```

## 构建集成

```jsonc
// package.json 新增 scripts
{
  "scripts": {
    "build:web": "cd web && npm run build",       // Vite 构建前端
    "dev:web": "cd web && npm run dev",            // Vite dev server (开发时)
    "build": "tsc && cp -r src/memory/static dist/memory/static && npm run build:web"
  }
}
```

**开发模式**：
- `npm run dev` — 后端 tsx hot reload（端口 9100）
- `npm run dev:web` — Vite dev server（端口 5173），代理 API/WS 到 9100

**生产模式**：
- `npm run build` — 编译后端 + 构建前端
- 前端构建到 `dist/web/`，由后端 HTTP server 静态服务
- 一个进程同时服务 API + WebSocket + Web UI

## WebSocket 协议设计

### 连接
```
ws://server:9100/ws?token=YOUR_API_SECRET
```

### Client → Server 消息

```typescript
// 发送聊天消息
{ "type": "chat", "botName": "goku", "chatId": "web_user123_1", "text": "帮我看一下项目状态" }

// 停止当前执行
{ "type": "stop", "chatId": "web_user123_1" }

// 回答 Agent 的 pending question
{ "type": "answer", "chatId": "web_user123_1", "toolUseId": "tu_xxx", "answer": "option_1" }

// 发送语音（Phase 4）
{ "type": "voice", "botName": "goku", "chatId": "web_user123_1", "audio": "<base64>" }

// 订阅会话更新（可选，用于多标签页同步）
{ "type": "subscribe", "chatId": "web_user123_1" }
```

### Server → Client 消息

```typescript
// 连接成功，返回可用 bot 列表
{ "type": "connected", "bots": [{ "name": "goku", "platform": "feishu" }, ...] }

// 流式状态更新（Agent 执行中，每 1.5s 一次）
{ "type": "state", "chatId": "web_xxx", "messageId": "msg_123", "state": CardState }

// 执行完成
{ "type": "complete", "chatId": "web_xxx", "messageId": "msg_123", "state": CardState }

// 错误
{ "type": "error", "chatId": "web_xxx", "error": "Bot not found: xxx" }

// 输出文件（图片、PDF 等）
{ "type": "file", "chatId": "web_xxx", "url": "/web/outputs/xxx/image.png", "name": "image.png", "type": "image/png" }

// 语音 TTS chunk（Phase 4）
{ "type": "audio", "chatId": "web_xxx", "data": "<base64 audio chunk>", "final": false }
```

## 认证方案

Phase 1-2 简单方案：复用 `API_SECRET` 作为 token。

后续可扩展：
- 用户账号系统（username/password → JWT）
- OAuth（GitHub、Google）
- 多用户权限（admin / user / viewer）

目前先不做用户系统，MetaBot 定位是私人/团队工具，一个 secret 够用。

## 执行建议

1. **Phase 1 先行** — 这是基础，后续所有功能都依赖 WebSocket + React 框架
2. **Phase 2 和 3 可并行** — Chat 完善和 Memory 迁移相对独立
3. **Phase 4 独立** — 语音流式是独立模块
4. **Phase 5 视需求** — PWA/原生端在核心功能稳定后再做

每个 Phase 完成后独立可用，不需要等后续 Phase。

## 风险与注意事项

1. **MetaMemory 静态文件迁移** — Phase 3 之前旧 UI 继续工作，迁移后需要确保所有功能覆盖
2. **WebSocket 重连** — 网络不稳定时需要自动重连 + 状态恢复（恢复当前执行的最新 CardState）
3. **并发执行** — 多标签页/多设备同时连接同一 chatId，需要广播更新给所有连接
4. **前端构建集成** — `web/` 是独立 npm 项目，CI/CD 需要同时构建前后端
5. **打包体积** — React + Vite 打包控制在 200KB 以内（gzip），不影响首屏加载
