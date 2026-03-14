# Voice Assistant (Jarvis Mode)

Talk to any MetaBot agent hands-free using AirPods and Siri. No app needed — just an iOS Shortcut.

## Two Modes

| Mode | STT | TTS | Quality | Setup |
|------|-----|-----|---------|-------|
| **Simple** (Siri STT) | Siri built-in | Siri Speak Text | Basic | 5 min |
| **Pro** (Whisper STT) | OpenAI Whisper | OpenAI / ElevenLabs | High | 10 min |

**Recommended: Pro mode** — Whisper has much better speech recognition, especially for Chinese + mixed-language input.

## How It Works

### Simple Mode (Siri STT)

```
"Hey Siri, Jarvis"
        ↓
  Siri dictates your voice → text
        ↓
  HTTP POST to MetaBot /api/talk
        ↓
  Agent executes (Claude Code)
        ↓
  Response spoken back via Siri
```

### Pro Mode (Whisper STT)

```
"Hey Siri, Jarvis"
        ↓
  Record Audio (raw audio capture)
        ↓
  HTTP POST audio to MetaBot /api/voice
        ↓
  Whisper STT → Agent → optional TTS
        ↓
  Response spoken back via Siri or TTS audio
```

Zero screen interaction. Works while walking, hiking, driving.

---

## Pro Mode Setup (Recommended)

### Prerequisites

- iPhone with Siri enabled
- AirPods (or any earphones with Siri support)
- MetaBot server accessible from the internet (public IP + port 9100 open)
- Your `API_SECRET` from MetaBot's `.env`
- `OPENAI_API_KEY` set in MetaBot's `.env` (for Whisper STT)

### Step 1: Create the Shortcut

Open **Shortcuts** app on iPhone → tap **+** → name it **Jarvis**.

### Step 2: Add "Record Audio"

Search and add the **Record Audio** action:
- **Audio Quality**: Normal
- **Start Recording**: On tap (or Immediately)
- **Finish Recording**: On tap (tap again when done speaking)

### Step 3: Add "Get Contents of URL"

Search and add **Get Contents of URL**:

- **URL**: `http://YOUR_SERVER_IP:9100/api/voice?botName=quanwang&chatId=voice_jarvis&language=zh`
- **Method**: `POST`
- **Headers**:
  - `Authorization` = `Bearer YOUR_API_SECRET`
- **Request Body**: `File`
  - Select the **Recorded Audio** variable from step 2

### Step 4: Add "Get Dictionary Value"

Search and add **Get Dictionary Value**:
- Get **Value** for key `responseText`
- From: **Contents of URL** (previous step)

### Step 5: Add "Speak Text"

Search and add **Speak Text**:
- Input: **Dictionary Value** (previous step)

### Step 6: Test

1. Put on AirPods
2. Say **"Hey Siri, Jarvis"**
3. Tap to start recording, speak your command, tap to stop
4. Wait a few seconds — the response will be spoken back

### URL Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `botName` | (required) | Bot to talk to |
| `chatId` | `voice_default` | Session ID for multi-turn |
| `language` | `zh` | STT language hint (`zh`, `en`, `auto`) |
| `tts` | (none) | TTS provider: `openai`, `elevenlabs`, or `doubao` |
| `ttsVoice` | `alloy` | TTS voice (OpenAI: alloy/echo/fable/onyx/nova/shimmer; ElevenLabs: voice ID; Doubao: speaker ID) |
| `sendCards` | `false` | Also send response to Feishu |

---

## Simple Mode Setup (Siri STT)

### Prerequisites

- iPhone with Siri enabled
- AirPods (or any earphones with Siri support)
- MetaBot server accessible from the internet (public IP + port 9100 open)
- Your `API_SECRET` from MetaBot's `.env`

### Step 1: Create the Shortcut

Open **Shortcuts** app on iPhone → tap **+** → name it **Jarvis**.

### Step 2: Add "Dictate Text"

