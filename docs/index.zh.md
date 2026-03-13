# MetaBot

**构建受监督的、自我进化的 Agent 组织的基础设施。**

[![CI](https://img.shields.io/github/actions/workflow/status/xvirobotics/metabot/ci.yml?branch=main&style=flat-square)](https://github.com/xvirobotics/metabot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/xvirobotics/metabot?style=flat-square)](https://github.com/xvirobotics/metabot)

---

Claude Code 是最强的 AI 编码 Agent —— 但它被锁在笔记本终端里。

MetaBot 解放了它。给每个 Agent 一个 Claude Code 大脑、持久化的共享记忆、创建新 Agent 的能力、以及通信总线。全部可以从飞书或 Telegram 手机端控制。

## 核心组件

| 组件 | 说明 |
|------|------|
| **Claude Code 内核** | 每个 Bot 都是完整的 Claude Code 实例 — Read, Write, Edit, Bash, Glob, Grep, WebSearch, MCP 等。`bypassPermissions` 模式自主运行。 |
| **MetaSkill** | Agent 工厂。`/metaskill ios app` 调研最佳实践后生成完整的 `.claude/` Agent 团队。 |
| **MetaMemory** | 内嵌 SQLite 知识库，全文搜索，Web UI。Agent 跨会话读写 Markdown 文档。 |
| **IM Bridge** | 飞书或 Telegram（含手机端）与任意 Agent 对话。带颜色状态的流式卡片。 |
| **Agent 总线** | 9100 端口 REST API。Agent 通过 `mb talk` 互相对话。运行时创建/删除 Bot。 |
| **Peers 联邦** | 跨实例 Bot 发现和任务路由。 |
| **定时任务调度器** | 一次性延迟和周期性 cron 任务。支持时区，跨重启持久化。 |
| **CLI 工具** | `metabot`、`mm`、`mb`、`fd` 命令，管理服务、知识库、Agent 总线和飞书文档。 |

## 快速安装

=== "Linux / macOS"

    ```bash
    curl -fsSL https://raw.githubusercontent.com/xvirobotics/metabot/main/install.sh | bash
    ```

=== "Windows (PowerShell)"

    ```powershell
    irm https://raw.githubusercontent.com/xvirobotics/metabot/main/install.ps1 | iex
    ```

安装器引导：工作目录 → Claude 认证 → IM 凭证 → PM2 自动启动。

[开始使用](getting-started/installation.md){ .md-button .md-button--primary }
[GitHub 仓库](https://github.com/xvirobotics/metabot){ .md-button }
