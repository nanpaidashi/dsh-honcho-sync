# dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness

[![GitHub](https://img.shields.io/badge/GitHub-nanpaidashi/dsh--honcho--sync-blue)](https://github.com/nanpaidashi/dsh-honcho-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![v0.7.0](https://img.shields.io/badge/version-0.7.0-brightgreen)]()

> **Give your DeepSeek Harness AI persistent memory.**
> Auto-sync every conversation turn to a self-hosted Honcho service, and equip the AI with **25 tools** covering the full official Honcho v3 API surface plus extended endpoints. Configure via environment variables, settings panel, or `cordis.patch.yml`.

---

## 中文

### 这是什么？

**DeepSeek Harness (DSH) ↔ Honcho 记忆桥接插件。** 安装后 DSH 自动将每轮对话同步到用户自建的 [Honcho](https://github.com/plastic-labs/honcho) 记忆服务（NAS、服务器或云端均可），AI 获得 **25 个内置工具**，覆盖官方 Honcho API 全量端点 + 扩展端点：检索、推理、画像、会话管理、消息收发、结论、Dream、队列监控。

### 功能

| 功能 | 说明 |
|------|------|
| **自动同步** | 每轮对话自动推送到 Honcho（debounce 3s），watermark 去重 |
| **持久化状态** | `~/.dsh/honcho-sync-state.json` 保存同步进度，DSH 重启不丢失 cursor |
| **Layer-1 上下文注入** | 会话首条消息时自动加载 peer card + representation + session summary |
| **语义去重** | representation 注入前做 IP/关键词 Jaccard / 3-gram 短语重叠检测，过滤与 peer card 重复的事实 |
| **25 个记忆工具** | 覆盖官方 API + 扩展端点：search / dialectic / profile / session / peer / message / conclude / dream / queue |

### 工具清单（25 个）

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
| **消息** | `honcho_message_send` | 向指定 session 发送消息（扩展） |
| | `honcho_message_get` | 按 message_id 读取单条消息（扩展） |
| **结论** | `honcho_conclude` | 创建显式结论（高置信度事实） |
| | `honcho_conclude_list` | 列出结论 |
| | `honcho_conclude_query` | 语义搜索结论 |
| **管理** | `honcho_status` | 服务器健康检查 |
| | `honcho_dream` | 触发离线处理（card_refresh / omni） |
| | `honcho_queue` | 查看处理队列状态 |

### 自有特色功能说明

#### 1. 语义去重链 (Semantic Deduplication)

Layer-1 注入时，对 Honcho representation 做三级过滤：

1. **时间块拆分** — 按 `[YYYY-MM-DD HH:MM:SS]` 前缀拆分为独立块
2. **Peer Card 重叠检测** — 提取 peer card 中的 IDENTITY/ATTRIBUTE/RELATIONSHIP/INSTRUCTION 事实，与每块内容做语义重叠判断
3. **内容哈希去重** — 基于块内容的 60-char 前缀做 `Map` 去重

**`_semanticOverlap(a, b)` 判断逻辑：**
- **IP 重叠**：双方都包含相同 `192.168.x.x` IP → 判定重复
- **关键词 Jaccard** — 分词后计算 Jaccard 相似度 > 0.3 → 判定重复
- **3-gram 短语重叠** — a 中任意连续 3 词出现在 b 中 → 判定重复

过滤后的 representation 按时间块保留最多 N 条（默认 8 条），并将 UTC 时间转换为 CST (+8h)。

#### 2. 持久化状态 (Persistence)

同步进度写入 `~/.dsh/honcho-sync-state.json`，包含每个 Honcho session 的 `lastSyncedEventCount`。DSH 重启、HMR 热更新后自动恢复 sync cursor，不会重复推送已同步的消息。

#### 3. 动态配置读取 (Dynamic Config)

每次工具调用时通过 `resolveConfig()` 从 `_resolvedSettings` 动态读取配置，settings 面板修改后立即生效，无需重启 DSH。

#### 4. 额外 Honcho API 工具

| 工具 | 端点 | 说明 |
|------|------|------|
| `honcho_message_send` | `POST /sessions/{id}/messages` | 向指定 session 发送消息 |
| `honcho_message_get` | `GET /sessions/{id}/messages/{msg_id}` | 按 ID 读取单条消息 |
| `honcho_session_context` | `GET /sessions/{id}/context` | 获取 session 上下文（含 summary） |
| `honcho_peer_list` | `POST /peers/list` | 列出所有 peers |

这些端点在 Honcho v3 API 中可用但未被上游 v0.6.0 覆盖。

### 安装

**前提：** 已部署 [Honcho](https://github.com/plastic-labs/honcho) 记忆服务

#### 方式 1：从 GitHub 直接安装（推荐）

```bash
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web
```

#### 方式 2：本地手动安装

```bash
# 1. 克隆仓库
git clone https://github.com/nanpaidashi/dsh-honcho-sync.git
cd dsh-honcho-sync
npm run build  # cp src/index.mjs dist/index.js

# 2. 复制文件到 DSH profile
cp dist/index.js ~/.dsh/profiles/web/honcho-sync.mjs

# 3. 在 ~/.dsh/profiles/web/cordis.patch.yml 中添加：
# - insert:
#     - id: honcho-sync
#       name: './honcho-sync.mjs'

# 4. 重启 DSH
systemctl --user restart dsh-web
```

### 配置

**必须配置 `HONCHO_URL` 和 `HONCHO_WORKSPACE`，二选一：**

#### 方式 1：环境变量（推荐）

```bash
export HONCHO_URL="http://your-honcho-server:8000"   # 必填 — Honcho API 地址
export HONCHO_WORKSPACE="hermes"                     # 必填 — Honcho workspace 名称
export HONCHO_USER_PEER="user"                       # 可选 — 默认 "user"
export HONCHO_AGENT_PEER="agent"                     # 可选 — 默认 "agent"
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 中引用：

```yaml
- insert:
    - id: honcho-sync
      name: './honcho-sync.mjs'
      config:
        honchoUrl: __FROM_ENV__
        workspace: ''
        userPeer: user
        agentPeer: agent
        debounceMs: 3000
        autoRecall: true
        recallBudget: 2000
        autoSync: true
        messageMaxChars: 25000
        injectionMaxChars: 4000
```

其中 `honchoUrl: __FROM_ENV__` 表示从 `HONCHO_URL` 环境变量读取。

#### 方式 2：直接写在 cordis.patch.yml

```yaml
- insert:
    - id: honcho-sync
      name: './honcho-sync.mjs'
      config:
        honchoUrl: "http://192.168.0.4:8000"
        workspace: "hermes"
        userPeer: "user"
        agentPeer: "agent"
        debounceMs: 3000
        autoRecall: true
        recallBudget: 2000
        autoSync: true
        messageMaxChars: 25000
        injectionMaxChars: 4000
```

#### 方式 3：通过 DSH settings 服务（运行时配置）

插件通过 DSH `settings` 服务注册了 `honcho-memory` 命名空间。如果 DSH 版本支持 settings UI，可以在设置界面直接修改：

- **honchoUrl** — Honcho API 地址
- **workspace** — Workspace 名称
- **userPeer / agentPeer** — Peer 标识符
- **debounceMs** — 同步防抖延迟（100ms+，默认 3000）
- **autoRecall** — 是否自动 recall（默认 true）
- **recallBudget** — Recall token 预算（默认 2000）
- **autoSync** — 是否自动同步（默认 true）
- **messageMaxChars** — 同步消息最大字符数（默认 25000）
- **injectionMaxChars** — 首条注入最大字符数（默认 4000）
- **reprMaxObs** — representation 保留最大观察数（默认 8）
- **reprTimeoutMs** — representation 请求超时（默认 8000ms）
- **cardTimeoutMs** — peer card 请求超时（默认 5000ms）

### 架构

```
DSH Session
    │
    ├─ session/event ──→ 自动同步（debounce + watermark）──→ Honcho API (POST messages)
    │                      ↓
    │                  ~/.dsh/honcho-sync-state.json 持久化
    │
    ├─ 25 个 honcho_* 工具 ──→ AI 可调用的全量 API 封装
    │
    └─ 首条 user message ──→ Layer-1 注入（语义去重后的 card + representation + summary）
```

### 同步策略

- **Per-day session ID**：`dsh-<cwd>-YYYY-MM-DD`，每天一个 Honcho session，保持检索空间小
- **Watermark 去重**：记录已同步的 event count，只推送增量
- **Debounce 3s**：避免高频写入
- **持久化状态**：`~/.dsh/honcho-sync-state.json` 保存 sync cursor，DSH 重启不丢失

### 参数调优建议

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `debounceMs` | 3000 | 对话结束后等待多久才推送 Honcho。多轮快速对话可适当增大 |
| `messageMaxChars` | 25000 | 单次同步的最大消息字符数。对话很长时调大，节省 Honcho token 时调小 |
| `recallBudget` | 2000 | Layer-1 注入时 recall 的 token 预算。peer card 通常 500-1500 tokens |
| `injectionMaxChars` | 4000 | Layer-1 注入的最大字符数。包含 peer card + representation + session summary |
| `reprMaxObs` | 8 | representation 注入时保留的最大观察数（语义去重后） |
| `reprTimeoutMs` | 8000 | representation POST 请求超时（毫秒） |
| `cardTimeoutMs` | 5000 | peer card GET 请求超时（毫秒） |

### 依赖

- [Honcho](https://github.com/plastic-labs/honcho) — 需自行部署
- DeepSeek Harness ≥ 0.1.0-rc.6

### 许可证

MIT

---

## English

### What is this?

**A bridge plugin connecting DeepSeek Harness to Honcho memory.** After installation, DSH auto-syncs every conversation turn to a self-hosted [Honcho](https://github.com/plastic-labs/honcho) service (NAS, server, or cloud), and the AI gains **25 built-in tools** covering the full official Honcho v3 API surface plus extended endpoints: search, dialectic reasoning, peer profiles, session management, message send/retrieve, conclusions, dream scheduling, and queue monitoring.

### Tools (25)

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
| **Message** | `honcho_message_send` | Send message to a session (extended) |
| | `honcho_message_get` | Get single message by ID (extended) |
| **Conclude** | `honcho_conclude` | Create explicit conclusions |
| | `honcho_conclude_list` | List conclusions |
| | `honcho_conclude_query` | Semantic search across conclusions |
| **Admin** | `honcho_status` | Server health check |
| | `honcho_dream` | Trigger offline processing (card_refresh / omni) |
| | `honcho_queue` | Check processing queue status |

### Unique Features

#### 1. Semantic Deduplication

Before injecting Honcho representation into DSH context, the plugin applies a 3-stage filter:

1. **Time-block splitting** — splits representation by `[YYYY-MM-DD HH:MM:SS]` prefixes
2. **Peer card overlap detection** — extracts IDENTITY/ATTRIBUTE/RELATIONSHIP/INSTRUCTION facts from peer cards and checks for semantic overlap with each block
3. **Content-based deduplication** — deduplicates blocks sharing the same 60-char content prefix

**`_semanticOverlap(a, b)` checks:**
- **IP overlap** — both contain the same `192.168.x.x` IP → duplicate
- **Keyword Jaccard similarity** — tokenized words Jaccard > 0.3 → duplicate
- **3-gram phrase overlap** — any consecutive 3-word sequence from a found in b → duplicate

Result: representation is trimmed to max N observations (default 8), with UTC times converted to CST (+8h).

#### 2. Persistent State

Sync progress saved to `~/.dsh/honcho-sync-state.json` with `lastSyncedEventCount` per Honcho session. Survives DSH restarts and HMR — no duplicate pushes.

#### 3. Dynamic Config Resolution

Each tool call reads config via `resolveConfig()` from `_resolvedSettings`. Settings panel changes take effect immediately without restarting DSH.

#### 4. Extended Honcho API Tools

| Tool | Endpoint | Description |
|------|----------|-------------|
| `honcho_message_send` | `POST /sessions/{id}/messages` | Send a message to a session |
| `honcho_message_get` | `GET /sessions/{id}/messages/{msg_id}` | Get single message by ID |
| `honcho_session_context` | `GET /sessions/{id}/context` | Get session context with summary |
| `honcho_peer_list` | `POST /peers/list` | List all peers |

### Installation

#### Method 1: Direct from GitHub (Recommended)

```bash
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web
```

#### Method 2: Manual local installation

```bash
git clone https://github.com/nanpaidashi/dsh-honcho-sync.git
cd dsh-honcho-sync
npm run build
cp dist/index.js ~/.dsh/profiles/web/honcho-sync.mjs
# Add to ~/.dsh/profiles/web/cordis.patch.yml:
# - insert:
#     - id: honcho-sync
#       name: './honcho-sync.mjs'
systemctl --user restart dsh-web
```

### Configuration

**`HONCHO_URL` and `HONCHO_WORKSPACE` are required — configure via one of:**

#### Method 1: Environment Variables (Recommended)

```bash
export HONCHO_URL="http://your-honcho-server:8000"   # Required
export HONCHO_WORKSPACE="hermes"                     # Required
export HONCHO_USER_PEER="user"                       # Optional, default "user"
export HONCHO_AGENT_PEER="agent"                     # Optional, default "agent"
```

Then in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: honcho-sync
      name: './honcho-sync.mjs'
      config:
        honchoUrl: __FROM_ENV__
        workspace: ''
        debounceMs: 3000
        autoRecall: true
        recallBudget: 2000
        autoSync: true
        messageMaxChars: 25000
        injectionMaxChars: 4000
```

`honchoUrl: __FROM_ENV__` reads from the `HONCHO_URL` environment variable.

#### Method 2: Direct in cordis.patch.yml

```yaml
- insert:
    - id: honcho-sync
      name: './honcho-sync.mjs'
      config:
        honchoUrl: "http://192.168.0.4:8000"
        workspace: "hermes"
```

#### Method 3: DSH Settings Service (Runtime)

The plugin registers a `honcho-memory` namespace via the DSH `settings` service. If your DSH version supports a settings UI, you can modify all parameters at runtime without restarting.

### Architecture

```
DSH Session
    │
    ├─ session/event ──→ Auto-sync (debounce + watermark) ──→ Honcho API
    │                      ↓
    │                  ~/.dsh/honcho-sync-state.json persistence
    │
    ├─ 25 honcho_* tools ──→ Full API surface callable by AI
    │
    └─ First user message ──→ Layer-1 injection (deduplicated card + representation + summary)
```

### Sync Strategy

- **Per-day session ID**: `dsh-<cwd>-YYYY-MM-DD`, one Honcho session per day
- **Watermark deduplication**: tracks synced event count, only pushes deltas
- **Debounce 3s**: avoids high-frequency writes
- **Persistent state**: `~/.dsh/honcho-sync-state.json` saves sync cursor across restarts

### Parameter Tuning

| Parameter | Default | Description |
|-----------|---------|-------------|
| `debounceMs` | 3000 | Delay before pushing to Honcho after conversation ends |
| `messageMaxChars` | 25000 | Max characters per sync push |
| `recallBudget` | 2000 | Token budget for Layer-1 context recall |
| `injectionMaxChars` | 4000 | Max chars for Layer-1 injection (card + representation + summary) |
| `reprMaxObs` | 8 | Max observations kept after semantic deduplication |
| `reprTimeoutMs` | 8000 | Representation POST timeout (ms) |
| `cardTimeoutMs` | 5000 | Peer card GET timeout (ms) |

### Dependencies

- [Honcho](https://github.com/plastic-labs/honcho) — Self-hosted memory service
- DeepSeek Harness ≥ 0.1.0-rc.6

### License

MIT
