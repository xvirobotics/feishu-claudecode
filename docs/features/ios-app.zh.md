# iOS App

MetaBot 的原生 Swift iOS 应用 —— 在 iPhone 或 iPad 上完整操控你的 Agent 团队。

## 概述

iOS App 通过 WebSocket 连接到 MetaBot 服务器，提供原生移动端体验：实时流式聊天、CallKit 语音通话、VoIP 推送通知、MetaMemory 浏览。

**要求**：iOS 17.0+，Xcode 15+，Apple 开发者账户（推送通知需要）

**源码**：`ios/MetaBot/` 目录

## 功能

### 聊天
- **实时流式输出** — WebSocket 自动重连 + 心跳检测
- **Markdown 渲染** — swift-markdown-ui 富文本展示
- **工具调用展示** — 可折叠的工具调用视图
- **文件上传/下载** — PhotosPicker、文档选择器、内联预览
- **消息长按菜单** — 复制/分享
- **触觉反馈** — UIImpactFeedbackGenerator

### 语音
- **语音输入** — Apple SFSpeechRecognizer 实时语音转文字 + 麦克风按钮
- **电话语音模式** — 全屏语音对话覆盖层，VAD（语音活动检测）自动检测说完
- **RTC 通话** — 基于火山引擎 RTC SDK 的实时语音/视频通话
- **CallKit 集成** — 原生电话界面，来电/去电，通话记录显示在"电话"App 中
- **VoIP 推送通知** — PushKit 推送，App 在后台也能收到来电通知

### 多 Agent
- **群聊** — 多 Bot 对话，@mention 路由到指定 Agent
- **Bot 切换** — 在设置中切换不同的已配置 Bot
- **团队看板** — 查看所有 Agent 状态和组织概览

### 知识库
- **MetaMemory 浏览器** — 搜索和浏览文档，支持文件夹导航
- **文档查看器** — Markdown 富文本渲染

### 平台适配
- **iPad 分栏视图** — NavigationSplitView 三栏布局，充分利用大屏
- **明暗/跟随系统主题** — 设置中切换
- **会话管理** — 创建、切换、删除会话
- **Keychain 认证** — Token 存储在 iOS 安全区域

## 前置条件

### 1. Apple 开发者账户

你需要 Apple 开发者账户来：
- 在真机上构建运行
- 配置推送通知（VoIP 推送需要付费账户）
- 生成签名证书

**免费账户**可以在本地构建运行（无推送通知）。
**付费账户**（$99/年）才能使用 VoIP 推送通知和 TestFlight 分发。

### 2. MetaBot 服务器

iOS App 连接到运行中的 MetaBot 实例，你需要：

