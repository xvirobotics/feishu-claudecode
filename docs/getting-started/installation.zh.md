# 安装

## 一键安装

=== "Linux / macOS"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
    ```

=== "Windows (PowerShell)"

    ```powershell
    irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
    ```

安装器引导：工作目录 → Claude 认证 → IM 凭证 → PM2 自动启动。

## 更新

已安装？一条命令拉取、构建、重启：

```bash
metabot update
```

## 手动安装

```bash
git clone https://github.com/xvirobotics/metabot.git
cd metabot && npm install
cp bots.example.json bots.json   # 编辑 Bot 配置
cp .env.example .env              # 编辑全局设置
npm run dev
```

## 前置条件

1. **Node.js 20+** 已安装。
2. **Claude Code CLI 已安装并认证** — Agent SDK 以子进程方式启动 `claude`，必须能独立运行。
    - 安装：`npm install -g @anthropic-ai/claude-code`
    - 认证（选一种）：
        - **OAuth 登录（推荐）**：在独立终端运行 `claude login` 完成浏览器认证。
        - **API Key**：在 `.env` 或环境变量中设置 `ANTHROPIC_API_KEY=sk-ant-...`。
    - 验证：在独立终端运行 `claude --version` 和 `claude "hello"` 确认正常。

    !!! warning "注意"
        不能在 Claude Code 会话内运行 `claude login` 或 `claude auth status`（不支持嵌套）。务必使用独立终端。

3. **IM 平台已配置** — 参见[快速配置](quick-setup.md)或[飞书应用配置](feishu-app-setup.md)。

## Windows 说明

PowerShell 安装器自动检测 `winget`/`choco`/`scoop` 来安装 Node.js。CLI 工具（`mm`、`mb`、`metabot`、`fd`）通过 `.cmd` 包装器安装，需要 [Git for Windows](https://git-scm.com)（提供 Git Bash）。
