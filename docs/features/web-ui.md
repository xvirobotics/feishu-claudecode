# Web UI

A full-featured browser-based chat interface for MetaBot with real-time streaming, voice call mode, and MetaMemory browsing.

## Overview

The Web UI is a React SPA served at `/web/` on your MetaBot server. It connects to any configured bot via WebSocket and provides the same functionality as the Feishu/Telegram chat — plus phone call voice mode.

**URL**: `http://server:9100/web/` (use HTTPS for voice features — see [HTTPS Setup](#https-setup))

## Features

- **Real-time streaming chat** — WebSocket-based streaming with tool call display
- **Markdown rendering** — Syntax highlighting, code blocks, tables
- **Phone call voice mode** — Tap the phone icon for hands-free voice conversation with VAD
- **Interactive questions** — Respond to Claude's pending questions inline
- **Session management** — Multiple sessions, reset, bot switching
- **MetaMemory browser** — Browse and search knowledge base documents
- **Dark/light themes** — System-aware with manual toggle
- **Responsive design** — Works on desktop and mobile

## Quick Start

1. Start MetaBot: `npm run dev` or `metabot start`
2. Open `http://localhost:9100/web/` in your browser
3. Enter your `API_SECRET` as the token
4. Select a bot and start chatting

## Phone Call Mode

Tap the phone icon in the chat input area to enter call mode — a fullscreen overlay for hands-free voice conversation.

### How It Works

```
Tap phone icon → Listening...
        ↓
  Speak (VAD detects speech)  → "Speaking..."
        ↓
  Silence detected (1.8s)     → auto-stop recording
        ↓
  POST audio to /api/voice    → "Thinking..."
        ↓
  Play TTS response           → "Speaking..." (AI)
        ↓
  Auto-start recording again  → "Listening..."
        ↓
  (cycle continues until you hang up)
```

### Voice Activity Detection (VAD)

The call mode uses the Web Audio API's `AnalyserNode` to detect speech in real-time:

- **Speech threshold**: RMS level > 3 triggers "speaking" detection
- **Silence duration**: 1.8 seconds of silence after speech auto-stops recording
- **Visual feedback**: Status text changes between "Listening...", "Speaking...", "Thinking...", and "Speaking..." (AI response)

### Controls

| Action | What it does |
|--------|-------------|
| **Tap center button** (while recording) | Stop recording early |
| **Tap center button** (while playing) | Skip AI response, start next recording |
| **Red hang-up button** | End the call |

### Mobile Support

Mobile browsers require HTTPS for microphone access (`getUserMedia`). Audio playback uses `AudioContext` created during the initial tap gesture to bypass iOS/Android autoplay restrictions.

## HTTPS Setup

HTTPS is **required** for the phone call voice mode on mobile (and recommended for desktop). The easiest approach is [Caddy](https://caddyserver.com/) as a reverse proxy — it handles Let's Encrypt certificates automatically.

### Step 1: Install Caddy

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy
```

### Step 2: Configure DNS

Add an A record for your domain (e.g. `metabot.yourdomain.com`) pointing to your server's public IP. Wait for DNS propagation:

```bash
host metabot.yourdomain.com 1.1.1.1
```

### Step 3: Configure Caddy

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
metabot.yourdomain.com {
    reverse_proxy localhost:9100
}
EOF
sudo systemctl restart caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates. Ports 80 and 443 must be open.

Check status:

```bash
sudo journalctl -u caddy
```

Look for "certificate obtained successfully".

### Step 4: Access

Open `https://metabot.yourdomain.com/web/` in a browser. The phone call button now has microphone access.

!!! note
    WebSocket connections (`/ws`) are automatically proxied by Caddy. No additional WebSocket configuration is needed.

## Architecture

**Frontend stack**: React 19 + Vite + Zustand + react-markdown

**Source**: `web/` directory, builds to `dist/web/`

**WebSocket flow**:

```
Browser → WebSocket (/ws?token=API_SECRET)
       → ws-server.ts
       → MessageBridge.executeApiTask(onUpdate, onQuestion)
       → streaming CardState back to browser
```

### Key Frontend Files

| File | Description |
|------|-------------|
| `web/src/store.ts` | Zustand store (auth, sessions, bots, theme) |
| `web/src/hooks/useWebSocket.ts` | WebSocket with auto-reconnect + exponential backoff |
| `web/src/components/ChatView.tsx` | Main chat interface + phone call overlay |
| `web/src/components/MemoryView.tsx` | MetaMemory document browser |
| `web/src/theme.css` | Design system with CSS custom properties |

### Static File Serving

- Hashed assets (`/web/assets/*-<hash>.js`) get `Cache-Control: public, max-age=31536000, immutable`
- `index.html` gets `Cache-Control: no-cache`
- Missing assets return 404 (not SPA fallback) to prevent stale-cache white-screen issues

## Development

Run the Vite dev server with API/WS proxy:

```bash
cd web && npm run dev
```

This starts Vite on port 5173 with proxy to MetaBot on port 9100.

For production builds:

```bash
npm run build:web    # builds to dist/web/
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_SECRET` | — | Token for WebSocket authentication (`?token=`) |
| `VOICE_MODEL` | — | Override Claude model for voice mode |
| `VOLCENGINE_TTS_APPID` | — | Doubao STT + TTS (recommended for voice) |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | Doubao STT + TTS (recommended for voice) |
| `OPENAI_API_KEY` | — | Fallback for Whisper STT + OpenAI TTS |
