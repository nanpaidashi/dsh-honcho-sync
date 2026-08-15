# dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness

[![GitHub](https://img.shields.io/badge/GitHub-nanpaidashi/dsh--honcho--sync-blue)](https://github.com/nanpaidashi/dsh-honcho-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH ≥ 0.1.0-rc.6](https://img.shields.io/badge/DSH-≥0.1.0--rc.6-orange)]()

> **Give your DeepSeek Harness AI persistent memory.**
> Auto-sync every conversation turn to a self-hosted Honcho service, and give the AI built-in tools to recall, search, and remember across sessions. Configure everything from a visual settings panel — no YAML editing required.

---

## 中文

### 这是什么？

**DeepSeek Harness (DSH) ↔ Honcho 记忆桥接插件。** 安装后 DSH 自动将每轮对话同步到用户自建的 [Honcho](https://github.com/plastic-labs/honcho) 记忆服务（NAS、服务器或云端均可），AI 获得内置记忆工具，可直接检索、保存跨会话信息。

### 功能

| 功能 | 说明 |
|------|------|
| **可视化设置面板** | DSH 设置 → "Honcho Memory"，所有配置项图形化编辑，无需手动改 YAML |
| **自动同步** | 每轮对话自动推送到 Honcho（默认 debounce 3s），无需 AI 主动操作 |
| **honcho_recall** | 从长期记忆中语义搜索相关上下文，会话开始或重要任务前调用 |
| **honcho_search** | 跨所有 session 精确搜索，适合查找具体信息 |
| **honcho_remember** | 保存重要事实、决策、偏好到持久记忆 |
| **honcho_context** | 读取当前 session 的完整对话上下文 |
| **honcho_status** | 检查 Honcho 服务器健康状态 |
| **上下文注入** | 会话启动时自动从 Honcho 加载近期上下文 |
| **去重** | 同一 session 不重复推送相同内容 |

### 安装

**前提：** 已部署 Honcho 记忆服务（Docker 一行命令即可）

```bash
# 方式 1：从 GitHub 直接安装（推荐）
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web

# 方式 2：从 npm 安装
dsh plugin --profile web add @nanpaidashi/dsh-honcho-sync@latest
```

### 配置

**方式 1：可视化面板（推荐）**

打开 DSH → 左下角 **设置** → **Honcho Memory**，直接填写：

- Honcho URL（API 地址）
- Workspace（工作区名称）
- User / Agent Peer（标识符）
- Debounce、Recall Budget、Max Chars（调优参数）
- Auto Recall / Auto Sync（开关）

点击 **Save** 即生效，无需重启。

**方式 2：环境变量**

```bash
export HONCHO_URL="http://your-honcho-server:8000"   # 必填
export HONCHO_WORKSPACE="your-workspace"              # 必填
```

**方式 3：cordis.patch.yml**

在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加：

```yaml
- id: honcho-sync
  config:
    honchoUrl: "http://your-honcho-server:8000"   # Honcho API 地址（必填）
    workspace: "your-workspace"                    # Workspace 名称
    userPeer: "user"                               # 用户标识
    agentPeer: "agent"                             # Agent 标识
    debounceMs: 3000                               # 同步防抖（毫秒）
    autoRecall: true                               # 会话启动时自动 recall
    recallBudget: 2000                             # recall token 上限
    autoSync: true                                 # 自动同步开关
    messageMaxChars: 25000                         # 单条消息最大字符数
```

环境变量速查：

| 变量 | 默认值 | 必填 | 说明 |
|------|--------|------|------|
| `HONCHO_URL` | — | **是** | Honcho API 地址 |
| `HONCHO_WORKSPACE` | — | **是** | Workspace 名称 |
| `HONCHO_USER_PEER` | `user` | 否 | 用户标识 |
| `HONCHO_AGENT_PEER` | `agent` | 否 | Agent 标识 |
| `HONCHO_DEBOUNCE_MS` | `3000` | 否 | 同步防抖延迟（毫秒） |

### 架构

```
DSH Session
    │
    ├─ session/event ──→ 自动同步（debounce）──→ Honcho API (POST messages)
    │
    ├─ honcho_recall / search / remember / context / status
    │         └────────→ AI 可调用的记忆工具
    │
    ├─ session/start ──→ 上下文自动注入（autoRecall）
    │
    └─ 设置面板 ──→ /_dsh/dsh-honcho-sync/status (loopback-only)
```

### 依赖

- [Honcho](https://github.com/plastic-labs/honcho) — 需自行部署（Docker 一行命令）
- DeepSeek Harness ≥ 0.1.0-rc.6

### 许可证

MIT

---

## English

### What is this?

**A bridge plugin connecting DeepSeek Harness to Honcho memory.** After installation, DSH auto-syncs every conversation turn to a self-hosted [Honcho](https://github.com/plastic-labs/honcho) service (NAS, server, or cloud), and the AI gains built-in tools to recall, search, and remember across sessions. All settings are editable from a visual panel — no YAML editing required.

### Features

| Feature | Description |
|---------|-------------|
| **Visual Settings Panel** | DSH Settings → "Honcho Memory" — all configuration in a graphical UI, no YAML editing |
| **Auto-sync** | Every conversation turn synced to Honcho (debounced 3s default), no AI action needed |
| **honcho_recall** | Semantic search across long-term memory. Call at session start or before important tasks. |
| **honcho_search** | Search across ALL sessions for precise lookups. |
| **honcho_remember** | Save facts, decisions, preferences to persistent memory. |
| **honcho_context** | Get full conversation context for the current session. |
| **honcho_status** | Check Honcho server health. |
| **Context injection** | Auto-load recent context from Honcho on session start. |
| **Deduplication** | Same content in same session won't be pushed twice. |

### Installation

**Prerequisite:** Deploy Honcho first (one Docker command)

```bash
# Option 1: Install from GitHub (recommended)
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web

# Option 2: Install from npm
dsh plugin --profile web add @nanpaidashi/dsh-honcho-sync@latest
```

### Configuration

**Option 1: Visual panel (recommended)**

Open DSH → bottom-left **Settings** → **Honcho Memory**, then fill in:

- Honcho URL (API address)
- Workspace (name)
- User / Agent Peer (identifiers)
- Debounce, Recall Budget, Max Chars (tuning)
- Auto Recall / Auto Sync (toggles)

Click **Save** — takes effect immediately, no restart needed.

**Option 2: Environment variables**

```bash
export HONCHO_URL="http://your-honcho-server:8000"   # required
export HONCHO_WORKSPACE="your-workspace"              # required
```

**Option 3: cordis.patch.yml**

Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: honcho-sync
  config:
    honchoUrl: "http://your-honcho-server:8000"   # Honcho API URL (required)
    workspace: "your-workspace"                    # Workspace name
    userPeer: "user"                               # User identifier
    agentPeer: "agent"                             # Agent identifier
    debounceMs: 3000                               # Sync debounce (ms)
    autoRecall: true                               # Auto-recall on session start
    recallBudget: 2000                             # Token budget for recall
    autoSync: true                                 # Auto-sync toggle
    messageMaxChars: 25000                         # Max chars per message
```

Environment variables:

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `HONCHO_URL` | — | **Yes** | Honcho API base URL |
| `HONCHO_WORKSPACE` | — | **Yes** | Workspace name |
| `HONCHO_USER_PEER` | `user` | No | User peer_id |
| `HONCHO_AGENT_PEER` | `agent` | No | Agent peer_id |
| `HONCHO_DEBOUNCE_MS` | `3000` | No | Sync debounce delay (ms) |

### Architecture

```
DSH Session
    │
    ├─ session/event ──→ Auto-sync (debounced) ──→ Honcho API (POST messages)
    │
    ├─ honcho_recall / search / remember / context / status
    │         └────────→ Memory tools callable by the AI
    │
    ├─ session/start ──→ Context auto-injection (autoRecall)
    │
    └─ Settings panel ──→ /_dsh/dsh-honcho-sync/status (loopback-only)
```

### Dependencies

- [Honcho](https://github.com/plastic-labs/honcho) — Self-hosted memory service (one Docker command)
- DeepSeek Harness ≥ 0.1.0-rc.6

### License

MIT
