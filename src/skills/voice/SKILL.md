---
name: voice
description: Convert text to speech audio using mb voice CLI. Use when the user asks you to speak, say something aloud, generate audio, or produce a voice recording.
---

## Text-to-Speech (Voice Output)

Generate MP3 audio from text using the `mb voice` CLI.

### Quick Commands

```bash
# Generate MP3, prints file path to stdout
mb voice "Hello, this is a test"

# Generate and play immediately
mb voice "Hello" --play

# Save to specific file
mb voice "Hello" -o greeting.mp3

# Override provider and voice
mb voice "Hello" --provider doubao --voice zh_female_wanqudashu_moon_bigtts

# Pipe text (useful for long content)
echo "Long text here" | mb voice
echo "Long text" | mb voice -o output.mp3
```

### When to Use

- User asks you to "say", "speak", "read aloud", or "generate audio/voice"
- User wants a voice recording or audio version of text
- User requests TTS (text-to-speech) output

### Available Providers & Voices

**Edge TTS (default, free, no key needed):**
- `zh-CN-XiaoyiNeural` (default) — Female Chinese
- `zh-CN-YunxiNeural` — Male Chinese
- `zh-CN-XiaoxiaoNeural` — Female Chinese
- `en-US-JennyNeural` — Female English

**Doubao (default when Volcengine keys configured):**
- `zh_female_wanqudashu_moon_bigtts` (default) — Female Chinese
- Other Volcengine voice IDs from the TTS console

**OpenAI (when OPENAI_API_KEY set):**
- `alloy` (default), `echo`, `fable`, `onyx`, `nova`, `shimmer`

**ElevenLabs (when ELEVENLABS_API_KEY set):**
- Voice IDs from the ElevenLabs console

### Text Limits

- Doubao: ~300 Chinese characters (longer text is auto-truncated)
- OpenAI / ElevenLabs / Edge: ~4000 characters

### Guidelines

- For short text (greetings, alerts), use inline: `mb voice "text"`
- For longer text, pipe through stdin: `echo "..." | mb voice`
- The output file is MP3 format
- Use `--play` only when the user explicitly wants to hear the audio (it blocks until playback completes)
- When saving files for the user, use `-o` with a descriptive filename
- To send the audio to the user in Feishu, copy the file to the outputs directory:
  `cp /tmp/mb-voice-xxx.mp3 /tmp/metabot-outputs/<chatId>/`
