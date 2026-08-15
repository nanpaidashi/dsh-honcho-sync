/**
 * @nanpaidashi/dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness
 *
 * Give DSH persistent memory: auto-sync every conversation turn to a
 * self-hosted Honcho service, and equip the AI with tools to recall,
 * search, remember, and inject context.
 *
 * Installation:
 *   dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web
 *
 * Environment variables:
 *   HONCHO_URL     - Honcho API base URL (required, e.g. http://localhost:8000)
 *   HONCHO_WORKSPACE - Workspace name (no default; must be configured)
 *   HONCHO_USER_PEER - User peer_id (default: user)
 *   HONCHO_AGENT_PEER - Agent peer_id (default: agent)
 *
 * @module @nanpaidashi/dsh-honcho-sync
 */

const name = 'honcho-sync';
const inject = [];

function getConfig(config) {
  const url = (config?.honchoUrl || process.env.HONCHO_URL || '').replace(/\/$/, '');
  if (!url) {
    console.error('[honcho-sync] HONCHO_URL is required. Set it via environment variable or cordis config.');
    return null;
  }
  return {
    honchoUrl: url,
    workspace: config?.workspace || process.env.HONCHO_WORKSPACE || '',
    userPeer: config?.userPeer || process.env.HONCHO_USER_PEER || 'user',
    agentPeer: config?.agentPeer || process.env.HONCHO_AGENT_PEER || 'agent',
    debounceMs: config?.debounceMs ?? 3000,
    autoRecall: config?.autoRecall ?? true,
    recallBudget: config?.recallBudget ?? 2000,
    contextInjection: config?.contextInjection ?? true,
  };
}

