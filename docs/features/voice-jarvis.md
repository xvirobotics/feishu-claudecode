# Voice Assistant (Jarvis Mode)

Talk to any MetaBot agent hands-free using AirPods and Siri. No app needed — just an iOS Shortcut.

## Three Modes

| Mode | STT | TTS | Quality | Setup |
|------|-----|-----|---------|-------|
| **Web Call** | Doubao / Whisper | Doubao / OpenAI / ElevenLabs | High | 5 min |
| **Simple** (Siri STT) | Siri built-in | Siri Speak Text | Basic | 5 min |
| **Pro** (Server STT) | Doubao / Whisper | Doubao / OpenAI / ElevenLabs | High | 10 min |

**New: Web Call Mode** — No iOS Shortcut needed. Open the Web UI, tap the phone icon, and start talking. VAD auto-detects when you finish speaking. See [Web UI — Phone Call Mode](web-ui.md#phone-call-mode) for details.

**Recommended: Pro mode** — Server-side STT (Doubao or Whisper) has much better speech recognition, especially for Chinese + mixed-language input. Doubao is the default when Volcengine keys are configured.

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

### Pro Mode (Server STT)

```
"Hey Siri, Jarvis"
        ↓
  Record Audio (raw audio capture)
        ↓
  HTTP POST audio to MetaBot /api/voice
        ↓
  Doubao/Whisper STT → Agent → optional TTS
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
- `VOLCENGINE_TTS_APPID` + `VOLCENGINE_TTS_ACCESS_KEY` set in `.env` (for Doubao STT+TTS, recommended), or `OPENAI_API_KEY` (for Whisper STT fallback)

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

> **Custom voice**: Append `&ttsVoice=SPEAKER_ID` to the URL to change the Doubao TTS voice (default: `zh_female_sajiaonvyou_moon_bigtts`). Browse available voices in the [Volcengine TTS console](https://console.volcengine.com/speech/service/8).

### Step 4: Add "Set Variable"

Search and add **Set Variable**:
- **Name**: `audio` (or any name you like)
- **Value**: select **Contents of URL** (previous step)

### Step 5: Add "Play Sound"

Search and add **Play Sound**:
- Input: select the `audio` variable (previous step)

> **Why not "Speak Text"?** — With TTS enabled (default when Volcengine keys are configured), the API returns audio bytes directly, not JSON text. "Play Sound" plays the audio response. If you disable TTS, the API returns JSON — in that case, use "Get Dictionary Value" (key `responseText`) + "Speak Text" instead.

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
| `stt` | `doubao` | STT provider: `doubao` or `whisper` (auto-selects based on available keys) |
| `tts` | `doubao` | TTS provider: `doubao`, `openai`, or `elevenlabs` (auto-selects based on available keys) |
| `ttsVoice` | (per provider) | TTS voice (Doubao: speaker ID; OpenAI: alloy/echo/fable/onyx/nova/shimmer; ElevenLabs: voice ID) |
| `sendCards` | `false` | Also send response to Feishu |
| `voiceMode` | `false` | Enable voice mode (brief responses, `maxTurns=1`) |

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

Server-side STT (Doubao or Whisper) + Agent execution + optional TTS. Defaults to Doubao for both STT and TTS when Volcengine keys are configured.

**Request:**
- Body: raw audio bytes (m4a, wav, webm, mp3, ogg — max 100 MB)
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
| `VOLCENGINE_TTS_APPID` | Required for Doubao STT + TTS (recommended) |
| `VOLCENGINE_TTS_ACCESS_KEY` | Required for Doubao STT + TTS (recommended) |
| `VOLCENGINE_TTS_RESOURCE_ID` | Doubao TTS resource ID (default: `volc.service_type.10029`) |
| `OPENAI_API_KEY` | Fallback for Whisper STT and OpenAI TTS |
| `ELEVENLABS_API_KEY` | Required for ElevenLabs TTS |
| `VOICE_MODEL` | Override Claude model for voice mode (optional) |

## Limitations

- Each interaction requires saying "Hey Siri, Jarvis" again (no continuous conversation loop)
- Siri's dictation may truncate very long voice input (Simple mode only)
- Long agent responses (code, detailed analysis) are better consumed as text in Feishu
- Requires internet connectivity for Siri, Whisper STT, and MetaBot API
- Audio files must be under 100 MB (Doubao) / 25 MB (Whisper)

## Security

- The API endpoint should be protected with `API_SECRET` (Bearer token auth)
- Consider using HTTPS (reverse proxy with Let's Encrypt) for production
- The `chatId` is fixed in the shortcut, so anyone with access to your phone could use it
- Audio files are deleted immediately after transcription
