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
    │   ├── ChatMessage.swift
    │   ├── FileAttachment.swift
    │   └── WebSocketMessages.swift
    ├── Services/              # Network + Auth
    │   ├── AuthService.swift      # Keychain token management
    │   ├── FileService.swift      # File upload/download
    │   └── WebSocketService.swift # WebSocket with reconnect + heartbeat
    ├── ViewModels/
    │   └── AppState.swift     # @Observable global state
    ├── Views/
    │   ├── LoginView.swift
    │   ├── MainTabView.swift  # iPad split view + iPhone tabs
    │   ├── BotList/           # Agent cards
    │   ├── Chat/              # Chat UI (messages, input, tools, markdown)
    │   ├── Memory/            # MetaMemory browser
    │   └── Settings/
    └── Utilities/
        └── GradientAvatar.swift
```

## Features (Phase 1 - MVP)

- Token-based login (stored in Keychain)
- Bot list with gradient avatars and status
- Real-time streaming chat via WebSocket
- Markdown rendering (swift-markdown-ui)
- Tool call display with expand/collapse
- Pending question UI
- Session management (create, switch, delete)
- Auto-scroll with manual override
- iPad split view layout
- iPhone tab-based navigation
- Dark/light theme support
- MetaMemory document browser
- Settings (connection, agents, data management)

## Server Connection

The app connects to your MetaBot server via:
- **WebSocket**: `wss://<server>/ws?token=<token>` for real-time chat
- **HTTP**: `<server>/api/*` for file upload, status checks

Enter your server URL and API token on the login screen.
