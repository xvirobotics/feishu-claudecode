# MetaBot iOS App 开发规划

## 目标

开发原生 iOS App，实现与 Web UI 完全对等的功能体验，利用 iOS 原生能力（推送通知、Haptics、Siri/Shortcuts、后台运行）提供比 Web 更优的使用体验。

## 技术选型

| 项目 | 选择 |
|------|------|
| 最低版本 | iOS 17.0+ |
| UI 框架 | SwiftUI |
| 状态管理 | @Observable (Observation framework) |
| 网络 | URLSessionWebSocketTask + async/await |
| 音频 | AVFoundation (AVAudioRecorder + AVAudioEngine for VAD) |
| Markdown | swift-markdown-ui (Gonzalo Nuñez) |
| 代码高亮 | Splash 或 HighlightSwift |
| 持久化 | SwiftData (sessions/messages) 或 UserDefaults + JSON |
| 项目位置 | `ios/MetaBot/` (monorepo) |
| 包管理 | Swift Package Manager |

## 分阶段实施

---

### Phase 1: 项目骨架 + 核心聊天（Sprint 1）

**目标：** 能连上 MetaBot 服务器，发消息，看到流式响应

#### 1.1 Xcode 项目初始化
- 创建 `ios/MetaBot.xcodeproj`（或 `ios/MetaBot/Package.swift`）
- 项目结构：
  ```
  ios/MetaBot/
  ├── MetaBotApp.swift          # @main entry
  ├── Models/
  │   ├── ChatMessage.swift     # Message types
  │   ├── CardState.swift       # Streaming state
  │   ├── BotInfo.swift         # Bot metadata
  │   └── FileAttachment.swift  # File info
  ├── Services/
  │   ├── WebSocketService.swift    # WS connection + protocol
  │   ├── AuthService.swift         # Token management (Keychain)
  │   └── FileService.swift         # Upload/download
  ├── ViewModels/
  │   ├── AppState.swift            # Global @Observable state
  │   ├── ChatViewModel.swift       # Chat logic
  │   └── SessionManager.swift      # Session CRUD
  ├── Views/
  │   ├── LoginView.swift
  │   ├── MainTabView.swift         # Tab navigation
  │   ├── Chat/
  │   │   ├── ChatView.swift        # Chat screen
  │   │   ├── MessageBubble.swift   # User/assistant bubbles
  │   │   ├── InputBar.swift        # Text + file + voice + send
  │   │   ├── ToolCallView.swift    # Tool call list
  │   │   └── EmptyStateView.swift  # Suggested prompts
  │   ├── BotList/
  │   │   ├── BotListView.swift     # Bot cards
  │   │   └── BotCard.swift         # Single bot card
  │   └── Settings/
  │       └── SettingsView.swift
  ├── Utilities/
  │   └── GradientAvatar.swift      # Deterministic gradient avatar
  └── Assets.xcassets/
  ```

#### 1.2 WebSocket Service
- `URLSessionWebSocketTask` 连接 `wss://host/ws?token=xxx`
- 心跳 ping/pong（25s 间隔）
- 断线自动重连（指数退避 1s → 30s）
- JSON 编解码所有 ClientMessage / ServerMessage 类型
- `AsyncStream<ServerMessage>` 供 ViewModel 消费
- 连接状态枚举: `.connecting`, `.connected`, `.disconnected`

#### 1.3 Models（对齐 Web types.ts）
- `ChatMessage`: id, type(user/assistant/system), text, state?, attachments?, timestamp
- `CardState`: status(thinking/running/complete/error/waiting_for_input), responseText, toolCalls[], costUsd?, durationMs?, errorMessage?
- `ToolCallInfo`: name, detail, status(running/done)
- `BotInfo`: name, platform, workingDirectory, description?
- `FileAttachment`: name, type, size, url, path?

#### 1.4 Login View
- Token 输入框 + 连接按钮
- Token 存 Keychain（不是 UserDefaults）
- 验证: GET /api/status
- 错误提示

#### 1.5 Chat View (基础版)
- NavigationSplitView: bot list | chat
- 消息列表 ScrollView + LazyVStack
- 用户消息右对齐蓝/绿气泡
- 助手消息左对齐：
  - 状态指示器（thinking 动画、running spinner、complete ✓、error ✗）
  - Markdown 渲染（swift-markdown-ui）
  - Tool calls 折叠列表
- InputBar: TextField + Send button
- 自动滚到底部

#### 1.6 Bot List
- 渐变头像 + 名称 + 平台标签
- 最新消息预览
- 点击切换到对应 session
- 新建 session (+按钮)

**交付物：** 能登录、选 bot、发消息、看到流式 Markdown 响应的可运行 App

---

### Phase 2: 文件 + 语音 + 通话模式（Sprint 2）

