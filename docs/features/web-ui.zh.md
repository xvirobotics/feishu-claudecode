# Web UI

MetaBot 的浏览器端聊天界面，支持实时流式输出、电话语音模式和 MetaMemory 浏览。

## 概述

Web UI 是一个 React SPA，部署在 MetaBot 服务器的 `/web/` 路径。通过 WebSocket 连接任意已配置的 Bot，提供与飞书/Telegram 聊天相同的功能，外加电话语音模式。

**访问地址**: `http://server:9100/web/`（语音功能需 HTTPS — 见 [HTTPS 设置](#https)）

## 功能

- **实时流式聊天** — 基于 WebSocket 的流式输出，展示工具调用过程
- **Markdown 渲染** — 语法高亮、代码块、表格
- **电话语音模式** — 点击电话图标免手语音对话，VAD 自动检测说完
- **RTC 实时通话** — 基于火山引擎 RTC 的双向语音/视频通话
- **群聊模式** — 多个 Agent 在一个对话中协作，@mention 路由到指定 Agent
- **交互式问答** — 内联回答 Claude 的待确认问题
- **会话管理** — 多会话、重置、切换 Bot
- **MetaMemory 浏览器** — 浏览和搜索知识库文档
- **团队看板** — 查看 Agent 组织状态概览
- **文件支持** — 上传/下载文件，内联预览
- **明暗主题** — 跟随系统或手动切换
- **响应式设计** — 桌面端和移动端均可使用

## 快速开始

1. 启动 MetaBot：`npm run dev` 或 `metabot start`
2. 打开 `http://localhost:9100/web/`
3. 输入 `API_SECRET` 作为 Token
4. 选择一个 Bot 开始聊天

## 电话语音模式

点击聊天输入框的电话图标进入通话模式 — 全屏覆盖层，免手语音对话。

### 工作流程

```
点击电话图标 → 聆听中...
        ↓
  开始说话（VAD 检测到语音）→ "说话中..."
        ↓
  静音检测（1.8秒）→ 自动停止录音
        ↓
  POST 音频到 /api/voice → "思考中..."
        ↓
  播放 TTS 回复 → "说话中..."（AI）
        ↓
  自动开始下一轮录音 → "聆听中..."
        ↓
  （循环持续直到挂断）
```

### 语音活动检测（VAD）

通话模式使用 Web Audio API 的 `AnalyserNode` 实时检测语音：

- **语音阈值**：RMS 电平 > 3 触发"说话中"检测
- **静音时长**：说话后 1.8 秒静音自动停止录音
- **视觉反馈**：状态文字在"聆听中..."、"说话中..."、"思考中..."、"说话中..."（AI 回复）之间切换

### 操作

| 操作 | 效果 |
|------|------|
| **点击中心按钮**（录音中） | 提前停止录音 |
| **点击中心按钮**（播放中） | 跳过 AI 回复，开始下一轮录音 |
| **红色挂断按钮** | 结束通话 |

### 移动端支持

移动端浏览器需要 HTTPS 才能使用麦克风（`getUserMedia`）。音频播放使用在用户点击手势中创建的 `AudioContext`，绕过 iOS/Android 的自动播放限制。

## HTTPS 设置 {#https}

移动端电话语音模式**必须** HTTPS（桌面端也推荐）。最简单的方案是用 [Caddy](https://caddyserver.com/) 做反向代理 — 自动管理 Let's Encrypt 证书。

### 第 1 步：安装 Caddy

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install caddy
```

### 第 2 步：配置 DNS

添加 A 记录指向服务器公网 IP（例如 `metabot.yourdomain.com`）。等待 DNS 生效：

```bash
host metabot.yourdomain.com 1.1.1.1
```

### 第 3 步：配置 Caddy

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
metabot.yourdomain.com {
    reverse_proxy localhost:9100
}
EOF
sudo systemctl restart caddy
```

Caddy 自动获取和续期 Let's Encrypt 证书。需要开放 80 和 443 端口。

查看状态：

```bash
sudo journalctl -u caddy
```

看到 "certificate obtained successfully" 即成功。

### 第 4 步：访问

打开 `https://metabot.yourdomain.com/web/`。电话按钮现在可以使用麦克风了。

!!! note
    WebSocket 连接（`/ws`）由 Caddy 自动代理，无需额外 WebSocket 配置。

## 架构

**前端技术栈**：React 19 + Vite + Zustand + react-markdown

**源码**：`web/` 目录，构建输出到 `dist/web/`

**WebSocket 流程**：

```
浏览器 → WebSocket (/ws?token=API_SECRET)
       → ws-server.ts
       → MessageBridge.executeApiTask(onUpdate, onQuestion)
       → 流式 CardState 推送到浏览器
```

### 主要前端文件

| 文件 | 说明 |
|------|------|
| `web/src/store.ts` | Zustand 状态管理（认证、会话、Bot、主题） |
| `web/src/hooks/useWebSocket.ts` | WebSocket 自动重连 + 指数退避 |
| `web/src/components/ChatView.tsx` | 主聊天界面 + 电话语音覆盖层 |
| `web/src/components/VoiceView.tsx` | 电话语音模式 + VAD |
| `web/src/components/RtcCallOverlay.tsx` | RTC 语音/视频通话 UI |
| `web/src/components/MemoryView.tsx` | MetaMemory 文档浏览器 |
| `web/src/components/TeamDashboard.tsx` | 团队状态概览 |
| `web/src/components/InputBar.tsx` | 消息输入 + 文件附件 |
| `web/src/components/MessageList.tsx` | 实时消息流 |
| `web/src/theme.css` | CSS 自定义属性设计系统 |

### 静态文件服务

- 带 hash 的资源文件（`/web/assets/*-<hash>.js`）使用 `Cache-Control: public, max-age=31536000, immutable`
- `index.html` 使用 `Cache-Control: no-cache`
- 缺失的资源返回 404（而非 SPA 回退），防止缓存过期导致白屏

## 开发

运行 Vite 开发服务器（带 API/WS 代理）：

```bash
cd web && npm run dev
```

Vite 在 5173 端口启动，代理请求到 MetaBot 的 9100 端口。

生产构建：

```bash
npm run build:web    # 构建到 dist/web/
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_SECRET` | — | WebSocket 认证 Token（`?token=`） |
| `VOICE_MODEL` | — | 语音模式使用的 Claude 模型（可选覆盖） |
| `VOLCENGINE_TTS_APPID` | — | 豆包 STT + TTS（推荐用于语音） |
| `VOLCENGINE_TTS_ACCESS_KEY` | — | 豆包 STT + TTS（推荐用于语音） |
| `OPENAI_API_KEY` | — | Whisper STT + OpenAI TTS 备选 |
