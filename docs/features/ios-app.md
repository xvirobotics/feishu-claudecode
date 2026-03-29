# iOS App

A native Swift iOS application for MetaBot — full agent interaction from your iPhone or iPad.

## Overview

The iOS app connects to your MetaBot server via WebSocket and provides a native mobile experience: real-time streaming chat, voice calls with CallKit, VoIP push notifications, and MetaMemory browsing.

**Requirements**: iOS 17.0+, Xcode 15+, Apple Developer Account (for push notifications)

**Source**: `ios/MetaBot/` directory

## Features

### Chat
- **Real-time streaming** — WebSocket with auto-reconnect and heartbeat
- **Markdown rendering** — Rich text via swift-markdown-ui
- **Tool call display** — Collapsible tool call views
- **File upload/download** — PhotosPicker, document picker, inline preview
- **Message context menu** — Long-press to copy/share
- **Haptic feedback** — UIImpactFeedbackGenerator for interactions

### Voice
- **Voice input** — Apple SFSpeechRecognizer real-time transcription with mic button
- **Phone call mode** — Fullscreen voice conversation overlay with VAD (Voice Activity Detection)
- **RTC calls** — Real-time voice/video via VolcEngine RTC SDK
- **CallKit integration** — Native phone UI for incoming/outgoing calls, call history in Phone app
- **VoIP push notifications** — PushKit for call notifications, works even when app is in background

### Multi-Agent
- **Group chat** — Multi-bot conversations with @mention routing
- **Bot switching** — Switch between configured bots in settings
- **Team dashboard** — View all agent statuses and organization overview

### Knowledge
- **MetaMemory browser** — Search and browse documents with folder navigation (1090 LOC)
- **Document viewer** — Full Markdown rendering of memory documents

### Platform
- **iPad split view** — Three-column NavigationSplitView layout for tablets
- **Dark/light/system theme** — Picker in Settings
- **Session management** — Create, switch, delete sessions
- **Keychain auth** — Token stored in iOS secure enclave

## Prerequisites

### 1. Apple Developer Account

You need an Apple Developer account to:
- Build and run on a physical device
- Configure push notifications (VoIP push requires a paid account)
- Generate signing certificates

**Free account** works for building and running locally (no push notifications).
**Paid account** ($99/year) required for VoIP push notifications and TestFlight distribution.

### 2. MetaBot Server

The iOS app connects to a running MetaBot instance. You need:

