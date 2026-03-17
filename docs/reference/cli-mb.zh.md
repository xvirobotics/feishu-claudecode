# mb CLI（Agent 总线）

`mb` 命令提供终端访问 MetaBot Agent 总线 API。

## 安装

MetaBot 安装器自动安装到 `~/.local/bin/mb`。

## 命令

### Bot 管理

```bash
mb bots                             # 列出所有 Bot（本地 + peer）
mb bot <name>                       # 获取 Bot 详情
```

### Agent 对话

```bash
mb talk <bot> <chatId> <prompt>     # 与 Bot 对话
mb talk alice/bot <chatId> <prompt> # 指定 peer 的 Bot 对话
```

Bot 名称支持[限定名](../features/peers.md#限定名)（`peerName/botName`）实现跨实例路由。

### Peers

```bash
mb peers                            # 列出 peer 及状态
```

### 定时任务

```bash
mb schedule list                                              # 列出全部
mb schedule cron <bot> <chatId> '<cron>' <prompt>            # 创建周期性任务
mb schedule add <bot> <chatId> <delayMs> <prompt>            # 创建一次性任务
mb schedule pause <id>                                        # 暂停
mb schedule resume <id>                                       # 恢复
mb schedule cancel <id>                                       # 取消
```

### 统计与健康

```bash
mb stats                            # 费用与使用统计
mb health                           # 健康检查
```

### 语音

```bash
mb voice "你好世界"                   # 生成 MP3，输出文件路径
mb voice "你好" --play               # 生成并播放音频
mb voice "你好" -o greeting.mp3      # 保存到指定文件
echo "长文本" | mb voice             # 从标准输入读取
mb voice "你好" --provider doubao    # 指定 TTS 服务商
mb voice "你好" --voice nova         # 指定声音
```

| 参数 | 说明 |
|------|------|
| `--play` | 生成后播放（macOS: afplay, Linux: mpv/ffplay/play） |
| `-o FILE` | 保存到指定文件（默认: `/tmp/mb-voice-<时间戳>.mp3`） |
| `--provider NAME` | TTS 服务商: `doubao`、`openai`、`elevenlabs` |
| `--voice ID` | 声音/音色 ID（各服务商不同） |

### 管理

```bash
mb update                           # 拉取 + 构建 + 重启
mb help                             # 显示帮助
```

## 远程访问

默认连接 `http://localhost:9100`。配置远程访问：

```bash
# 在 ~/.metabot/.env 或 ~/metabot/.env 中
METABOT_URL=http://your-server:9100
API_SECRET=your-secret
```