#### 2.1 文件上传
- PhotosPicker 选图片
- 文件选择器（UTType.item）
- 拖拽支持（iPad）
- 上传进度条（URLSession delegate）
- POST /api/upload
- 上传前预览（缩略图 + 文件名 + 大小）

#### 2.2 文件展示 + 预览
- FileAttachmentCard: 图片缩略图 / 文件图标 + 扩展名 badge
- 点击打开全屏预览 sheet：
  - 图片: AsyncImage + 缩放手势
  - PDF: PDFKit (PDFView)
  - 视频: AVPlayer + VideoPlayer
  - 音频: AVAudioPlayer + 播放控件
  - 文本/代码: ScrollView + 等宽字体
  - 其他: QuickLook (QLPreviewController via UIViewControllerRepresentable)
- 分享按钮（UIActivityViewController）
- 下载到本地（FileManager）

#### 2.3 语音输入（STT）
- SFSpeechRecognizer (Speech framework) 实时转文字
- 麦克风按钮 + 实时显示识别结果
- 权限请求处理（NSMicrophoneUsageDescription、NSSpeechRecognitionUsageDescription）
- 或者用 Web 版方案: 录音 → POST /api/voice → 拿到文字

#### 2.4 通话模式（Phone Call）
- 全屏通话浮层（类似 Web CallOverlay）
- AVAudioEngine VAD 检测说话/静音
  - RMS 阈值检测（> 0.03 为说话）
  - 静音 1.8s 后自动停止录音
- 录音 → POST /api/voice?voiceMode=true → 播放 TTS 响应
- 自动循环: 录音 → 处理 → 播放 → 录音
- 状态显示: Listening / Speaking / Thinking / Speaking
- 通话计时器
- 挂断按钮
- AVAudioSession 配置: `.playAndRecord`, `.defaultToSpeaker`
- 中断处理（电话来了）

#### 2.5 Pending Questions
- 当 status == "waiting_for_input" 时显示问题 UI
- 问题文本 + 多个选项按钮
- 点击按钮 → WebSocket answer 消息

**交付物：** 完整的聊天 + 文件 + 语音体验

---

### Phase 3: Memory + Groups + 打磨（Sprint 3）

#### 3.1 Memory Browser
- MetaMemory API 集成（/memory/api/）
- 文件夹树导航
- 文档列表 + 搜索
- Markdown 文档预览
- 下拉刷新

#### 3.2 Group Chat
- 创建群组（选择多个 bot）
- 群消息带 @botName 前缀
- 群成员展示
- 删除群组

#### 3.3 Settings View
- 外观切换（Dark/Light/System）
- 连接状态 + 服务器 URL
- Token 管理（显示/断开）
- Bot 列表展示
- 清除聊天记录
- App 版本信息

#### 3.4 UX 打磨
- Haptic feedback（消息发送、通话状态切换）
- 自定义 App Icon
- Launch Screen
- 键盘避让（InputBar 跟随键盘）
- Pull to refresh
- 消息长按菜单（复制、分享）
- 代码块复制按钮
- Deep link 支持（metabot://chat/xxx）
- iPad 适配（NavigationSplitView 三栏）

**交付物：** 功能完整、体验打磨的 App

---

### Phase 4: 原生增强（Sprint 4）

#### 4.1 推送通知
- APNs 注册
- 服务端推送（任务完成通知）
- 通知点击跳转到对应 chat

#### 4.2 Siri / Shortcuts
- "Hey Siri, ask MetaBot ..."
- Shortcuts app 集成
- App Intents framework

#### 4.3 后台运行
- Background Tasks (BGTaskScheduler)
- WebSocket 后台保活（有限）
- 后台下载/上传

#### 4.4 Widget
- Lock Screen widget（最近消息预览）
- Home Screen widget（快速提问）

**交付物：** 超越 Web 的原生体验

---

## 实施顺序

先做 Phase 1（核心聊天），这是 MVP。预计改动：

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1 | 创建 Xcode 项目 + 目录结构 | `ios/MetaBot/` 全部新建 |
| 2 | Models（消息、状态、Bot 类型） | `Models/*.swift` |
| 3 | WebSocketService | `Services/WebSocketService.swift` |
| 4 | AuthService (Keychain) | `Services/AuthService.swift` |
| 5 | AppState + ChatViewModel | `ViewModels/*.swift` |
| 6 | LoginView | `Views/LoginView.swift` |
| 7 | BotListView + BotCard | `Views/BotList/*.swift` |
| 8 | ChatView + MessageBubble + InputBar | `Views/Chat/*.swift` |
| 9 | Markdown 渲染 + 代码高亮 | SPM 依赖 + MessageBubble |
| 10 | EmptyState + ToolCallView | `Views/Chat/*.swift` |
| 11 | MainTabView 导航整合 | `Views/MainTabView.swift` |
| 12 | 测试 + 调试 | Xcode simulator + 真机 |

全部新建文件，不影响现有 server/web 代码。