- A MetaBot server running and accessible from your phone (LAN or public IP)
- HTTPS configured (required for voice features) — see [Web UI docs](web-ui.md#https-setup)
- `API_SECRET` set in your MetaBot `.env`

### 3. Development Tools

- macOS with Xcode 15+
- CocoaPods (`sudo gem install cocoapods`)
- Node.js 20+ (for building MetaBot server)

## Setup Guide

### Step 1: Clone and Open

```bash
cd metabot/ios/MetaBot
pod install
open MetaBot.xcworkspace
```

!!! warning
    Always open `.xcworkspace`, not `.xcodeproj`. CocoaPods requires the workspace.

### Step 2: Configure Signing

1. Open Xcode → Select the MetaBot target
2. Go to **Signing & Capabilities**
3. Select your **Team** (Apple Developer account)
4. Change **Bundle Identifier** to something unique (e.g., `com.yourname.metabot`)
5. Xcode will auto-create provisioning profiles

### Step 3: Configure Push Notifications (Optional)

VoIP push notifications let agents notify you when tasks complete, even when the app is in background.

1. In Xcode → **Signing & Capabilities** → Add **Push Notifications** capability
2. Add **Background Modes** capability → check **Voice over IP** and **Remote notifications**
3. Go to [Apple Developer Portal](https://developer.apple.com/account/resources/authkeys/list)
4. Create an **APNs Key** (Apple Push Notifications service)
5. Download the `.p8` key file
6. Configure your MetaBot server:

```bash
# In .env
APNS_KEY_ID=YOUR_KEY_ID
APNS_TEAM_ID=YOUR_TEAM_ID
APNS_KEY_PATH=/path/to/AuthKey_XXXXX.p8
APNS_BUNDLE_ID=com.yourname.metabot
APNS_ENVIRONMENT=development    # or "production" for TestFlight/App Store
```

### Step 4: Configure VolcEngine RTC (Optional)

For real-time voice/video calls (beyond the basic HTTP voice mode):

1. Register at [VolcEngine Console](https://console.volcengine.com/)
2. Create an RTC application
3. Get your AppID and configure:

```bash
# In .env
VOLCENGINE_RTC_APP_ID=your_app_id
```

The iOS app reads RTC configuration from the server's `/api/rtc/token` endpoint.

### Step 5: Build and Run

1. Connect your iPhone via USB or select a simulator
2. Select the MetaBot scheme in Xcode
3. Press **Cmd+R** to build and run
4. On first launch, enter your MetaBot server URL and API_SECRET

### Step 6: Login

1. Open the app
2. Enter your MetaBot server URL (e.g., `https://metabot.yourdomain.com`)
3. Enter your `API_SECRET` as the token
4. The token is stored in Keychain — you won't need to enter it again

## Architecture

### Key Services

| Service | File | Description |
|---------|------|-------------|
| `AuthService` | `AuthService.swift` | Keychain token management |
| `WebSocketService` | `WebSocketService.swift` | WebSocket with reconnect + heartbeat |
| `VoiceService` | `VoiceService.swift` | SFSpeechRecognizer + AVAudioEngine |
| `VoiceAPIService` | `VoiceAPIService.swift` | POST /api/voice (STT + Agent + TTS) |
| `CallKitService` | `CallKitService.swift` | CallKit provider + CXCallController |
| `RtcVoiceService` | `RtcVoiceService.swift` | VolcEngine RTC voice chat |
| `PushNotificationService` | `PushNotificationService.swift` | VoIP push + local notifications |
| `FileService` | `FileService.swift` | File upload/download |

### Key Views

| View | File | Description |
|------|------|-------------|
| `LoginView` | `LoginView.swift` | Token-based login |
| `MainTabView` | `MainTabView.swift` | iPad split view + iPhone tabs |
| `ChatView` | `ChatView.swift` | Main chat UI |
| `PhoneCallView` | `PhoneCallView.swift` | Fullscreen call overlay |
| `RtcCallView` | `RtcCallView.swift` | RTC video/voice overlay |
| `InputBar` | `InputBar.swift` | Message input with file picker |
| `MemoryView` | `MemoryView.swift` | MetaMemory browser |
| `TeamDashboardView` | `TeamDashboardView.swift` | Team overview |

### Dependencies

| Package | Purpose |
|---------|---------|
| `swift-markdown-ui` | Markdown rendering in SwiftUI |
| `VolcEngineRTC` (CocoaPods) | Real-time voice/video |

## Troubleshooting

### Build Errors

**"No signing certificate"** — Select your team in Signing & Capabilities. If using a free account, you may need to trust the developer in iPhone Settings → General → VPN & Device Management.

**"Module 'VolcEngineRTC' not found"** — Run `pod install` in the `ios/MetaBot/` directory, then open `.xcworkspace`.

**"Minimum deployment target"** — Ensure your device runs iOS 17.0+.

### Runtime Issues

**"Cannot connect to server"** — Check that the server URL is correct and accessible from your phone. If on the same WiFi, use the local IP (e.g., `http://192.168.1.x:9100`). For voice features, HTTPS is required.

**"Push notifications not working"** — Verify APNs configuration in `.env`. VoIP push requires a paid Apple Developer account. Check server logs for push delivery errors.

**"Voice input not working"** — Grant microphone and speech recognition permissions when prompted. On iOS 17+, speech recognition requires explicit user consent.

**"CallKit not showing"** — CallKit requires VoIP push to be configured. The server initiates calls via push notification, which triggers CallKit on the device.
