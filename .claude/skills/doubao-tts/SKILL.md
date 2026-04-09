---
name: doubao-tts
description: Generate high-quality speech audio using Doubao (豆包/Volcengine) TTS API. Use this skill when the user asks to generate audio, podcasts, voiceovers, or text-to-speech output.
---

# Doubao TTS — 豆包语音合成

Generate high-quality speech audio from text using Volcengine's Doubao TTS API. Supports short-form (real-time) and long-form (async, up to 100K characters) synthesis.

## When to Use
- User asks to generate audio, podcasts, voiceovers, or narration
- User wants text-to-speech for any content
- User asks to "read this aloud" or "make an audio version"

## Quick Usage

Use the `doubao-tts` CLI tool (installed at `bin/doubao-tts`):

```bash
# Short text (real-time, < 300 chars)
bin/doubao-tts "你好世界" -o output.mp3

# Long text from file (async mode, up to 100K chars)
bin/doubao-tts -f article.txt -o podcast.mp3

# Pipe content
echo "Hello world" | bin/doubao-tts -o hello.mp3

# Choose voice
bin/doubao-tts "你好" -v zh_male_aojiaobazong_moon_bigtts -o output.mp3

# Adjust speed/volume/pitch
bin/doubao-tts "你好" --speed 1.2 --volume 1.5 -o output.mp3
```

## Available Voices (已验证可用)

### Chinese Female
| Voice ID | Description |
|----------|-------------|
| `zh_female_sajiaonvyou_moon_bigtts` | 撒娇女友 (default) |
| `zh_female_gaolengyujie_moon_bigtts` | 高冷御姐 |
| `zh_female_tianmeixiaoyuan_moon_bigtts` | 甜美校园 |
| `zh_female_yuanqinvyou_moon_bigtts` | 元气女友 |
| `zh_female_wanwanxiaohe_moon_bigtts` | 弯弯小何 |
| `zh_female_linjianvhai_moon_bigtts` | 邻家女孩 |

### Chinese Male
| Voice ID | Description |
|----------|-------------|
| `zh_male_aojiaobazong_moon_bigtts` | 傲娇霸总 |
| `zh_male_jingqiangkanye_moon_bigtts` | 京腔侃爷 |
| `zh_male_wennuanahu_moon_bigtts` | 温暖阿虎 |
| `zh_male_yangguangqingnian_moon_bigtts` | 阳光青年 |

> Note: 其他音色 (BV系列, mars后缀) 需要不同的 resource ID。如需更多音色，请在火山引擎控制台开通对应资源。

## API Details

### Environment Variables (already configured in MetaBot .env)
```
VOLCENGINE_TTS_APPID=<app_id>
VOLCENGINE_TTS_ACCESS_KEY=<access_key>
VOLCENGINE_TTS_RESOURCE_ID=volc.service_type.10029  (optional)
```

### Short-form API (real-time, < 300 chars)
- Endpoint: `https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- Response: chunked JSON with base64 audio in `data` field
- Latency: < 1 second

### Long-form API (async, up to 100K chars)
- Submit: `POST https://openspeech.bytedance.com/api/v1/tts_async/submit`
- Query: `GET https://openspeech.bytedance.com/api/v1/tts_async/query?appid=X&task_id=Y`
- Response: `audio_url` (valid for 1 hour)
- Latency: seconds to minutes depending on text length

## Workflow for Podcasts

1. **Write the script** — Create the podcast script as markdown or plain text
2. **Generate audio** — Use `bin/doubao-tts -f script.txt -v zh_male_aojiaobazong_moon_bigtts -o podcast.mp3`
3. **Copy to outputs** — `cp podcast.mp3 /tmp/metabot-outputs/<chatId>/` to send to user
4. For multi-voice podcasts, generate each speaker's segments separately, then concatenate with `ffmpeg`

## Multi-Voice Podcast Example

```bash
# Generate segments for different speakers
bin/doubao-tts -f host_lines.txt -v zh_male_aojiaobazong_moon_bigtts -o host.mp3
bin/doubao-tts -f guest_lines.txt -v zh_female_gaolengyujie_moon_bigtts -o guest.mp3

# Concatenate (requires ffmpeg)
echo "file 'host.mp3'" > list.txt
echo "file 'guest.mp3'" >> list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy podcast.mp3
```

## Raw curl (if CLI not available)

```bash
# Short-form
curl -X POST "https://openspeech.bytedance.com/api/v3/tts/unidirectional" \
  -H "Content-Type: application/json" \
  -H "X-Api-App-Id: $VOLCENGINE_TTS_APPID" \
  -H "X-Api-Access-Key: $VOLCENGINE_TTS_ACCESS_KEY" \
  -H "X-Api-Resource-Id: volc.service_type.10029" \
  -H "X-Api-Request-Id: $(uuidgen)" \
  -d '{
    "req_params": {
      "text": "你好世界",
      "speaker": "zh_female_sajiaonvyou_moon_bigtts",
      "audio_params": {"format": "mp3", "sample_rate": 24000}
    }
  }' | python3 -c "
import sys, json, base64
chunks = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        if d.get('data'): chunks.append(base64.b64decode(d['data']))
    except: pass
sys.stdout.buffer.write(b''.join(chunks))
" > output.mp3
```
