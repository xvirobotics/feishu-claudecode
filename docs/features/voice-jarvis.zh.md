# 语音助手（Jarvis 模式）

通过 AirPods 和 Siri 免手免屏与任意 MetaBot Agent 语音交流。无需安装 App，只用 iOS 快捷指令。

## 两种模式

| 模式 | STT | TTS | 质量 | 配置时间 |
|------|-----|-----|------|---------|
| **简单模式**（Siri STT） | Siri 内置 | Siri 朗读 | 基础 | 5 分钟 |
| **Pro 模式**（服务端 STT） | 豆包 / Whisper | 豆包 / OpenAI / ElevenLabs | 高质量 | 10 分钟 |

**推荐：Pro 模式** — 服务端 STT（豆包或 Whisper）语音识别效果远优于 Siri，尤其是中文和中英混合输入。配置火山引擎密钥后默认使用豆包。

## 工作原理

### 简单模式（Siri STT）

```
"Hey Siri, Jarvis"
        ↓
  Siri 听写语音 → 文字
        ↓
  HTTP POST 到 MetaBot /api/talk
        ↓
  Agent 执行任务（Claude Code）
        ↓
  通过 Siri 语音回复
```

### Pro 模式（服务端 STT）

```
"Hey Siri, Jarvis"
        ↓
  录制音频（原始音频捕获）
        ↓
  HTTP POST 音频到 MetaBot /api/voice
        ↓
  豆包/Whisper STT → Agent → 可选 TTS
        ↓
  通过 Siri 或 TTS 音频回复
```

全程不用看屏幕。走路、爬山、开车时都能用。

---

## Pro 模式设置（推荐）

### 前置条件

- 开启 Siri 的 iPhone
- AirPods（或任何支持 Siri 的耳机）
- MetaBot 服务器可从外网访问（公网 IP + 9100 端口开放）
- MetaBot `.env` 中的 `API_SECRET`
- MetaBot `.env` 中设置 `VOLCENGINE_TTS_APPID` + `VOLCENGINE_TTS_ACCESS_KEY`（推荐，用于豆包 STT+TTS），或 `OPENAI_API_KEY`（用于 Whisper STT 备选）

### 第 1 步：创建快捷指令

打开 iPhone **快捷指令** App → 右上角 **+** → 命名为 **Jarvis**

### 第 2 步：添加「录制音频」

搜索添加 **录制音频** 动作：
- **音频质量**：正常
- **开始录制**：轻点时（或立即）
- **结束录制**：轻点时（说完后再点一下）

### 第 3 步：添加「获取 URL 内容」

搜索添加 **获取 URL 内容** 动作：

- **URL**：`http://你的服务器IP:9100/api/voice?botName=quanwang&chatId=voice_jarvis&language=zh`
- **方法**：`POST`
- **头部**：
  - `Authorization` = `Bearer 你的API_SECRET`
- **请求体**：`文件`
  - 选择上一步的 **录制的音频** 变量

> **注意**：URL 字段填固定地址（包含查询参数），「录制的音频」作为文件请求体发送。

### 第 4 步：添加「获取词典值」

搜索添加 **获取词典值** 动作：
- 获取 `responseText` 的 **值**
- 从：**URL 的内容**（上一步结果）

### 第 5 步：添加「朗读文本」

搜索添加 **朗读文本** 动作：
- 输入选择上一步的 **词典值**

### 第 6 步：测试

1. 戴上 AirPods
2. 说 **"Hey Siri, Jarvis"**
3. 点击开始录音，说出指令，点击停止
4. 等几秒 — 回复会通过耳机播放

### URL 查询参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `botName` | （必填） | 要对话的 Bot |
| `chatId` | `voice_default` | 会话 ID，用于多轮对话 |
| `language` | `zh` | STT 语言提示（`zh`、`en`、`auto`） |
| `stt` | `doubao` | STT 服务：`doubao` 或 `whisper`（根据已配置的密钥自动选择） |
| `tts` | `doubao` | TTS 服务：`doubao`、`openai` 或 `elevenlabs`（根据已配置的密钥自动选择） |
| `ttsVoice` | （按服务商） | TTS 声音（豆包: speaker ID；OpenAI: alloy/echo/fable/onyx/nova/shimmer；ElevenLabs: voice ID） |
| `sendCards` | `false` | 同时发送到飞书 |

---

## 简单模式设置（Siri STT）

### 前置条件

- 开启 Siri 的 iPhone
- AirPods（或任何支持 Siri 的耳机）
- MetaBot 服务器可从外网访问（公网 IP + 9100 端口开放）
- MetaBot `.env` 中的 `API_SECRET`

### 第 1 步：创建快捷指令

