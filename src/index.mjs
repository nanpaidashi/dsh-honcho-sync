/**
 * @nanpaidashi/dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness (v0.6.0)
 *
 * Give DSH persistent memory: auto-sync every conversation turn to a
 * self-hosted Honcho service, and equip the AI with a full set of tools
 * covering the official Honcho v3 API surface.
 *
 * Tools provided (grouped by domain):
 *   Memory  : honcho_recall, honcho_ask, honcho_remember, honcho_context
 *   Search  : honcho_search, honcho_session_search
 *   Profile : honcho_profile, honcho_representation
 *   Session : honcho_session, honcho_session_create, honcho_session_clone,
 *             honcho_session_peers, honcho_session_summaries
 *   Peer    : honcho_peer, honcho_peer_create
 *   Conclude: honcho_conclude, honcho_conclude_list, honcho_conclude_query
 *   Admin   : honcho_status, honcho_dream, honcho_queue
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
    injectionMaxChars: resolvedSettings?.injectionMaxChars ?? config?.injectionMaxChars ?? 4000,
  };
}

function apply(ctx, config) {
  const sessionQuery = ctx.get('sessionQuery');
  const systemPrompt = ctx.get('systemPrompt');

  // ─── Settings namespace wiring ───

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
    injectionMaxChars: 4000,
  };

  let resolvedSettings = { ...DEFAULTS, ...(config || {}) };
  let configWriter = null;

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
          injectionMaxChars: { type: 'integer', default: 4000 },
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

  const cfg = getConfig(config, resolvedSettings);
  const state = new Map();

  // ─── Honcho API helpers ───

  async function honchoRequest(method, path, body, timeoutMs = 15000) {
    if (!cfg) return null;
    const url = `${cfg.honchoUrl}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal };
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
      if (e.name === 'AbortError') {
        console.error(`[honcho-sync] API timeout: ${method} ${path}`);
        return null;
      }
      console.error(`[honcho-sync] API error: ${e.message}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  function honchoSessionId(cwd, dateStr) {
    const basePrefix = cwd ? 'dsh-' + cwd.split('/').filter(Boolean).join('-').replace(/[^a-zA-Z0-9_-]/g, '-') : 'dsh-unknown';
    if (dateStr) return basePrefix + '-' + dateStr;
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return basePrefix + '-' + yyyy + '-' + mm + '-' + dd;
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
      description: 'Semantic search across Honcho memory. Fast (2-5s). Returns the most relevant message snippets from recent sessions. Use for quick lookups: "what was decided about X", "find details on Y". For deep reasoning, use honcho_ask instead.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search query — describe what you are looking for.' },
        limit: { type: 'integer', description: 'Number of results to return. Default 5, max 10.' },
      },
      async execute(args, exec) {
        const n = Math.min(Math.max(args.limit || 5, 1), 10);
        const cwd = exec?.agent?.session?.header?.cwd || '';
        // Build session allowlist: last 7 days
        const sessionIds = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          sessionIds.push(honchoSessionId(cwd, `${yyyy}-${mm}-${dd}`));
        }
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/search`,
          { query: args.query, limit: n, filters: { session_id: { "in": sessionIds } } },
          30000
        );
        if (!result) return { ok: true, tool: 'honcho_recall', results: ['Error contacting Honcho server.'], count: 0 };
        const results = (result.results || []).map(r => {
          const content = (r.content || '').slice(0, 500);
          const peer = r.peer_id || '?';
          const ts = (r.created_at || '').replace('T', ' ').replace('Z', '').slice(0, 16);
          return `[${peer} ${ts}] ${content}`;
        });
        return { ok: true, tool: 'honcho_recall', results, count: results.length };
      },
    };
  }

  function defineHonchoAsk() {
    return {
      name: 'honcho_ask',
      description: 'Ask the Honcho memory system a question using dialectic reasoning. This queries the peer\'s conversation history and observations to produce an answer. Takes 2-5 minutes on a typical LLM. Use for questions like "what did we discuss about X" or "summarize recent work on Y".',
      parameters: {
        query: { type: 'string', required: true, description: 'The question to ask the memory system.' },
        peer: { type: 'string', description: `Which peer to query. Default: ${cfg.userPeer}.` },
      },
      async execute(args, exec) {
        const targetPeer = args.peer || cfg.userPeer;
        const cwd = exec?.agent?.session?.header?.cwd || '';
        // Build session allowlist: last 7 days
        const sessionIds = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          sessionIds.push(honchoSessionId(cwd, `${yyyy}-${mm}-${dd}`));
        }
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/peers/${targetPeer}/chat`,
          {
            session_id: sessionIds[0],
            filters: { session_id: { "in": sessionIds } },
            query: args.query,
          },
          300000 // 5 min cap for dialectic
        );
        if (!result) return { ok: true, tool: 'honcho_ask', answer: 'Error contacting Honcho server or timeout.' };
        const answer = result.response || result.answer || JSON.stringify(result).slice(0, 2000);
        return { ok: true, tool: 'honcho_ask', answer };
      },
    };
  }

  function defineHonchoRemember() {
    return {
      name: 'honcho_remember',
      description: 'Save an important fact, decision, constraint, or preference to your long-term Honcho memory. Use when the user states something that should persist across sessions.',
      parameters: {
        content: { type: 'string', required: true, description: 'The fact or information to remember.' },
        peer_id: { type: 'string', description: 'Who said it (defaults to user peer).' },
      },
      async execute(args, exec) {
        const peer = args.peer_id || cfg.userPeer;
        const cwd = exec?.agent?.session?.header?.cwd || '';
        const sessionId = honchoSessionId(cwd);
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/sessions/${sessionId}/messages`,
          { messages: [{ role: 'user', content: args.content, peer_id: peer }] }
        );
        if (!result) return { ok: true, tool: 'honcho_remember', text: 'Error saving to Honcho.' };
        return { ok: true, tool: 'honcho_remember', text: 'Saved to memory.' };
      },
    };
  }

  function defineHonchoContext() {
    return {
      name: 'honcho_context',
      description: 'Get the full conversation context for a session from Honcho. Use when you need to read recent conversation history stored in Honcho.',
      parameters: {
        session_id: { type: 'string', description: 'Session ID (omit for auto-detect from current cwd).' },
        tokens: { type: 'integer', description: 'Token budget for the summary (default: 500).' },
      },
      async execute(args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd || '';
        const sessionId = args.session_id || honchoSessionId(cwd);
        const tokens = args.tokens || 500;
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg.workspace}/sessions/${sessionId}/context?summary=true&tokens=${tokens}`
        );
        if (!result) return { ok: true, tool: 'honcho_context', text: 'Error retrieving context.' };
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { ok: true, tool: 'honcho_context', text: text.slice(0, 10000) || 'No context available.' };
      },
    };
  }

  // ─── Search tools ───

  function defineHonchoSearch() {
    return {
      name: 'honcho_search',
      description: 'Search across ALL sessions in your Honcho workspace (no date filter). Use for precise lookups beyond the recent 7-day window.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search query.' },
        limit: { type: 'integer', description: 'Max results to return (default: 10).' },
        max_tokens: { type: 'integer', description: 'Token limit for results (default: 2000).' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/search`,
          { query: args.query, limit: args.limit || 10, max_tokens: args.max_tokens || 2000 }
        );
        if (!result) return { ok: true, tool: 'honcho_search', results: ['Error contacting Honcho server.'], count: 0 };
        const results = (result.results || []).map(r =>
          `[${r.peer_id || '?'}] ${(r.content || '').slice(0, 500)}`
        );
        return { ok: true, tool: 'honcho_search', results, count: results.length };
      },
    };
  }

  function defineHonchoSessionSearch() {
    return {
      name: 'honcho_session_search',
      description: 'Search within a specific Honcho session. Use when you need to find something in a particular conversation.',
      parameters: {
        session_id: { type: 'string', required: true, description: 'The session ID to search within.' },
        query: { type: 'string', required: true, description: 'Search query.' },
        max_tokens: { type: 'integer', description: 'Token limit (default: 500).' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/sessions/${args.session_id}/search`,
          { query: args.query, max_tokens: args.max_tokens || 500 }
        );
        if (!result) return { ok: true, tool: 'honcho_session_search', results: ['Error contacting Honcho server.'], count: 0 };
        const results = (Array.isArray(result) ? result : (result.results || [])).map(r =>
          `[${r.peer_id || '?'}] ${(r.content || '').slice(0, 500)}`
        );
        return { ok: true, tool: 'honcho_session_search', results, count: results.length };
      },
    };
  }

  // ─── Profile tools ───

  function defineHonchoProfile() {
    return {
      name: 'honcho_profile',
      description: 'Get the peer card (profile) for a peer. Contains identity, attributes, relationships, and instructions observed by Honcho.',
      parameters: {
        peer_id: { type: 'string', required: true, description: 'The peer ID (e.g. "user" or "agent").' },
      },
      async execute(args) {
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg.workspace}/peers/${args.peer_id}/card`
        );
        if (!result) return { ok: true, tool: 'honcho_profile', card: [] };
        const card = Array.isArray(result.peer_card) ? result.peer_card : [];
        return { ok: true, tool: 'honcho_profile', card };
      },
    };
  }

  function defineHonchoRepresentation() {
    return {
      name: 'honcho_representation',
      description: 'Get the working representation (observations) for a peer. These are cross-session facts extracted by Honcho\'s deriver.',
      parameters: {
        peer_id: { type: 'string', required: true, description: 'The peer ID to get representation for.' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/peers/${args.peer_id}/representation`,
          {},
          15000
        );
        if (!result) return { ok: true, tool: 'honcho_representation', text: 'Error contacting Honcho server.' };
        const text = typeof result === 'string' ? result : (result.representation || JSON.stringify(result));
        return { ok: true, tool: 'honcho_representation', text: text.slice(0, 10000) };
      },
    };
  }

  // ─── Session tools ───

  function defineHonchoSession() {
    return {
      name: 'honcho_session',
      description: 'List Honcho sessions in the workspace. Returns session IDs, message counts, and metadata.',
      parameters: {
        limit: { type: 'integer', description: 'Max sessions to return (default: 20).' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/sessions/list`,
          { limit: args.limit || 20 }
        );
        if (!result) return { ok: true, tool: 'honcho_session', sessions: [] };
        const sessions = Array.isArray(result) ? result : (result.sessions || []);
        return { ok: true, tool: 'honcho_session', sessions: sessions.slice(0, args.limit || 20) };
      },
    };
  }

  function defineHonchoSessionCreate() {
    return {
      name: 'honcho_session_create',
      description: 'Create or get a Honcho session by ID. Useful for setting up new conversation threads.',
      parameters: {
        session_id: { type: 'string', required: true, description: 'The session ID to create.' },
        metadata: { type: 'object', description: 'Optional metadata to attach to the session.', additionalProperties: true },
      },
      async execute(args) {
        const body = { id: args.session_id };
        if (args.metadata) body.metadata = args.metadata;
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/sessions`,
          body
        );
        if (!result) return { ok: false, tool: 'honcho_session_create', text: 'Error creating session.' };
        return { ok: true, tool: 'honcho_session_create', text: `Session ${args.session_id} ready.`, session: result };
      },
    };
  }

  function defineHonchoSessionClone() {
    return {
      name: 'honcho_session_clone',
      description: 'Clone a Honcho session to a new ID. Useful for experiments or branching conversations.',
      parameters: {
        session_id: { type: 'string', required: true, description: 'The source session ID to clone.' },
        new_id: { type: 'string', required: true, description: 'The new session ID for the clone.' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/sessions/${args.session_id}/clone`,
          { id: args.new_id }
        );
        if (!result) return { ok: false, tool: 'honcho_session_clone', text: 'Error cloning session.' };
        return { ok: true, tool: 'honcho_session_clone', text: `Cloned ${args.session_id} → ${args.new_id}.` };
      },
    };
  }

  function defineHonchoSessionPeers() {
    return {
      name: 'honcho_session_peers',
      description: 'List or manage peers associated with a Honcho session. Actions: list, add, remove.',
      parameters: {
        session_id: { type: 'string', required: true, description: 'The session ID.' },
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'What to do (default: list).' },
        peer_id: { type: 'string', description: 'Peer ID (required for add/remove).' },
      },
      async execute(args) {
        const action = args.action || 'list';
        if (action === 'list') {
          const result = await honchoRequest('GET',
            `/v3/workspaces/${cfg.workspace}/sessions/${args.session_id}/peers`
          );
          if (!result) return { ok: true, tool: 'honcho_session_peers', peers: [] };
          const peers = Array.isArray(result) ? result : (result.items || []);
          return { ok: true, tool: 'honcho_session_peers', peers };
        } else if (action === 'add') {
          if (!args.peer_id) return { ok: false, tool: 'honcho_session_peers', text: 'peer_id required for add.' };
          const result = await honchoRequest('POST',
            `/v3/workspaces/${cfg.workspace}/sessions/${args.session_id}/peers`,
            { peer_id: args.peer_id }
          );
          return { ok: !!result, tool: 'honcho_session_peers', text: `Added ${args.peer_id} to session.` };
        } else if (action === 'remove') {
          if (!args.peer_id) return { ok: false, tool: 'honcho_session_peers', text: 'peer_id required for remove.' };
          const result = await honchoRequest('DELETE',
            `/v3/workspaces/${cfg.workspace}/sessions/${args.session_id}/peers`,
            { peer_id: args.peer_id }
          );
          return { ok: !!result, tool: 'honcho_session_peers', text: `Removed ${args.peer_id} from session.` };
        }
        return { ok: false, tool: 'honcho_session_peers', text: `Unknown action: ${action}` };
      },
    };
  }

  function defineHonchoSessionSummaries() {
    return {
      name: 'honcho_session_summaries',
      description: 'Get the summaries (compressed context) for a Honcho session.',
      parameters: {
        session_id: { type: 'string', required: true, description: 'The session ID.' },
      },
      async execute(args) {
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg.workspace}/sessions/${args.session_id}/summaries`
        );
        if (!result) return { ok: true, tool: 'honcho_session_summaries', summaries: [] };
        const summaries = Array.isArray(result) ? result : (result.summaries || []);
        return { ok: true, tool: 'honcho_session_summaries', summaries };
      },
    };
  }

  // ─── Peer tools ───

  function defineHonchoPeer() {
    return {
      name: 'honcho_peer',
      description: 'List all peers in the Honcho workspace.',
      parameters: {},
      async execute() {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/peers/list`,
          {}
        );
        if (!result) return { ok: true, tool: 'honcho_peer', peers: [] };
        const peers = Array.isArray(result) ? result : (result.peers || []);
        return { ok: true, tool: 'honcho_peer', peers };
      },
    };
  }

  function defineHonchoPeerCreate() {
    return {
      name: 'honcho_peer_create',
      description: 'Create or get a peer in the Honcho workspace.',
      parameters: {
        peer_id: { type: 'string', required: true, description: 'The peer ID to create.' },
        name: { type: 'string', description: 'Display name for the peer.' },
      },
      async execute(args) {
        const body = { id: args.peer_id };
        if (args.name) body.name = args.name;
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/peers`,
          body
        );
        if (!result) return { ok: false, tool: 'honcho_peer_create', text: 'Error creating peer.' };
        return { ok: true, tool: 'honcho_peer_create', text: `Peer ${args.peer_id} ready.`, peer: result };
      },
    };
  }

  // ─── Conclude tools ───

  function defineHonchoConclude() {
    return {
      name: 'honcho_conclude',
      description: 'Create a conclusion (explicit fact) in Honcho. Conclusions are high-confidence statements that persist across sessions.',
      parameters: {
        content: { type: 'string', required: true, description: 'The conclusion text.' },
        peer_id: { type: 'string', description: 'Which peer this conclusion is about (default: user peer).' },
      },
      async execute(args) {
        const peer = args.peer_id || cfg.userPeer;
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/conclusions`,
          { content: args.content, peer_id: peer }
        );
        if (!result) return { ok: false, tool: 'honcho_conclude', text: 'Error creating conclusion.' };
        return { ok: true, tool: 'honcho_conclude', text: 'Conclusion saved.', id: result.id };
      },
    };
  }

  function defineHonchoConcludeList() {
    return {
      name: 'honcho_conclude_list',
      description: 'List conclusions in the Honcho workspace.',
      parameters: {
        peer_id: { type: 'string', description: 'Filter by peer ID.' },
        limit: { type: 'integer', description: 'Max conclusions to return (default: 20).' },
      },
      async execute(args) {
        const body = { limit: args.limit || 20 };
        if (args.peer_id) body.peer_id = args.peer_id;
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/conclusions/list`,
          body
        );
        if (!result) return { ok: true, tool: 'honcho_conclude_list', conclusions: [] };
        const conclusions = Array.isArray(result) ? result : (result.conclusions || []);
        return { ok: true, tool: 'honcho_conclude_list', conclusions };
      },
    };
  }

  function defineHonchoConcludeQuery() {
    return {
      name: 'honcho_conclude_query',
      description: 'Semantic search across conclusions in Honcho. Find relevant explicit facts.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search query.' },
        limit: { type: 'integer', description: 'Max results (default: 10).' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/conclusions/query`,
          { query: args.query, limit: args.limit || 10 }
        );
        if (!result) return { ok: true, tool: 'honcho_conclude_query', conclusions: [] };
        const conclusions = Array.isArray(result) ? result : (result.conclusions || []);
        return { ok: true, tool: 'honcho_conclude_query', conclusions };
      },
    };
  }

  // ─── Admin tools ───

  function defineHonchoStatus() {
    return {
      name: 'honcho_status',
      description: 'Check Honcho memory server health and statistics.',
      parameters: {},
      async execute() {
        const health = await honchoRequest('GET', '/health');
        const queue = await honchoRequest('GET',
          `/v3/workspaces/${cfg.workspace}/queue/status`
        );
        return {
          ok: true,
          tool: 'honcho_status',
          text: `Honcho: ${health?.status || 'unknown'} | Workspace: ${cfg.workspace || 'not set'} | URL: ${cfg.honchoUrl} | Queue: ${queue ? (queue.pending ?? '?') + ' pending' : 'n/a'}`,
        };
      },
    };
  }

  function defineHonchoDream() {
    return {
      name: 'honcho_dream',
      description: 'Trigger a Honcho "dream" (offline processing pass). Types: card_refresh (update peer cards), omni (full reprocessing).',
      parameters: {
        dream_type: { type: 'string', enum: ['card_refresh', 'omni'], description: 'Type of dream to run.' },
        observer: { type: 'string', description: 'Observer peer (default: agent peer).' },
        observed: { type: 'string', description: 'Observed peer (default: user peer).' },
      },
      async execute(args) {
        const observer = args.observer || cfg.agentPeer;
        const observed = args.observed || cfg.userPeer;
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg.workspace}/schedule_dream`,
          { type: args.dream_type || 'card_refresh', observer, observed }
        );
        if (!result) return { ok: false, tool: 'honcho_dream', text: 'Error scheduling dream.' };
        return { ok: true, tool: 'honcho_dream', text: `Dream scheduled: ${args.dream_type || 'card_refresh'}.` };
      },
    };
  }

  function defineHonchoQueue() {
    return {
      name: 'honcho_queue',
      description: 'Check the Honcho processing queue status (pending/active/completed tasks).',
      parameters: {},
      async execute() {
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg.workspace}/queue/status`
        );
        if (!result) return { ok: true, tool: 'honcho_queue', text: 'Error fetching queue status.' };
        return { ok: true, tool: 'honcho_queue', text: JSON.stringify(result, null, 2).slice(0, 3000) };
      },
    };
  }

  // ─── Register all tools ───

  const tools = [
    // Memory
    defineHonchoRecall(),
    defineHonchoAsk(),
    defineHonchoRemember(),
    defineHonchoContext(),
    // Search
    defineHonchoSearch(),
    defineHonchoSessionSearch(),
    // Profile
    defineHonchoProfile(),
    defineHonchoRepresentation(),
    // Session
    defineHonchoSession(),
    defineHonchoSessionCreate(),
    defineHonchoSessionClone(),
    defineHonchoSessionPeers(),
    defineHonchoSessionSummaries(),
    // Peer
    defineHonchoPeer(),
    defineHonchoPeerCreate(),
    // Conclude
    defineHonchoConclude(),
    defineHonchoConcludeList(),
    defineHonchoConcludeQuery(),
    // Admin
    defineHonchoStatus(),
    defineHonchoDream(),
    defineHonchoQueue(),
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

  // ─── Context injection on session start (Layer 1) ───

  async function buildMemoryContext(honchoSid) {
    const base = `${cfg.honchoUrl}/v3/workspaces/${cfg.workspace}`;
    const parts = [];
    const errors = [];

    // Peer cards (GET, immediate).
    for (const peer of [cfg.userPeer, cfg.agentPeer]) {
      try {
        const d = await honchoRequest('GET', `${base}/peers/${peer}/card`, undefined, 5000);
        if (!d) { errors.push(`card:${peer}:timeout`); continue; }
        const card = Array.isArray(d.peer_card) ? d.peer_card : [];
        if (card.length > 0) {
          parts.push(`[Peer Card: ${peer}]\n${card.join('\n')}`);
        }
      } catch (e) { errors.push(`card:${peer}:${e.message}`); }
    }

    // Representations (POST, may take a few seconds).
    for (const peer of [cfg.userPeer, cfg.agentPeer]) {
      try {
        const d = await honchoRequest('POST', `${base}/peers/${peer}/representation`, {}, 8000);
        if (!d) { errors.push(`repr:${peer}:timeout`); continue; }
        const text = typeof d === 'string' ? d : (d.representation || '');
        if (text && text.trim().length > 0) {
          parts.push(`[Representation: ${peer}]\n${text.trim()}`);
        }
      } catch (e) { errors.push(`repr:${peer}:${e.message}`); }
    }

    // Session summary + context extras.
    try {
      const d = await honchoRequest('GET',
        `${base}/sessions/${honchoSid}/context?summary=true&tokens=500`,
        undefined, 5000
      );
      if (d && d.summary) parts.push(`[Session Summary]\n${d.summary}`);
    } catch (e) { errors.push(`context:${e.message}`); }

    if (parts.length === 0) return null;

    let body = parts.join('\n\n');
    const maxChars = cfg.injectionMaxChars || 4000;
    if (body.length > maxChars) {
      body = body.slice(0, maxChars) + ' …[truncated]';
    }

    const note = errors.length > 0 ? `\n<!-- honcho-sync partial: ${errors.join('; ')} -->` : '';
    return `<memory-context>\n${body}\n</memory-context>${note}`;
  }

  if (cfg.autoRecall && systemPrompt !== undefined) {
    ctx.on('session/event', async (session, event) => {
      if (!session || !event) return;
      if (event.type !== 'user/message') return;
      const sessionId = session.id;
      if (!sessionId) return;

      const s = state.get(sessionId);
      if (s?.injected) return;
      state.set(sessionId, { ...(s || {}), injected: true });

      try {
        const snapshot = await sessionQuery.readSession(sessionId);
        const header = snapshot.session;
        if (!header) return;
        const cwd = header.cwd || '';
        const honchoSid = honchoSessionId(cwd);

        const text = await buildMemoryContext(honchoSid);
        if (text === null) return;

        const dispose = systemPrompt.context({
          name: 'honcho:memory',
          order: 120,
          text,
        });

        // Re-check: if the session died while we were fetching, drop it.
        const sessionsService = ctx.get('sessions');
        const stillThere = sessionsService ? sessionsService.get(sessionId) : undefined;
        if (stillThere === undefined) {
          dispose();
          return;
        }

        state.set(sessionId, { ...state.get(sessionId), injectDispose: dispose });
        console.log(`[honcho-sync] injected memory context for ${honchoSid} (${text.length} chars)`);
      } catch (e) {
        console.error(`[honcho-sync] inject error:`, e.message);
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

      // Get sync state: track last synced event count
      const s = state.get(honchoSid) || { lastSyncedEventCount: 0 };
      const lastCount = s.lastSyncedEventCount || 0;

      if (events.length <= lastCount) return;

      // Build messages from ALL new events since last sync
      const newEvents = events.slice(lastCount);
      const messages = [];

      for (const ev of newEvents) {
        if (!ev || !ev.data) continue;
        if (ev.type === 'user/message') {
          const text = extractText(ev.data.content);
          if (text) {
            messages.push({ role: 'user', content: text.slice(0, cfg.messageMaxChars), peer_id: cfg.userPeer });
          }
        } else if (ev.type === 'assistant/message') {
          const msg = ev.data.message || ev.data;
          const text = extractText(msg.content);
          if (text) {
            messages.push({ role: 'assistant', content: text.slice(0, cfg.messageMaxChars), peer_id: cfg.agentPeer });
          }
        }
      }

      if (messages.length === 0) {
        state.set(honchoSid, { ...s, lastSyncedEventCount: events.length });
        return;
      }

      console.log(`[honcho-sync] posting ${messages.length} messages to ${honchoSid}`);
      await postToHoncho(honchoSid, messages);
      state.set(honchoSid, { ...s, lastSyncedEventCount: events.length });
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

  if (cfg.autoSync) {
    ctx.on('session/event', (session, event) => {
      if (!session || !event) return;
      if (event.type !== 'assistant/message' && event.type !== 'user/message') return;
      const sessionId = session.id;
      if (!sessionId) return;
      scheduleSync(sessionId);
    });
  }

  // Cleanup
  ctx.effect(() => {
    return () => {
      for (const [, s] of state.values()) {
        if (s.timer) clearTimeout(s.timer);
        if (typeof s.injectDispose === 'function') s.injectDispose();
      }
      state.clear();
    };
  });

