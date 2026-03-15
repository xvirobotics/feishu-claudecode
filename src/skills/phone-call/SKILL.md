---
name: phone-call
description: "Initiate phone calls to users via Twilio. Use when the user asks to be called, notified by phone, or wants a voice conversation."
---

## Phone Call

Call users via Twilio phone integration. After the initial message plays, the call enters a multi-turn voice conversation — the user can ask follow-up questions by speaking.

### Quick Commands

```bash
# Call with a message (speaks the message, then enters voice conversation)
mb call +1234567890 "Your task is complete. The results show..."

# Call without a message (greets, then listens)
mb call +1234567890

# Call using the default number (TWILIO_CALLBACK_NUMBER from .env)
mb call

# Specify which bot handles the conversation
mb call +1234567890 -b metabot "Here are the results..."

# Reuse an existing chat session for context continuity
mb call +1234567890 --chat !`echo $METABOT_CHAT_ID` "I finished the analysis."
```

### When to Use

- User says "call me when done", "tell me by phone", "notify me by call"
- User provides a phone number and wants voice notification
- After completing a long task where user requested phone notification
- User says "打电话告诉我", "做完了给我打电话"

### How It Works

1. If a `message` is provided, it is spoken first (TTS), then the call enters a conversation loop where the user can ask follow-up questions by voice.
2. If no message, the call starts with a greeting and immediately listens.
3. If `--chat` is used with the current chat ID, the phone conversation has full context of this session. The user can ask follow-up questions about the work you just did.
4. The call ends when the user hangs up or is silent for too long.

### Guidelines

- Always confirm the phone number with the user before calling
- Keep the spoken message concise (1-3 sentences) — long text is truncated by TTS
- Use `--chat` with the current session's chatId for context continuity
- Phone numbers must include country code (e.g., +86 for China, +1 for US)
- During the phone call, Claude uses a fast model with no tools — only conversation

### API Reference

```bash
curl -s -X POST http://localhost:!`echo ${METABOT_API_PORT:-9100}`/api/call \
  -H "Authorization: Bearer $METABOT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+1234567890","message":"Task complete.","botName":"!`echo $METABOT_BOT_NAME`","chatId":"!`echo $METABOT_CHAT_ID`"}'
```

Response: `{"success":true,"callSid":"CA...","taskId":"..."}`
