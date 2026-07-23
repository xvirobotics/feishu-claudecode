# 安装

## 前置条件

- **Node.js >= 22.19**
- Git
- 至少一个引擎和一个聊天渠道的凭证
- Linux/macOS 才能使用完整的签名校验个人版生命周期

Codex 是默认引擎，Kimi Code 是一级可选引擎；Claude Code 作为现有工作区
的可选兼容引擎保留。

## 一行安装

=== "Linux / macOS"

    ```bash
    curl -fsSL https://github.com/xvirobotics/metabot/releases/latest/download/install.sh | bash
    ```

=== "Windows (PowerShell)"

    ```powershell
    irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
    ```

Linux/macOS 安装器会：

1. 下载最新公开 GitHub Release 并验证 `SHA256SUMS`；
2. 安装本地 Core、仅 Token 登录的 Web UI、Bridge、CLI 和内置 Skills；
3. 把自动生成的 Core Token 以 `0600` 权限保存到 `~/.metabot-core/token`；
4. 引导选择工作区、引擎、认证和 IM 渠道；
5. 将 Core 和 Bridge 作为独立 PM2 应用启动。

个人控制台地址为 `http://localhost:9200`。安装器不会把原始 Token 输出到
日志。Core 数据默认存放在 `~/.metabot-core/`，Bridge 状态默认存放在
`~/.metabot/`。

安装到其他目录：

```bash
METABOT_HOME=/opt/metabot bash install.sh
```

默认目录为 `~/metabot`。

## 引擎认证

请在独立终端执行登录命令。

### Codex CLI（默认）

```bash
npm install -g @openai/codex
codex login
```

MetaBot 公开版当前使用 `codex exec --json` 和 `codex exec resume`，不要求、
也不宣称支持 Codex app-server。

### Kimi Code 0.27+

```bash
npm install -g @moonshot-ai/kimi-code@latest
kimi login
```

MetaBot 使用 Kimi Code 官方 loopback Server API，与 Kimi Web UI 使用同一套
前端协议。该路径不再支持旧 Python `kimi-cli --wire` 集成。

### Claude Code 兼容

只有现有 Bot 或工作区明确选择 `"engine": "claude"` 时，才需要安装并执行
`claude login`。

## 更新

普通 Package 管理的个人版默认升级到最新 GitHub Release：

```bash
metabot update
```

需要固定不可变 Release、不跟随 `latest` 时：

```bash
metabot update --package --version 1.3.0
```

固定版本会从 GitHub v1.3.0 Release 下载 `install.sh`、
`metabot-runtime.tgz` 和 `SHA256SUMS`。Package 更新会验证 runtime SHA256，
校验完整个人版 Manifest 和语义版本；固定包报告的版本不匹配时会失败关闭。

源码 checkout 显式使用 Git：

```bash
metabot update --git
```

Package 覆盖会保留 `.env`、`bots.json`、`data/`、`logs/`、`.git/`、工作区
说明和用户修改过的 Skills。`~/.metabot/` 与 `~/.metabot-core/` 中的用户和
Core 状态位于 runtime 覆盖范围外，同样会被保留。Release 与源码更新路径
相互独立。Package 管理的 `~/.metabot/default.env` 可能随新的安全默认值刷新，
但该目录中其他用户状态不会被删除。

## 使用已有外部 Core

只安装 Bridge 并连接已有 Core：

```bash
METABOT_INSTALL_CORE=0 bash install.sh
```

配置 `METABOT_CORE_URL` 和 `METABOT_CORE_TOKEN`。安装器不会替换其他目录的
Core PM2 进程或其数据。

## 源码开发安装

```bash
git clone https://github.com/xvirobotics/metabot.git ~/metabot
cd ~/metabot
npm ci --include=dev
cp bots.example.json bots.json
cp .env.example .env
npm run dev
```

## Windows 说明

PowerShell 安装器会配置 Bridge，并为 `metabot` CLI 安装 `.cmd` wrapper；需要
Git for Windows。完整本地 Core/Web UI 生命周期目前仍由 Linux/macOS Release
安装器提供，直到 Windows 打包能力达到同等水平。

依赖安装、构建或 PM2 启动失败时，安装器会立即失败；启动后还会等待
`http://127.0.0.1:9100/api/health` 返回成功。失败诊断只输出有限行数的
PM2 信息和日志。PowerShell 安装器不会安装、停止或删除 Core/MetaMemory
服务；请通过 `METABOT_CORE_URL` 和 `METABOT_CORE_TOKEN` 连接已有 Core，
旧的独立 `8100` 端口已废弃。

生成的 wrapper 会保存带引号的 Git Bash 绝对路径。安装器会主动拒绝旧的
`C:\Windows\System32\bash.exe` WSL launcher，因为它无法执行 wrapper 中的
Windows 风格脚本路径。若未找到 Git Bash，请安装 Git for Windows 后重新运行
`install.ps1`。

下一步：[快速配置](quick-setup.md)或详细的[飞书应用配置](feishu-app-setup.md)。
