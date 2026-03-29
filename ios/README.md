# MetaBot iOS App

Native iOS companion app for MetaBot — chat with Claude Code agents from your iPhone/iPad.

## Requirements

- macOS with Xcode 15+
- iOS 17.0+ deployment target
- A running MetaBot server

## Quick Start

### Option 1: Open in Xcode (Recommended)

1. Open Xcode
2. File → Open → select `ios/MetaBot/` folder
3. Xcode will resolve Package.swift and download dependencies
4. Select your iOS Simulator or device
5. Build & Run (Cmd+R)

### Option 2: Create Xcode Project

```bash
cd ios/MetaBot
# Open Package.swift in Xcode — it auto-creates a runnable scheme
open Package.swift
```

### Option 3: Command Line (macOS only)

```bash
cd ios/MetaBot
swift build
swift run MetaBot  # macOS only, for iOS use Xcode
```

## Project Structure

```
ios/MetaBot/
├── Package.swift              # SPM manifest + dependencies
└── Sources/
    ├── MetaBotApp.swift       # @main entry point
    ├── Models/                # Data types (mirroring Web types.ts)
    │   ├── BotInfo.swift
    │   ├── CardState.swift
    │   ├── ChatGroup.swift
    │   ├── ChatMessage.swift
    │   ├── FileAttachment.swift
    │   └── WebSocketMessages.swift
    ├── Services/              # Network + Auth + Voice
    │   ├── AuthService.swift       # Keychain token management
    │   ├── FileService.swift       # File upload/download
    │   ├── VoiceAPIService.swift   # POST /api/voice (STT + Agent + TTS)
    │   ├── VoiceService.swift      # SFSpeechRecognizer + AVAudioEngine recording
    │   └── WebSocketService.swift  # WebSocket with reconnect + heartbeat
    ├── ViewModels/
    │   └── AppState.swift     # @Observable global state
    ├── Views/
    │   ├── LoginView.swift
    │   ├── MainTabView.swift  # iPad split view + iPhone tabs
    │   ├── BotList/           # Agent + group cards
    │   │   ├── BotCard.swift
    │   │   ├── BotListView.swift
    │   │   └── GroupCreateDialog.swift
    │   ├── Chat/              # Chat UI (messages, input, tools, markdown, voice, files)
    │   │   ├── ChatView.swift
    │   │   ├── EmptyStateView.swift
    │   │   ├── FilePickerView.swift
    │   │   ├── FilePreviewSheet.swift
    │   │   ├── InputBar.swift
    │   │   ├── MessageBubble.swift
    │   │   ├── PhoneCallView.swift
    │   │   └── ToolCallView.swift
    │   ├── Memory/            # MetaMemory browser
    │   └── Settings/
    └── Utilities/
        └── GradientAvatar.swift
```

## Features

### Phase 1 — Core Chat (MVP)
- Token-based login (stored in Keychain)
- Bot list with gradient avatars and status
- Real-time streaming chat via WebSocket
- Markdown rendering (swift-markdown-ui)
- Tool call display with expand/collapse
- Pending question UI
- Session management (create, switch, delete)
- Auto-scroll with manual override
- iPad three-column split view layout
- iPhone tab-based navigation
- MetaMemory document browser
- Settings (connection, agents, data management)

### Phase 2 — Files, Voice, Groups, Polish
- **File upload** — PhotosPicker for images, document picker for any file type
- **File preview** — Fullscreen sheet with zoomable images, PDF rendering, text preview
- **Voice input** — Real-time speech recognition (SFSpeechRecognizer) with mic button
- **Phone call mode** — Full-screen voice conversation overlay with VAD (voice activity detection), auto-cycling record → process → play → record
- **Group chat** — Create bot groups, multi-agent conversations with @mention routing
- **Dark/light/system theme** — Picker in Settings
- **Message context menu** — Long-press to copy or share message text
- **Haptic feedback** — UIImpactFeedbackGenerator on key interactions

## Server Connection

The app connects to your MetaBot server via:
- **WebSocket**: `wss://<server>/ws?token=<token>` for real-time chat
- **HTTP**: `<server>/api/*` for file upload, voice API, status checks

Enter your server URL and API token on the login screen.

## Permissions Required

- **Microphone** — Voice input and phone call mode
- **Speech Recognition** — Real-time transcription
- **Photo Library** — Image selection for file upload
