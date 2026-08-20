# @nanpaidashi/dsh-honcho-sync

Honcho Memory Plugin for [DeepSeek Harness](https://github.com/DeepSeek-AI/dsh) — give your AI persistent, cross-session memory backed by a self-hosted [Honcho](https://github.com/plastic-labs/honcho) v3 service.

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