- MetaBot 服务器正在运行且手机可以访问（局域网或公网 IP）
- 配置 HTTPS（语音功能必须） — 见 [Web UI 文档](web-ui.zh.md#https)
- `.env` 中设置了 `API_SECRET`

### 3. 开发工具

- macOS + Xcode 15+
- CocoaPods（`sudo gem install cocoapods`）
- Node.js 20+（编译 MetaBot 服务端）

## 安装步骤

### 第 1 步：克隆并打开项目

```bash
cd metabot/ios/MetaBot
pod install
open MetaBot.xcworkspace
```

!!! warning
    必须打开 `.xcworkspace` 而不是 `.xcodeproj`，CocoaPods 依赖 workspace。

### 第 2 步：配置签名

1. 打开 Xcode → 选择 MetaBot target
2. 进入 **Signing & Capabilities**
3. 选择你的 **Team**（Apple 开发者账户）
4. 修改 **Bundle Identifier** 为你自己的（如 `com.yourname.metabot`）
5. Xcode 会自动创建 Provisioning Profile

### 第 3 步：配置推送通知（可选）

VoIP 推送通知让 Agent 完成任务时能推送到手机，即使 App 在后台。

1. 在 Xcode → **Signing & Capabilities** → 添加 **Push Notifications** 能力
2. 添加 **Background Modes** → 勾选 **Voice over IP** 和 **Remote notifications**
3. 打开 [Apple Developer Portal](https://developer.apple.com/account/resources/authkeys/list)
4. 创建 **APNs Key**（Apple 推送通知密钥）
5. 下载 `.p8` 密钥文件
6. 配置 MetaBot 服务器：

```bash
# 在 .env 中
APNS_KEY_ID=你的密钥ID
APNS_TEAM_ID=你的团队ID
APNS_KEY_PATH=/path/to/AuthKey_XXXXX.p8
APNS_BUNDLE_ID=com.yourname.metabot
APNS_ENVIRONMENT=development    # TestFlight/App Store 用 "production"
```

### 第 4 步：配置火山引擎 RTC（可选）

如需实时语音/视频通话（超越基础 HTTP 语音模式）：

1. 注册 [火山引擎控制台](https://console.volcengine.com/)
2. 创建 RTC 应用
3. 获取 AppID 并配置：

```bash
# 在 .env 中
VOLCENGINE_RTC_APP_ID=你的app_id
```

iOS App 从服务器的 `/api/rtc/token` 接口读取 RTC 配置。

### 第 5 步：构建运行

1. 用 USB 连接 iPhone 或选择模拟器
2. 在 Xcode 中选择 MetaBot scheme
3. 按 **Cmd+R** 构建运行
4. 首次启动时输入 MetaBot 服务器地址和 API_SECRET

### 第 6 步：登录

1. 打开 App
2. 输入 MetaBot 服务器地址（如 `https://metabot.yourdomain.com`）
3. 输入 `API_SECRET` 作为 Token
4. Token 存储在 Keychain 中，下次不用再输入

## 架构

### 核心服务

| 服务 | 文件 | 说明 |
|------|------|------|
| `AuthService` | `AuthService.swift` | Keychain Token 管理 |
| `WebSocketService` | `WebSocketService.swift` | WebSocket 自动重连 + 心跳 |
| `VoiceService` | `VoiceService.swift` | SFSpeechRecognizer + AVAudioEngine |
| `VoiceAPIService` | `VoiceAPIService.swift` | POST /api/voice（STT + Agent + TTS） |
| `CallKitService` | `CallKitService.swift` | CallKit provider + CXCallController |
| `RtcVoiceService` | `RtcVoiceService.swift` | 火山引擎 RTC 语音通话 |
| `PushNotificationService` | `PushNotificationService.swift` | VoIP 推送 + 本地通知 |
| `FileService` | `FileService.swift` | 文件上传/下载 |

### 核心视图

| 视图 | 文件 | 说明 |
|------|------|------|
| `LoginView` | `LoginView.swift` | Token 登录 |
| `MainTabView` | `MainTabView.swift` | iPad 分栏 + iPhone 标签页 |
| `ChatView` | `ChatView.swift` | 主聊天界面 |
| `PhoneCallView` | `PhoneCallView.swift` | 全屏通话覆盖层 |
| `RtcCallView` | `RtcCallView.swift` | RTC 语音/视频覆盖层 |
| `InputBar` | `InputBar.swift` | 消息输入 + 文件选择 |
| `MemoryView` | `MemoryView.swift` | MetaMemory 浏览器 |
| `TeamDashboardView` | `TeamDashboardView.swift` | 团队概览 |

### 依赖

| 包 | 用途 |
|----|------|
| `swift-markdown-ui` | SwiftUI Markdown 渲染 |
| `VolcEngineRTC`（CocoaPods） | 实时语音/视频 |

## 常见问题

### 编译错误

**"No signing certificate"** — 在 Signing & Capabilities 中选择你的 Team。免费账户需在 iPhone 设置 → 通用 → VPN与设备管理 中信任开发者。

**"Module 'VolcEngineRTC' not found"** — 在 `ios/MetaBot/` 目录运行 `pod install`，然后打开 `.xcworkspace`。

**"Minimum deployment target"** — 确认设备系统版本 iOS 17.0+。

### 运行问题

**"无法连接到服务器"** — 检查服务器地址是否正确且手机可访问。同一 WiFi 下用局域网 IP（如 `http://192.168.1.x:9100`）。语音功能需要 HTTPS。

**"推送通知不工作"** — 检查 `.env` 中的 APNs 配置。VoIP 推送需要付费 Apple 开发者账户。查看服务器日志确认推送发送情况。

**"语音输入不工作"** — 确保已授权麦克风和语音识别权限。iOS 17+ 需要明确的用户同意。

**"CallKit 不显示"** — CallKit 需要配置 VoIP 推送。服务器通过推送通知发起通话，触发设备上的 CallKit。