Search and add the **Dictate Text** action:
- **Language**: Chinese (China) — or your preferred language
- **Stop listening**: After pause

### Step 3: Add "Get Contents of URL"

Search and add **Get Contents of URL**:

- **URL**: `http://YOUR_SERVER_IP:9100/api/talk`
- **Method**: `POST`
- **Headers**:
  - `Authorization` = `Bearer YOUR_API_SECRET`
  - `Content-Type` = `application/json`
- **Request Body**: `JSON`
  - `botName` → `quanwang` (or any bot name, text)
  - `chatId` → `voice_jarvis` (text — this creates a persistent session)
  - `prompt` → select the **Dictated Text** variable from step 2

### Step 4: Add "Get Dictionary Value"

Search and add **Get Dictionary Value**:
- Get **Value** for key `responseText`
- From: **Contents of URL** (previous step)

### Step 5: Add "Speak Text"

Search and add **Speak Text**:
- Input: **Dictionary Value** (previous step)

### Step 6: Test

1. Put on AirPods
2. Say **"Hey Siri, Jarvis"**
3. Wait for the dictation prompt, then speak your command
4. Wait a few seconds — the response will be spoken back

## Tips

### Talk to different bots

Create multiple shortcuts with different `botName` values:
- **"Hey Siri, Jarvis"** → `quanwang` (general assistant)
- **"Hey Siri, Goku"** → `goku` (motion control specialist)
- **"Hey Siri, Backend"** → `backend-bot` (backend developer)

### Persistent sessions

The `chatId` field (`voice_jarvis`) creates a persistent Claude session, just like a Feishu chat. Multi-turn conversations work — the agent remembers previous context.

Use different `chatId` values for different conversation threads:
- `voice_jarvis` — general tasks
- `voice_code_review` — code review sessions
- `voice_research` — research tasks

### Remote peers

If the bot is on a remote peer instance, use the qualified name syntax:
- `botName` = `lanqi/some-bot` — routes to the `lanqi` peer automatically

### Feishu cards

Set `sendCards` to `true` (boolean) in the JSON body if you also want to see the response as a Feishu card in your chat. Useful for code-heavy responses you want to read later.

## Voice API Reference

### POST `/api/voice`

Server-side Whisper STT + Agent execution + optional TTS.

**Request:**
- Body: raw audio bytes (m4a, wav, webm, mp3, ogg — max 25 MB)
- Auth: `Authorization: Bearer YOUR_API_SECRET`
- Config via query params (see table above)

**Response (no TTS):**
```json
{
  "success": true,
  "transcript": "帮我看一下项目状态",
  "responseText": "项目当前状态...",
  "costUsd": 0.05,
  "durationMs": 3200
}
```

**Response (with TTS):**
- `Content-Type: audio/mpeg`
- `X-Transcript`: base64-encoded transcript
- `X-Response-Text`: base64-encoded response text (first 2000 chars)
- `X-Cost-Usd`: cost in USD

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for Whisper STT and OpenAI TTS |
| `ELEVENLABS_API_KEY` | Required for ElevenLabs TTS |
| `VOLCENGINE_TTS_APPID` | Required for Doubao TTS |
| `VOLCENGINE_TTS_ACCESS_KEY` | Required for Doubao TTS |
| `VOLCENGINE_TTS_RESOURCE_ID` | Doubao TTS resource ID (default: `volc.service_type.10029`) |

## Limitations

- Each interaction requires saying "Hey Siri, Jarvis" again (no continuous conversation loop)
- Siri's dictation may truncate very long voice input (Simple mode only)
- Long agent responses (code, detailed analysis) are better consumed as text in Feishu
- Requires internet connectivity for Siri, Whisper STT, and MetaBot API
- Whisper audio files must be under 25 MB

## Security

- The API endpoint should be protected with `API_SECRET` (Bearer token auth)
- Consider using HTTPS (reverse proxy with Let's Encrypt) for production
- The `chatId` is fixed in the shortcut, so anyone with access to your phone could use it
- Audio files are deleted immediately after transcription