function apply(ctx, config) {
  const sessionQuery = ctx.get('sessionQuery');
  if (sessionQuery === undefined) return;

  const cfg = getConfig(config);
  if (!cfg) return;

  const state = new Map();

  // ─── Honcho API helpers ───

  async function honchoRequest(method, path, body) {
    const url = `${cfg.honchoUrl}${path}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    try {
      const resp = await fetch(url, opts);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Honcho ${method} ${path}: ${resp.status} ${text.slice(0, 200)}`);
      }
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('json')) return await resp.json();
      return await resp.text();
    } catch (e) {
      console.error(`[honcho-sync] API error: ${e.message}`);
      return null;
    }
  }

  function honchoSessionId(cwd) {
    if (!cwd) return 'dsh-unknown';
    return 'dsh-' + cwd.split('/').filter(Boolean).join('-').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function extractText(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text)
      .join('');
  }

  // ─── Memory tools ───

  function defineHonchoRecall() {
    return {
      name: 'honcho_recall',
      description: `Search your Honcho memory service for relevant conversation context from past sessions. Call at the start of a session or before important tasks to recall what matters.`,
      parameters: {
        query: { type: 'string', required: true, description: 'Natural language query describing what to recall.' },
        max_tokens: { type: 'integer', description: 'Token limit for results (configurable via recallBudget).' },
        limit: { type: 'integer', description: 'Max results to return (default: 10).' },
      },
      async execute(args, exec) {
        const sessionId = honchoSessionId(exec?.agent?.session?.header?.cwd || '');
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/sessions/${sessionId}/search`,
          { query: args.query, max_tokens: args.max_tokens ?? cfg.recallBudget, limit: args.limit ?? 10 }
        );
        if (!result) return { ok: true, tool: 'honcho_recall', text: 'Error contacting Honcho server.' };
        const texts = (Array.isArray(result) ? result : []).map(r =>
          `[${r.peer_id || '?'}] ${r.content?.slice(0, 500) || ''}`
        ).join('\n\n');
        return { ok: true, tool: 'honcho_recall', text: texts || 'No relevant memories found.' };
      },
    };
  }

  function defineHonchoSearch() {
    return {
      name: 'honcho_search',
      description: `Search across ALL sessions in your Honcho workspace. Use for precise lookups beyond the current session.`,
      parameters: {
        query: { type: 'string', required: true, description: 'Search query.' },
        max_tokens: { type: 'integer', description: 'Token limit (default: 2000).' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/search`,
          { query: args.query, max_tokens: args.max_tokens ?? 2000 }
        );
        if (!result) return { ok: true, tool: 'honcho_search', text: 'Error contacting Honcho server.' };
        const texts = (Array.isArray(result) ? result : []).map(r =>
          `[${r.peer_id || '?'}] ${r.content?.slice(0, 500) || ''}`
        ).join('\n\n');
        return { ok: true, tool: 'honcho_search', text: texts || 'No results found.' };
      },
    };
  }

  function defineHonchoRemember() {
    return {
      name: 'honcho_remember',
      description: `Save an important fact, decision, constraint, or preference to your long-term Honcho memory. Use when the user states something that should persist across sessions.`,
      parameters: {
        content: { type: 'string', required: true, description: 'The fact or information to remember.' },
        peer_id: { type: 'string', description: 'Who said it (user or agent).' },
      },
      async execute(args) {
        const peer = args.peer_id || cfg.userPeer;
        const sessionId = honchoSessionId(args.cwd || '');
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/sessions/${sessionId}/messages`,
          { messages: [{ role: 'assistant', content: args.content, peer_id: peer }] }
        );
        if (!result) return { ok: true, tool: 'honcho_remember', text: 'Error saving to Honcho.' };
        return { ok: true, tool: 'honcho_remember', text: 'Saved to memory.' };
      },
    };
  }

  function defineHonchoStatus() {
    return {
      name: 'honcho_status',
      description: `Check Honcho memory server health and statistics.`,
      parameters: {},
      async execute() {
        const health = await honchoRequest('GET', '/health');
        return {
          ok: true,
          tool: 'honcho_status',
          text: `Honcho: ${health?.status || 'unknown'} | Workspace: ${cfg.workspace || 'not set'} | URL: ${cfg.honchoUrl}`,
        };
      },
    };
  }

  function defineHonchoContext() {
    return {
      name: 'honcho_context',
      description: `Get the full conversation context for the current session from Honcho. Use when you need to read recent conversation history stored in Honcho.`,
      parameters: {
        session_id: { type: 'string', description: 'Session ID (omit for auto-detect).' },
        limit: { type: 'integer', description: 'Max messages to return (default: 20).' },
      },
      async execute(args) {
        const sessionId = args.session_id || honchoSessionId(ctx.get('cwd') || '');
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg.workspace}/sessions/${sessionId}/context`
        );
        if (!result) return { ok: true, tool: 'honcho_context', text: 'Error retrieving context.' };
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { ok: true, tool: 'honcho_context', text: text.slice(0, 10000) || 'No context available.' };
      },
    };
  }

  // ─── Register tools ───

  const tools = [
    defineHonchoRecall(),
    defineHonchoSearch(),
    defineHonchoRemember(),
    defineHonchoStatus(),
    defineHonchoContext(),
  ];

  for (const tool of tools) {
    ctx.effect(
      () => {
        const toolsReg = ctx.get('tools');
        if (toolsReg !== undefined) {
          toolsReg.register(tool);
        }
      },
      'honcho-sync: ' + tool.name
    );
  }

  // ─── Context injection on session start ───

  if (cfg.autoRecall) {
    ctx.on('session/start', async (session) => {
      try {
        const sessionId = session?.id;
        if (!sessionId) return;
        const recent = await honchoRequest('GET',
          `/v3/workspaces/${cfg.workspace}/sessions/${sessionId}/context`
        );
        if (recent && typeof recent === 'string' && recent.length > 0) {
          console.log(`[honcho-sync] auto-recalled context for ${sessionId}`);
        }
      } catch (e) {
        // Non-fatal
      }
    });
  }

  // ─── Auto-sync ───

  async function postToHoncho(sessionId, messages) {
    try {
      const resp = await fetch(
        `${cfg.honchoUrl}/v3/workspaces/${cfg.workspace}/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages }),
        }
      );
      if (resp.ok || resp.status === 201) {
        console.log(`[honcho-sync] synced to ${sessionId} (${messages.length} messages)`);
      } else {
        const text = await resp.text().catch(() => '');
        console.error(`[honcho-sync] POST ${resp.status}: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[honcho-sync] fetch error:`, e.message);
    }
  }

  async function syncSession(sessionId) {
    try {
      const snapshot = await sessionQuery.readSession(sessionId);
      const header = snapshot.session;
      const events = snapshot.events || [];

      if (!header || events.length === 0) return;

      const cwd = header.cwd || '';
      const honchoSid = honchoSessionId(cwd);

      let userContent = '';
      let assistantContent = '';

      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev || !ev.data) continue;

        if (ev.type === 'assistant/message' && !assistantContent) {
          const msg = ev.data.message || ev.data;
          const text = extractText(msg.content);
          if (text) assistantContent = text;
        }

        if (ev.type === 'user/message' && !userContent) {
          const text = extractText(ev.data.content);
          if (text) userContent = text;
        }

        if (userContent && assistantContent) break;
      }

      if (!assistantContent) return;

      const s = state.get(honchoSid);
      if (s && s.lastAssistant === assistantContent) return;

      const messages = [];
      if (userContent) {
        messages.push({ role: 'user', content: userContent.slice(0, 25000), peer_id: cfg.userPeer });
      }
      if (assistantContent) {
        messages.push({ role: 'assistant', content: assistantContent.slice(0, 25000), peer_id: cfg.agentPeer });
      }

      if (messages.length === 0) return;

      await postToHoncho(honchoSid, messages);
      state.set(honchoSid, { timer: null, lastAssistant: assistantContent });
    } catch (e) {
      console.error(`[honcho-sync] syncSession error:`, e.message);
    }
  }

  function scheduleSync(sessionId) {
    const s = state.get(sessionId) || { timer: null, lastAssistant: '' };
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      syncSession(sessionId);
    }, cfg.debounceMs);
    state.set(sessionId, s);
  }

  ctx.on('session/event', (session, event) => {
    if (!session || !event) return;
    if (event.type !== 'assistant/message' && event.type !== 'user/message') return;
    const sessionId = session.id;
    if (!sessionId) return;
    scheduleSync(sessionId);
  });

  // Cleanup
  ctx.effect(() => {
    return () => {
      for (const [, s] of state) {
        if (s.timer) clearTimeout(s.timer);
      }
      state.clear();
    };
  });

  console.log(`[honcho-sync] initialized: url=${cfg.honchoUrl}, workspace=${cfg.workspace}`);
}

export { name, inject, apply };
