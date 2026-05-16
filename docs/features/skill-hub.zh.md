# Skill Hub

MetaBot 实例之间的联邦 Skill 共享。Bot 可以发布本地 skill，发现 peer 上的 skill，并安装到 Claude/Codex 工作目录。

## 概述

Skill Hub 把每个 skill 存为：

- `SKILL.md`
- 可选 `references/` bundle
- metadata：author、owner instance、visibility、version、content hash、时间戳

本地 skill 存在 SQLite 中，并通过 FTS5 全文搜索。Peer skill 通过和 Bot 相同的 peer federation 机制发现。

## 发现

```bash
mb skills
mb skills search lark
```

结果包含本地 skill 和健康 peer 的 skill。Peer 条目带 `peerName` / `peerUrl`；本地条目带 owner metadata：

- `ownerInstanceId`
- `ownerInstanceName`
- `visibility`
- `contentHash`

这些字段是后续来源展示、更新检测和签名校验的基础。

## 发布

从 Bot 工作目录发布 skill：

```bash
mb skills publish metabot lark-doc
```

MetaBot 会查找：

```text
<workdir>/.claude/skills/<name>/SKILL.md
<workdir>/.codex/skills/<name>/SKILL.md
```

发布后的 skill 默认是 `visibility: published`。

## 安装

安装本地 skill：

```bash
mb skills install lark-doc metabot
```

从 peer 安装：

```bash
mb skills install lark-doc metabot peer:alice
```

Peer skill 会复制到本地，所以 peer 之后离线也不影响已安装的 skill 使用。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/skills` | 列出 skill；非 peer 请求会包含 peer skill |
| `GET` | `/api/skills/search?q=` | 搜索本地和 peer skill |
| `GET` | `/api/skills/:name` | 获取完整 skill 内容；本地没有时回退到 peer |
| `POST` | `/api/skills` | 直接发布 skill 内容 |
| `POST` | `/api/skills/:name/publish-from-bot` | 从 Bot 工作目录发布 |
| `POST` | `/api/skills/:name/install` | 安装 skill 到 Bot 工作目录 |
| `DELETE` | `/api/skills/:name` | 删除本地 skill |

## 联邦说明

Skill Hub 适合 P2P：

- source copy 存在 owner 实例。
- 其他实例通过 peer polling 持久缓存摘要，默认也缓存完整 `SKILL.md` 内容。
- owner 实例离线时，缓存的 peer skills 会以 stale 结果继续出现；如果已有内容缓存，仍可安装。
- 安装时复制到本地。
- `contentHash` 用于后续更新检测。
- owner metadata 用于 UI 展示来源。
