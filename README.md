# dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness

[![GitHub](https://img.shields.io/badge/GitHub-nanpaidashi/dsh--honcho--sync-blue)](https://github.com/nanpaidashi/dsh-honcho-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![v0.6.0](https://img.shields.io/badge/version-0.6.0-brightgreen)]()

> **Give your DeepSeek Harness AI persistent memory.**
> Auto-sync every conversation turn to a self-hosted Honcho service, and equip the AI with **21 tools** covering the full official Honcho v3 API surface. Configure everything from a visual settings panel — no YAML editing required.

---

## 中文

### 这是什么？

**DeepSeek Harness (DSH) ↔ Honcho 记忆桥接插件。** 安装后 DSH 自动将每轮对话同步到用户自建的 [Honcho](https://github.com/plastic-labs/honcho) 记忆服务（NAS、服务器或云端均可），AI 获得 **21 个内置工具**，覆盖官方 Honcho API 全量端点：检索、推理、画像、会话管理、结论、Dream、队列监控。

### 功能

| 功能 | 说明 |
|------|------|
| **可视化设置面板** | DSH 设置 → "Honcho Memory"，所有配置项图形化编辑 |
| **自动同步** | 每轮对话自动推送到 Honcho（debounce 3s），watermark 去重 |
| **Layer-1 上下文注入** | 会话首条消息时自动加载 peer card + representation + session summary |
| **21 个记忆工具** | 覆盖官方 API：search / dialectic / profile / session / peer / conclude / dream / queue |

### 工具清单（21 个）

| 分类 | 工具 | 说明 |
|------|------|------|
| **记忆** | `honcho_recall` | 7 天窗口语义搜索（快，2-5s） |
| | `honcho_ask` | 辩证推理问答（慢，2-5min） |
| | `honcho_remember` | 保存事实到持久记忆 |
| | `honcho_context` | 读取 session 完整上下文 |
| **搜索** | `honcho_search` | 跨所有 session 搜索（无日期限制） |
| | `honcho_session_search` | 在指定 session 内搜索 |
| **画像** | `honcho_profile` | 获取 peer card（身份/属性/关系/指令） |
| | `honcho_representation` | 获取 working representation（跨会话观察） |
| **会话** | `honcho_session_list` | 列出 workspace 所有 session |
| | `honcho_session_create` | 创建/获取 session |
| | `honcho_session_clone` | 克隆 session |
| | `honcho_session_peers` | 查看 session 关联的 peers |
| | `honcho_session_summaries` | 获取 session 摘要 |
| | `honcho_session_context` | 获取 session 上下文（含 summary） |
| **Peer** | `honcho_peer_list` | 列出所有 peers |
| | `honcho_peer_create` | 创建/获取 peer |
| **结论** | `honcho_conclude` | 创建显式结论（高置信度事实） |
| | `honcho_conclude_list` | 列出结论 |
| | `honcho_conclude_query` | 语义搜索结论 |
| **管理** | `honcho_status` | 服务器健康检查 |
| | `honcho_dream` | 触发离线处理（card_refresh / omni） |
| | `honcho_queue` | 查看处理队列状态 |

### 安装

**前提：** 已部署 [Honcho](https://github.com/plastic-labs/honcho) 记忆服务（Docker 一行命令即可）

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
export HONCHO_USER_PEER="user"                        # 可选
export HONCHO_AGENT_PEER="agent"                      # 可选
```

**方式 3：cordis.patch.yml**

```yaml
- id: honcho-sync
  config:
    honchoUrl: "http://your-honcho-server:8000"
    workspace: "your-workspace"
    userPeer: "user"
    agentPeer: "agent"
    debounceMs: 3000
    autoRecall: true
    recallBudget: 2000
    autoSync: true
    messageMaxChars: 25000
    injectionMaxChars: 4000
```

### 架构

```
DSH Session
    │
    ├─ session/event ──→ 自动同步（debounce + watermark）──→ Honcho API (POST messages)
    │
    ├─ 21 个 honcho_* 工具 ──→ AI 可调用的全量 API 封装
    │
    ├─ 首条 user message ──→ Layer-1 注入（card + representation + summary）
    │
    └─ 设置面板 ──→ /_dsh/dsh-honcho-sync/status (loopback-only)
```

### 同步策略

- **Per-day session ID**：`dsh-<cwd>-YYYY-MM-DD`，每天一个 Honcho session，保持检索空间小
- **Watermark 去重**：记录已同步的 event count，只推送增量
- **Debounce 3s**：避免高频写入

### 依赖

- [Honcho](https://github.com/plastic-labs/honcho) — 需自行部署
- DeepSeek Harness ≥ 0.1.0-rc.6

### 许可证

MIT

---

## English

### What is this?

**A bridge plugin connecting DeepSeek Harness to Honcho memory.** After installation, DSH auto-syncs every conversation turn to a self-hosted [Honcho](https://github.com/plastic-labs/honcho) service (NAS, server, or cloud), and the AI gains **21 built-in tools** covering the full official Honcho v3 API surface: search, dialectic reasoning, peer profiles, session management, conclusions, dream scheduling, and queue monitoring.

### Tools (21)

| Category | Tool | Description |
|----------|------|-------------|
| **Memory** | `honcho_recall` | 7-day window semantic search (fast, 2-5s) |
| | `honcho_ask` | Dialectic reasoning Q&A (slow, 2-5min) |
| | `honcho_remember` | Save facts to persistent memory |
| | `honcho_context` | Read full session context |
| **Search** | `honcho_search` | Cross-all-sessions search (no date filter) |
| | `honcho_session_search` | Search within a specific session |
| **Profile** | `honcho_profile` | Get peer card (identity/attributes/relationships) |
| | `honcho_representation` | Get working representation (cross-session observations) |
| **Session** | `honcho_session_list` | List all sessions in workspace |
| | `honcho_session_create` | Create/get a session |
| | `honcho_session_clone` | Clone a session |
| | `honcho_session_peers` | List session peers |
| | `honcho_session_summaries` | Get session summaries |
| | `honcho_session_context` | Get session context with summary |
| **Peer** | `honcho_peer_list` | List all peers |
| | `honcho_peer_create` | Create/get a peer |
| **Conclude** | `honcho_conclude` | Create explicit conclusions |
| | `honcho_conclude_list` | List conclusions |
| | `honcho_conclude_query` | Semantic search across conclusions |
| **Admin** | `honcho_status` | Server health check |
| | `honcho_dream` | Trigger offline processing (card_refresh / omni) |
| | `honcho_queue` | Check processing queue status |

### Installation

```bash
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web
```

### Configuration

Visual panel (recommended), environment variables, or cordis.patch.yml — see above.

### Architecture

```
DSH Session
    │
    ├─ session/event ──→ Auto-sync (debounce + watermark) ──→ Honcho API
    │
    ├─ 21 honcho_* tools ──→ Full API surface callable by AI
    │
    ├─ First user message ──→ Layer-1 injection (card + representation + summary)
    │
    └─ Settings panel ──→ /_dsh/dsh-honcho-sync/status (loopback-only)
```

### Dependencies

- [Honcho](https://github.com/plastic-labs/honcho) — Self-hosted memory service
- DeepSeek Harness ≥ 0.1.0-rc.6

### License

MIT
