/**
 * @nanpaidashi/dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness
 *
 * Give DSH persistent memory: auto-sync every conversation turn to a
 * self-hosted Honcho service, and equip the AI with tools to recall,
 * search, remember, and inject context.
 *
 * A visual settings panel is available in DSH settings (click "Honcho Memory").
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

// ─── Config helpers ───

function getConfig(config, resolvedSettings) {
  const url = (resolvedSettings?.honchoUrl || config?.honchoUrl || process.env.HONCHO_URL || '').replace(/\/$/, '');
  if (!url) {
    console.error('[honcho-sync] HONCHO_URL is required. Set it via environment variable or the settings panel.');
    return null;
  }
  return {
    honchoUrl: url,
    workspace: resolvedSettings?.workspace || config?.workspace || process.env.HONCHO_WORKSPACE || '',
    userPeer: resolvedSettings?.userPeer || config?.userPeer || process.env.HONCHO_USER_PEER || 'user',
    agentPeer: resolvedSettings?.agentPeer || config?.agentPeer || process.env.HONCHO_AGENT_PEER || 'agent',
    debounceMs: resolvedSettings?.debounceMs ?? config?.debounceMs ?? 3000,
    autoRecall: resolvedSettings?.autoRecall ?? config?.autoRecall ?? true,
    recallBudget: resolvedSettings?.recallBudget ?? config?.recallBudget ?? 2000,
    autoSync: resolvedSettings?.autoSync ?? config?.autoSync ?? true,
    messageMaxChars: resolvedSettings?.messageMaxChars ?? config?.messageMaxChars ?? 25000,
  };
}

function apply(ctx, config) {
  const sessionQuery = ctx.get('sessionQuery');

  // ─── Settings namespace wiring ───

  // Import settings module dynamically (it's a plain JS file).
  // Since we can't use import() in plain .mjs for ESM-only deps,
  // we inline the minimal settings logic here.

  const HONCHO_NS = 'honcho-memory';
  const DEFAULTS = {
    honchoUrl: '',
    workspace: '',
    userPeer: 'user',
    agentPeer: 'agent',
    sessionStrategy: 'per-directory',
    debounceMs: 3000,
    autoRecall: true,
    recallBudget: 2000,
    autoSync: true,
    messageMaxChars: 25000,
  };

  // Resolve config from entry + resolved settings
  let resolvedSettings = { ...DEFAULTS, ...(config || {}) };
  let configWriter = null;

  // Optional settings wiring
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      HONCHO_NS,
      {
        type: 'object',
        properties: {
          honchoUrl: { type: 'string', default: '' },
          workspace: { type: 'string', default: '' },
          userPeer: { type: 'string', default: 'user' },
          agentPeer: { type: 'string', default: 'agent' },
          sessionStrategy: { type: 'string', default: 'per-directory' },
          debounceMs: { type: 'integer', default: 3000 },
          autoRecall: { type: 'boolean', default: true },
          recallBudget: { type: 'integer', default: 2000 },
          autoSync: { type: 'boolean', default: true },
          messageMaxChars: { type: 'integer', default: 25000 },
        },
        required: [],
      },
      { base: config || {}, validate: (v) => {
        if (v.debounceMs !== undefined && v.debounceMs < 100) throw new Error('debounce must be >= 100ms');
        if (v.recallBudget !== undefined && v.recallBudget < 1) throw new Error('recall budget must be >= 1');
      }}
    );
    configWriter = patch => scope.update(patch);
    resolvedSettings = { ...DEFAULTS, ...config || {}, ...scope.get() };

    const unwatch = scope.watch(() => {
      resolvedSettings = { ...DEFAULTS, ...config || {}, ...scope.get() };
    });
    settingsCtx.effect(() => unwatch);
  });

  // Use resolved settings for the config
  const cfg = getConfig(config, resolvedSettings);
  const state = new Map();

  // ─── Honcho API helpers ───

  async function honchoRequest(method, path, body) {
    if (!cfg) return null;
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
        if (toolsReg !== undefined) toolsReg.register(tool);
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
      if (!sessionQuery) return;
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
        messages.push({ role: 'user', content: userContent.slice(0, cfg.messageMaxChars), peer_id: cfg.userPeer });
      }
      if (assistantContent) {
        messages.push({ role: 'assistant', content: assistantContent.slice(0, cfg.messageMaxChars), peer_id: cfg.agentPeer });
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

  // ─── Loopback status route for settings panel ───

  const WRITABLE_FIELDS = new Set([
    'honchoUrl', 'workspace', 'userPeer', 'agentPeer',
    'debounceMs', 'autoRecall', 'recallBudget', 'autoSync',
    'sessionStrategy', 'messageMaxChars',
  ]);
  const STATUS_ROUTE = '/_dsh/dsh-honcho-sync/status';

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    const resolveConfig = () => ({ ...DEFAULTS, ...config || {}, ...resolvedSettings });
    const resolveWriter = () => configWriter;

    function isLoopbackRequest(req) {
      const addr = req.socket?.remoteAddress || '';
      const norm = addr.toLowerCase().split('%', 1)[0];
      if (norm === '::1') return true;
      if (addr.startsWith('::ffff:')) {
        const mapped = addr.slice(7);
        const parts = mapped.split('.');
        if (parts.length === 4 && parts[0] === '127') return true;
      }
      if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(norm)) return true;
      return false;
    }

    function isJsonRequest(req) {
      const ct = req.headers['content-type'];
      return typeof ct === 'string' && /^application\/json(?:\s*;|$)/i.test(ct);
    }

    function sendJson(res, status, value) {
      const body = JSON.stringify(value);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
    }

    const disposer = webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          return sendJson(res, 403, { ok: false, error: 'loopback-only' });
        }
        if (req.method === 'GET') {
          try {
            return sendJson(res, 200, {
              ok: true,
              writable: configWriter !== null,
              config: resolveConfig(),
            });
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: e.message });
          }
        }
        if (req.method === 'POST') {
          if (!isJsonRequest(req)) {
            return sendJson(res, 400, { ok: false, error: 'json required' });
          }
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            if (!configWriter) {
              return sendJson(res, 409, { ok: false, error: 'settings not writable' });
            }
            try {
              const payload = JSON.parse(body);
              const action = payload.action;
              if (action === 'configure') {
                const field = payload.field;
                if (typeof field !== 'string' || !WRITABLE_FIELDS.has(field)) {
                  return sendJson(res, 400, { ok: false, error: 'unknown field' });
                }
                await configWriter({ [field]: payload.value });
                return sendJson(res, 200, { ok: true, writable: true, config: resolveConfig() });
              }
              return sendJson(res, 400, { ok: false, error: 'unknown action' });
            } catch (e) {
              return sendJson(res, 400, { ok: false, error: e.message });
            }
          });
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      },
    });

    ctx.effect(() => disposer, 'honcho-sync: status route');
  });

  console.log(`[honcho-sync] initialized: url=${cfg.honchoUrl}, workspace=${cfg.workspace}`);
}

export { name, inject, apply };
