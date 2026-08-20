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

### v0.8.0 → v0.8.1 changelog

- **Context efficiency**: Reduced registered tools from 25 to 4 (`honcho_recall`, `honcho_ask`, `honcho_remember`, `honcho_context`) — saves ~7K tokens of tool schema injection per session
- **Injection quality**: Added `_filterRepresentation()` — removes Pattern [medium]/[low] blocks, Premises/Sources provenance chains, and orphan Type/Sources lines from representation injection
- **Injection quality**: Added `_assembleByPriority()` — assembles memory-context parts by priority (peer-card > session-summary > semantic-recall > representation) instead of fixed order
- **Injection budget**: `injectionMaxChars` default 8000 → 4000, `reprMaxObs` default 8 → 4
- **Tool descriptions**: Shortened all tool descriptions to ~100 chars

### v0.7.x → v0.8.0 changelog

- **DSH 0.1.0-rc.8 compatibility**: Added `normalizeToolParameters()` to convert legacy parameter shorthand to standard JSON Schema
- **DSH 0.1.0-rc.8 compatibility**: Added `output.render` returning content blocks array (required by DSH >= 2026)
- **README**: Removed settings panel references — configuration is done via environment variables in `~/.config/systemd/user/dsh-web.service`
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

**There is no settings panel.** All configuration is done via environment variables in your DSH service file.

### Step 1: Edit the DSH service file

```bash
# For systemd (Linux)
nano ~/.config/systemd/user/dsh-web.service
```

Add these environment variables to the `[Service]` section:

```ini
[Service]
Environment="HONCHO_URL=http://localhost:8000"
Environment="HONCHO_WORKSPACE=my-workspace"
Environment="HONCHO_USER_PEER=user"
Environment="HONCHO_AGENT_PEER=agent"
```

### Step 2: Apply the changes

```bash
systemctl --user daemon-reload
systemctl --user restart dsh-web
```

### Configuration reference

| Variable | Description | Default |
|----------|-------------|---------|
| `HONCHO_URL` | Honcho API base URL | *(required)* |
| `HONCHO_WORKSPACE` | Honcho workspace name | *(required)* |
| `HONCHO_USER_PEER` | Peer ID representing the user | `user` |
| `HONCHO_AGENT_PEER` | Peer ID representing the agent | `agent` |

> **Note:** Advanced options (debounce, recall budget, timeouts) use sensible defaults and rarely need tuning. If you do need to customize them, edit the `DEFAULTS` object at the top of `src/index.mjs`.

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
| `HONCHO_URL is required` at boot | Set via environment variable in `~/.config/systemd/user/dsh-web.service`. |
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

安装是幂等的：原地替换插件源码文件。你的配置（环境变量）和同步状态（`~/.dsh/honcho-sync-state.json`）会保留 — 无数据丢失，无需重新配置。

### v0.8.0 → v0.8.1 变更

- **上下文效率**：注册工具从 25 个精简到 4 个（`honcho_recall`、`honcho_ask`、`honcho_remember`、`honcho_context`）— 每会话节省约 7K tokens 的工具 schema 注入
- **注入质量**：新增 `_filterRepresentation()` — 从表征注入中过滤 Pattern [medium]/[low] 块、Premises/Sources 溯源链、孤立 Type/Sources 行
- **注入质量**：新增 `_assembleByPriority()` — 按优先级组装 memory-context（peer-card > session-summary > semantic-recall > representation）
- **注入预算**：`injectionMaxChars` 默认 8000 → 4000，`reprMaxObs` 默认 8 → 4
- **工具描述**：所有工具描述精简到 ~100 字符

### v0.7.x → v0.8.0 变更

- **DSH 0.1.0-rc.8 兼容**：添加 `normalizeToolParameters()` 将旧式参数简写转换为标准 JSON Schema
- **DSH 0.1.0-rc.8 兼容**：添加 `output.render` 返回 content blocks 数组（DSH >= 2026 要求）
- **README**：移除设置面板说明 — 配置通过 `~/.config/systemd/user/dsh-web.service` 中的环境变量完成
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

**没有设置面板。** 所有配置通过 DSH 服务文件中的环境变量完成。

### 第一步：编辑 DSH 服务文件

```bash
# systemd (Linux)
nano ~/.config/systemd/user/dsh-web.service
```

在 `[Service]` 部分添加环境变量：

```ini
[Service]
Environment="HONCHO_URL=http://localhost:8000"
Environment="HONCHO_WORKSPACE=my-workspace"
Environment="HONCHO_USER_PEER=user"
Environment="HONCHO_AGENT_PEER=agent"
```

### 第二步：应用更改

```bash
systemctl --user daemon-reload
systemctl --user restart dsh-web
```

### 配置参考

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HONCHO_URL` | Honcho API 地址 | *(必填)* |
| `HONCHO_WORKSPACE` | Honcho 工作区名称 | *(必填)* |
| `HONCHO_USER_PEER` | 用户 peer ID | `user` |
| `HONCHO_AGENT_PEER` | Agent peer ID | `agent` |

> **注意：** 高级选项（防抖、召回预算、超时）使用合理的默认值，很少需要调整。如需自定义，编辑 `src/index.mjs` 顶部的 `DEFAULTS` 对象。

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
- 配置（URL、工作区、peer ID）通过环境变量存储在 DSH 服务文件中，不在插件源码里。

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