打开 iPhone **快捷指令** App → 右上角 **+** → 命名为 **Jarvis**

### 第 2 步：添加「听写文本」

搜索添加 **听写文本** 动作：
- **语言**：中文（中国）
- **停止聆听**：暂停之后

### 第 3 步：添加「获取 URL 内容」

搜索添加 **获取 URL 内容** 动作：

- **URL**：`http://你的服务器IP:9100/api/talk`
- **方法**：`POST`
- **头部**：
  - `Authorization` = `Bearer 你的API_SECRET`
  - `Content-Type` = `application/json`
- **请求体**：`JSON`
  - `botName` → `quanwang`（文本，或你想对话的 bot 名）
  - `chatId` → `voice_jarvis`（文本，用于保持会话连续性）
  - `prompt` → 选择上一步的 **听写的文本** 变量

> **注意**：URL 字段填固定地址，不要把「听写的文本」放进 URL 里。「听写的文本」只放在请求体的 `prompt` 字段。

### 第 4 步：添加「获取词典值」

搜索添加 **获取词典值** 动作：
- 获取 `responseText` 的 **值**
- 从：**URL 的内容**（上一步结果）

### 第 5 步：添加「朗读文本」

搜索添加 **朗读文本** 动作：
- 输入选择上一步的 **词典值**

### 第 6 步：测试

1. 戴上 AirPods
2. 说 **"Hey Siri, Jarvis"**
3. 等待听写提示，说出你的指令
4. 等几秒 — 回复会通过耳机播放

## 使用技巧

### 跟不同的 Bot 对话

创建多个快捷指令，设置不同的 `botName`：
- **"Hey Siri, Jarvis"** → `quanwang`（通用助手）
- **"Hey Siri, Goku"** → `goku`（运动控制专家）
- **"Hey Siri, 后端"** → `backend-bot`（后端开发）

### 持久会话

`chatId`（`voice_jarvis`）创建持久的 Claude 会话，和飞书聊天一样。多轮对话有效 — Agent 记得上下文。

不同场景用不同的 `chatId`：
- `voice_jarvis` — 日常任务
- `voice_code_review` — 代码审查
- `voice_research` — 调研任务

### 远程 Peer

如果 Bot 在远程 Peer 实例上，使用限定名语法：
- `botName` = `lanqi/some-bot` — 自动路由到 `lanqi` peer

### 飞书卡片同步

在请求中加 `sendCards` = `true`，回复会同时发送到飞书聊天卡片。适合代码等需要稍后阅读的内容。

## Voice API 参考

### POST `/api/voice`

服务端 STT（豆包或 Whisper）+ Agent 执行 + 可选 TTS。配置火山引擎密钥后默认使用豆包。

**请求：**
- Body：原始音频字节（m4a、wav、webm、mp3、ogg — 最大 100 MB）
- 认证：`Authorization: Bearer YOUR_API_SECRET`
- 配置通过 URL 查询参数（见上表）

**响应（无 TTS）：**
```json
{
  "success": true,
  "transcript": "帮我看一下项目状态",
  "responseText": "项目当前状态...",
  "costUsd": 0.05,
  "durationMs": 3200
}
```

**响应（带 TTS）：**
- `Content-Type: audio/mpeg`
- `X-Transcript`：base64 编码的转录文本
- `X-Response-Text`：base64 编码的响应文本（前 2000 字符）
- `X-Cost-Usd`：费用（美元）

**环境变量：**

| 变量 | 说明 |
|------|------|
| `VOLCENGINE_TTS_APPID` | 豆包 STT + TTS 必需（推荐，火山引擎控制台获取） |
| `VOLCENGINE_TTS_ACCESS_KEY` | 豆包 STT + TTS 必需（推荐，火山引擎控制台获取） |
| `VOLCENGINE_TTS_RESOURCE_ID` | 豆包 TTS 资源 ID（默认: `volc.service_type.10029`） |
| `OPENAI_API_KEY` | Whisper STT 和 OpenAI TTS 备选 |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS 必需 |

## 限制

- 每次交互需要重新说 "Hey Siri, Jarvis"（无法持续对话循环）
- Siri 听写对很长的语音输入可能截断（仅简单模式）
- 长回复（代码、详细分析）更适合在飞书中阅读
- 需要网络连接（Siri + Whisper STT + MetaBot API）
- 音频文件需小于 100 MB（豆包）/ 25 MB（Whisper）

## 安全

- API 端点通过 `API_SECRET`（Bearer token）保护
- 生产环境建议用 HTTPS（反向代理 + Let's Encrypt）
- `chatId` 固定在快捷指令中，有手机权限即可使用
- 音频文件转录后立即删除
