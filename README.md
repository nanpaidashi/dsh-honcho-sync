# dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness

[![GitHub](https://img.shields.io/badge/GitHub-nanpaidashi/dsh--honcho--sync-blue)](https://github.com/nanpaidashi/dsh-honcho-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Give your DeepSeek Harness AI persistent memory.**
> Auto-sync every conversation turn to Honcho, and give the AI built-in tools to recall, search, and remember across sessions.

---

## 中文

### 这是什么？

让 DeepSeek Harness (DSH) AI 拥有**持久记忆**的完整集成方案。安装后 DSH 自动同步所有对话到 NAS 上的 [Honcho](https://github.com/plastic-labs/honcho) 记忆服务，AI 可以直接调用记忆工具。

### 功能清单

| 功能 | 说明 |
|------|------|
| **自动同步** | 每轮对话自动推送到 Honcho（debounce 3s），不依赖 AI 主动操作 |
| **honcho_recall** | 从长期记忆中搜索相关上下文，会话开始或重要任务前调用 |
| **honcho_search** | 跨所有 session 精确搜索，适合查找具体信息 |
| **honcho_remember** | 保存重要事实、决策、偏好到持久记忆 |
| **honcho_context** | 读取当前 session 的完整对话上下文 |
| **honcho_status** | 检查 Honcho 服务器健康状态和统计信息 |
| **上下文注入** | 会话启动时自动从 Honcho 加载近期上下文 |
| **Peer 管理** | 支持自定义用户/Agent 标识（peer_id） |
| **去重** | 同一 session 不重复推送相同内容 |

### 安装

**前提：** 需要先部署 Honcho 记忆服务（NAS 或服务器）

```bash
# 方式 1：从 GitHub 直接安装（推荐）
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web

# 方式 2：从 npm 安装（发布后）
dsh plugin --profile web add @nanpaidashi/dsh-honcho-sync@latest
```

### 配置

通过环境变量或 cordis 配置：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 中追加
- id: honcho-sync
  config:
    honchoUrl: "http://your-honcho-server:8000"
    workspace: "hermes"
    userPeer: "shifu"
    agentPeer: "spenpa"
    debounceMs: 3000
    autoRecall: true
    recallBudget: 2000
```

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HONCHO_URL` | `http://192.168.0.4:8000` | Honcho API 地址 |
| `HONCHO_WORKSPACE` | `hermes` | Workspace 名称 |
| `HONCHO_USER_PEER` | `shifu` | 用户标识 |
| `HONCHO_AGENT_PEER` | `spenpa` | Agent 标识 |
| `HONCHO_DEBOUNCE_MS` | `3000` | 同步防抖延迟 |

### 架构

```
DSH Session
    │
    ├─ ctx.on('session/event') ──→ 自动同步 → Honcho API (POST messages)
    │
    ├─ honcho_recall/search/remember ──→ AI 主动调用的记忆工具
    │
    └─ ctx.on('session/start') ──→ 上下文自动注入
```

### 依赖

- [Honcho](https://github.com/plastic-labs/honcho) — 需要自行部署（Docker 一键）
- DeepSeek Harness ≥ 0.1.0-rc.6

### 许可证

MIT

---

## English

### What is this?

A complete integration between [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Honcho](https://github.com/plastic-labs/honcho), a self-hosted long-term memory service. After installation, DSH auto-syncs every conversation turn to Honcho, and the AI gets built-in tools to recall, search, and remember across sessions.

### Features

| Feature | Description |
|---------|-------------|
| **Auto-sync** | Every conversation turn synced to Honcho (debounced 3s), no AI action needed |
| **honcho_recall** | Search past conversations for relevant context. Call at session start or before important tasks. |
| **honcho_search** | Search across ALL sessions for precise lookups. |
| **honcho_remember** | Save facts, decisions, preferences to long-term memory. |
| **honcho_context** | Get full conversation context for the current session from Honcho. |
| **honcho_status** | Check Honcho server health and statistics. |
| **Context injection** | Auto-load recent context from Honcho on session start. |
| **Peer management** | Configurable user/agent identifiers (peer_id). |
| **Deduplication** | Same content in same session won't be pushed twice. |

### Installation

**Prerequisite:** Deploy Honcho memory service first (on NAS or server)

```bash
# Option 1: Install directly from GitHub (recommended)
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web

# Option 2: Install from npm (after publish)
dsh plugin --profile web add @nanpaidashi/dsh-honcho-sync@latest
```

### Configuration

Via environment variables or cordis config:

```yaml
# Add to ~/.dsh/profiles/web/cordis.patch.yml
- id: honcho-sync
  config:
    honchoUrl: "http://your-honcho-server:8000"
    workspace: "hermes"
    userPeer: "shifu"
    agentPeer: "spenpa"
    debounceMs: 3000
    autoRecall: true
    recallBudget: 2000
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `HONCHO_URL` | `http://192.168.0.4:8000` | Honcho API base URL |
| `HONCHO_WORKSPACE` | `hermes` | Workspace name |
| `HONCHO_USER_PEER` | `shifu` | User peer_id |
| `HONCHO_AGENT_PEER` | `spenpa` | Agent peer_id |
| `HONCHO_DEBOUNCE_MS` | `3000` | Sync debounce delay |

### Architecture

```
DSH Session
    │
    ├─ ctx.on('session/event') ──→ Auto-sync → Honcho API (POST messages)
    │
    ├─ honcho_recall/search/remember ──→ Memory tools AI can call
    │
    └─ ctx.on('session/start') ──→ Context auto-injection
```

### Dependencies

- [Honcho](https://github.com/plastic-labs/honcho) — Self-hosted memory service (Docker one-command deploy)
- DeepSeek Harness ≥ 0.1.0-rc.6

### License

MIT
