# @nanpaidashi/dsh-honcho-sync

Honcho Memory Plugin for [DeepSeek Harness](https://github.com/DeepSeek-AI/dsh) — give your AI persistent, cross-session memory backed by a self-hosted [Honcho](https://github.com/plastic-labs/honcho) v3 service.

[中文](#中文说明) | English

---

## What it does

- **Auto-sync**: Every conversation turn is automatically synced to Honcho (with debounce). Sync cursors persist across restarts.
- **Hybrid recall**: Semantic search across both raw messages AND reasoned conclusions (explicit/deductive/inductive) in parallel.
- **Memory injection**: On session start, relevant peer cards, representations, and semantic recall results are injected into the system prompt.
- **25 tools**: Full Honcho v3 API surface exposed as DSH tools — search, profile, session management, peer management, conclusions, dreaming, queue monitoring.

## Requirements

- DeepSeek Harness (DSH) with web profile
- A running Honcho v3 instance (self-hosted)
- Node.js >= 18

## Installation

```bash
# From npm
dsh plugin --profile web add npm:@nanpaidashi/dsh-honcho-sync dsh web

# Or from GitHub
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web
```

Then restart DSH:

```bash
systemctl --user restart dsh-web
# or: dsh web --restart
```

## Upgrading

If you installed an earlier version (v0.6.x or v0.7.0):

```bash
# Re-run the same install command — it pulls the latest version and overwrites
dsh plugin --profile web add npm:@nanpaidashi/dsh-honcho-sync dsh web
# or
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web

systemctl --user restart dsh-web
```

The install is idempotent: it replaces the plugin source file in place. Your configuration (settings panel) and sync state (`~/.dsh/honcho-sync-state.json`) are preserved — no data loss, no re-configuration needed.

### v0.7.0 → v0.7.1 changelog

- Fixed `conclusions/query` requiring `filters` parameter
- Fixed response parsing for `/search`, `/peers/list`, `/summaries`
- Fixed `POST /conclusions` body format
- Fixed `schedule_dream` parameter name (`dream_type`)
- Added 4 tools: `honcho_conclude`, `honcho_conclude_list`, `honcho_conclude_query`, `honcho_message_get`
- Hybrid recall now searches messages + conclusions in parallel

## Uninstalling

```bash
# 1. Remove the plugin from DSH
dsh plugin --profile web remove honcho-sync dsh web

# 2. (Optional) Remove sync state file
rm ~/.dsh/honcho-sync-state.json

# 3. Restart DSH
systemctl --user restart dsh-web
```

> **Note:** Removing the plugin does NOT delete your Honcho data. All messages, conclusions, and peer cards remain on your Honcho server. The plugin is just the bridge — your memory is safe.

## Configuration

### Settings Panel (recommended)

After installation, open DSH Settings → **Honcho Memory** to configure:

| Setting | Description | Default |
|---------|-------------|---------|
| `honchoUrl` | Honcho API base URL | *(required)* |
| `workspace` | Honcho workspace name | *(required)* |
| `userPeer` | Peer ID representing the user | `user` |
| `agentPeer` | Peer ID representing the agent | `agent` |
| `sessionStrategy` | `per-directory` or `global` | `per-directory` |
| `debounceMs` | Auto-sync debounce (ms) | `3000` |
| `autoRecall` | Inject memory context on session start | `true` |
| `recallBudget` | Token budget for recall | `2000` |
| `autoSync` | Enable auto-sync | `true` |
| `messageMaxChars` | Max chars per synced message | `25000` |
| `injectionMaxChars` | Max chars for injected context | `8000` |
| `reprMaxObs` | Max observations in representation | `8` |
| `reprTimeoutMs` | Representation API timeout (ms) | `8000` |
| `cardTimeoutMs` | Peer card API timeout (ms) | `5000` |

### Environment Variables (alternative)

```bash
export HONCHO_URL="http://localhost:8000"
export HONCHO_WORKSPACE="my-workspace"
export HONCHO_USER_PEER="user"
export HONCHO_AGENT_PEER="agent"
```

### Honcho Server Setup

If you don't have Honcho running yet:

```bash
# Quick start with Docker
docker run -d --name honcho \
  -p 8000:8000 \
  -e HONCHO_API_KEY="your-api-key" \
  plasticlabs/honcho:latest

# Or self-host from source (recommended for production)
# See: https://github.com/plastic-labs/honcho#self-hosting
```

Create a workspace and peers:

```bash
curl -X POST http://localhost:8000/v3/workspaces/my-workspace \
  -H "Authorization: Bearer $HONCHO_API_KEY" \
  -H "Content-Type: application/json"

curl -X POST http://localhost:8000/v3/workspaces/my-workspace/peers \
  -H "Authorization: Bearer $HONCHO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "user"}'

curl -X POST http://localhost:8000/v3/workspaces/my-workspace/peers \
  -H "Authorization: Bearer $HONCHO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "agent"}'
```

## Tools

### Memory
| Tool | Description |
|------|-------------|
| `honcho_recall` | Hybrid semantic search (messages + conclusions). Fast (2-5s). |
| `honcho_ask` | Deep dialectic reasoning with a peer. Slower (2-5min) but thorough. |
| `honcho_remember` | Save a fact/statement to Honcho memory. |
| `honcho_context` | Get compressed conversation context for a session. |

### Search
| Tool | Description |
|------|-------------|
| `honcho_search` | Search across ALL sessions (no date filter). |
| `honcho_session_search` | Search within a specific session. |

### Profile
| Tool | Description |
|------|-------------|
| `honcho_profile` | Get a peer's card (identity, attributes, relationships). |
| `honcho_representation` | Get a peer's representation (compressed observations). |

### Session
| Tool | Description |
|------|-------------|
| `honcho_session` | List sessions. |
| `honcho_session_create` | Create a new session. |
| `honcho_session_clone` | Clone an existing session. |
| `honcho_session_peers` | List/add/remove peers on a session. |
| `honcho_session_summaries` | Get session summaries (compressed context). |
| `honcho_session_context` | Get full conversation context. |

### Peer
| Tool | Description |
|------|-------------|
| `honcho_peer` | List all peers. |
| `honcho_peer_create` | Create or get a peer. |
| `honcho_peer_list` | List all peers (alias). |

### Message
| Tool | Description |
|------|-------------|
| `honcho_message_send` | Send a message to a session. |
| `honcho_message_get` | Get a message by ID. |

### Conclude
| Tool | Description |
|------|-------------|
| `honcho_conclude` | Create an explicit conclusion. |
| `honcho_conclude_list` | List conclusions. |
| `honcho_conclude_query` | Semantic search across conclusions. |

### Admin
| Tool | Description |
|------|-------------|
| `honcho_status` | Health check + queue stats. |
| `honcho_dream` | Trigger a dream (card_refresh or omni). |
| `honcho_queue` | Check processing queue status. |

## Session Strategy

- **`per-directory`** (default): Each working directory gets its own Honcho session (e.g., `dsh-home-user-project`). Conversations in different directories are isolated.
- **`global`**: All conversations share one session regardless of directory.

## Auto-sync & Persistence

- Messages are synced with a configurable debounce (default 3s).
- Sync cursors are persisted to `~/.dsh/honcho-sync-state.json` — survives HMR and DSH restarts.
- On restart, only new events since the last cursor are synced (no duplicates).

## Memory Injection

When `autoRecall` is enabled, on the first user message of each session:

1. Peer cards (profile) for both peers are fetched
2. Representations are fetched and deduplicated (semantic overlap removal)
3. A semantic search query is run using the user's message as the query
4. Results are wrapped in `<memory-context>` tags and injected into the system prompt

## Privacy

- All data stays on **your** Honcho server. No third-party data transmission.
- The plugin does not log message content.
- Configuration (URL, workspace, peer IDs) is stored in DSH settings, not in the plugin source.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `HONCHO_URL is required` at boot | Set via settings panel or env var. This message is benign if settings load asynchronously. |
| No sync happening | Check `autoSync` is `true`, verify Honcho URL is reachable, check logs: `journalctl --user -u dsh-web \| grep honcho` |
| Recall returns empty | Ensure Deriver has processed messages (check `honcho_queue`), wait a few minutes after first sync |
| `401 Unauthorized` | Check your Honcho API key in server config |
| Session not found | Verify `workspace` name matches your Honcho workspace exactly |

## License

MIT

---

# 中文说明

[English](#nanpaidashidsh-honcho-sync) | 中文

Honcho 记忆插件，为 [DeepSeek Harness](https://github.com/DeepSeek-AI/dsh) 提供持久化跨会话记忆，基于自托管的 [Honcho](https://github.com/plastic-labs/honcho) v3 服务。

## 功能

- **自动同步**：每轮对话自动同步到 Honcho（带防抖）。同步游标跨重启持久化。
- **混合召回**：同时搜索原始消息和推理结论（显式/演绎/归纳），并行执行。
- **记忆注入**：会话开始时，将相关的 peer 卡片、表征和语义召回结果注入系统提示词。
- **25 个工具**：覆盖 Honcho v3 完整 API — 搜索、画像、会话管理、peer 管理、结论、做梦、队列监控。

## 依赖

- DeepSeek Harness (DSH) web profile
- 一个运行中的 Honcho v3 实例（自托管）
- Node.js >= 18

## 安装

```bash
# 从 npm
dsh plugin --profile web add npm:@nanpaidashi/dsh-honcho-sync dsh web

# 或从 GitHub
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web
```

然后重启 DSH：

```bash
systemctl --user restart dsh-web
# 或: dsh web --restart
```

## 升级

如果你安装过旧版本（v0.6.x 或 v0.7.0）：

```bash
# 重跑同一条安装命令 — 会拉取最新版并覆盖
dsh plugin --profile web add npm:@nanpaidashi/dsh-honcho-sync dsh web
# 或
dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web

systemctl --user restart dsh-web
```

安装是幂等的：原地替换插件源码文件。你的配置（设置面板）和同步状态（`~/.dsh/honcho-sync-state.json`）会保留 — 无数据丢失，无需重新配置。

### v0.7.0 → v0.7.1 变更

- 修复 `conclusions/query` 需要 `filters` 参数
- 修复 `/search`、`/peers/list`、`/summaries` 响应解析
- 修复 `POST /conclusions` 请求体格式
- 修复 `schedule_dream` 参数名（`dream_type`）
- 新增 4 个工具：`honcho_conclude`、`honcho_conclude_list`、`honcho_conclude_query`、`honcho_message_get`
- 混合召回现在并行搜索消息和结论

## 卸载

```bash
# 1. 从 DSH 移除插件
dsh plugin --profile web remove honcho-sync dsh web

# 2.（可选）删除同步状态文件
rm ~/.dsh/honcho-sync-state.json

# 3. 重启 DSH
systemctl --user restart dsh-web
```

> **注意：** 卸载插件**不会**删除你的 Honcho 数据。所有消息、结论和 peer 卡片仍然保留在你的 Honcho 服务器上。插件只是桥梁 — 你的记忆是安全的。

## 配置

### 设置面板（推荐）

安装后，打开 DSH 设置 → **Honcho Memory** 进行配置：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| `honchoUrl` | Honcho API 地址 | *（必填）* |
| `workspace` | Honcho 工作区名 | *（必填）* |
| `userPeer` | 用户 peer ID | `user` |
| `agentPeer` | Agent peer ID | `agent` |
| `sessionStrategy` | `per-directory` 或 `global` | `per-directory` |
| `debounceMs` | 自动同步防抖（毫秒） | `3000` |
| `autoRecall` | 会话开始时注入记忆上下文 | `true` |
| `recallBudget` | 召回 token 预算 | `2000` |
| `autoSync` | 启用自动同步 | `true` |
| `messageMaxChars` | 单条同步消息最大字符数 | `25000` |
| `injectionMaxChars` | 注入上下文最大字符数 | `8000` |
| `reprMaxObs` | 表征中最大观察数 | `8` |
| `reprTimeoutMs` | 表征 API 超时（毫秒） | `8000` |
| `cardTimeoutMs` | Peer 卡片 API 超时（毫秒） | `5000` |

### 环境变量（替代方式）

```bash
export HONCHO_URL="http://localhost:8000"
export HONCHO_WORKSPACE="my-workspace"
export HONCHO_USER_PEER="user"
export HONCHO_AGENT_PEER="agent"
```

### Honcho 服务器搭建

如果你还没有运行 Honcho：

```bash
# Docker 快速启动
docker run -d --name honcho \
  -p 8000:8000 \
  -e HONCHO_API_KEY="your-api-key" \
  plasticlabs/honcho:latest

# 或从源码自托管（生产环境推荐）
# 参考: https://github.com/plastic-labs/honcho#self-hosting
```

创建工作区和 peers：

```bash
curl -X POST http://localhost:8000/v3/workspaces/my-workspace \
  -H "Authorization: Bearer $HONCHO_API_KEY" \
  -H "Content-Type: application/json"

curl -X POST http://localhost:8000/v3/workspaces/my-workspace/peers \
  -H "Authorization: Bearer $HONCHO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "user"}'

curl -X POST http://localhost:8000/v3/workspaces/my-workspace/peers \
  -H "Authorization: Bearer $HONCHO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "agent"}'
```

## 工具列表

### 记忆
| 工具 | 说明 |
|------|------|
| `honcho_recall` | 混合语义搜索（消息 + 结论）。快（2-5秒）。 |
| `honcho_ask` | 与 peer 深度辩证推理。慢（2-5分钟）但全面。 |
| `honcho_remember` | 保存事实/陈述到 Honcho 记忆。 |
| `honcho_context` | 获取会话的压缩上下文。 |

### 搜索
| 工具 | 说明 |
|------|------|
| `honcho_search` | 跨所有会话搜索（无日期过滤）。 |
| `honcho_session_search` | 在特定会话内搜索。 |

### 画像
| 工具 | 说明 |
|------|------|
| `honcho_profile` | 获取 peer 卡片（身份、属性、关系）。 |
| `honcho_representation` | 获取 peer 表征（压缩观察）。 |

### 会话
| 工具 | 说明 |
|------|------|
| `honcho_session` | 列出会话。 |
| `honcho_session_create` | 创建新会话。 |
| `honcho_session_clone` | 克隆现有会话。 |
| `honcho_session_peers` | 列出/添加/移除会话中的 peer。 |
| `honcho_session_summaries` | 获取会话摘要（压缩上下文）。 |
| `honcho_session_context` | 获取完整对话上下文。 |

### Peer
| 工具 | 说明 |
|------|------|
| `honcho_peer` | 列出所有 peer。 |
| `honcho_peer_create` | 创建或获取 peer。 |
| `honcho_peer_list` | 列出所有 peer（别名）。 |

### 消息
| 工具 | 说明 |
|------|------|
| `honcho_message_send` | 向会话发送消息。 |
| `honcho_message_get` | 按 ID 获取消息。 |

### 结论
| 工具 | 说明 |
|------|------|
| `honcho_conclude` | 创建显式结论。 |
| `honcho_conclude_list` | 列出结论。 |
| `honcho_conclude_query` | 跨结论语义搜索。 |

### 管理
| 工具 | 说明 |
|------|------|
| `honcho_status` | 健康检查 + 队列统计。 |
| `honcho_dream` | 触发做梦（card_refresh 或 omni）。 |
| `honcho_queue` | 查看处理队列状态。 |

## 会话策略

- **`per-directory`**（默认）：每个工作目录对应独立的 Honcho 会话（如 `dsh-home-user-project`）。不同目录的对话互相隔离。
- **`global`**：所有对话共享一个会话，不区分目录。

## 自动同步与持久化

- 消息以可配置的防抖间隔同步（默认 3 秒）。
- 同步游标持久化到 `~/.dsh/honcho-sync-state.json` — 跨 HMR 和 DSH 重启保留。
- 重启后只同步游标之后的新事件（无重复）。

## 记忆注入

当 `autoRecall` 启用时，每个会话的首条用户消息触发：

1. 获取两个 peer 的卡片（画像）
2. 获取表征并去重（语义重叠移除）
3. 以用户消息为查询执行语义搜索
4. 结果包裹在 `<memory-context>` 标签中注入系统提示词

## 隐私

- 所有数据保留在**你的** Honcho 服务器上。无第三方数据传输。
- 插件不记录消息内容。
- 配置（URL、工作区、peer ID）存储在 DSH 设置中，不在插件源码里。

## 故障排查

| 症状 | 解决方案 |
|------|----------|
| 启动时 `HONCHO_URL is required` | 通过设置面板或环境变量配置。如果设置异步加载，此消息无害。 |
| 没有同步发生 | 检查 `autoSync` 是否为 `true`，确认 Honcho URL 可达，查看日志：`journalctl --user -u dsh-web \| grep honcho` |
| 召回返回空 | 确认 Deriver 已处理消息（检查 `honcho_queue`），首次同步后等待几分钟 |
| `401 Unauthorized` | 检查 Honcho 服务器配置中的 API key |
| Session not found | 确认 `workspace` 名与 Honcho 工作区完全一致 |

## 许可

MIT
