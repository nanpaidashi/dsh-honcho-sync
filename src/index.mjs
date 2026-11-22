import path from 'node:path';
import fs from 'node:fs';
/**
 * @nanpaidashi/dsh-honcho-sync — Honcho Memory Plugin for DeepSeek Harness (v0.8.0)
 *
 * Give DSH persistent memory: auto-sync every conversation turn to a
 * self-hosted Honcho service, and equip the AI with a full set of tools
 * covering the official Honcho v3 API surface.
 *
 * === v0.8.0: DSH 0.1.0-rc.8 Compatibility ===
 *
 * - normalizeToolParameters(): Converts legacy parameter shorthand to standard JSON Schema
 *   (required by DSH >= 2026 for strict schema validation)
 * - output.render: Returns content blocks array [{ type: 'text', text: '...' }]
 *   (required by DSH >= 2026; returning a string causes "content is not iterable")
 *
 * === Features ===
 *
 * Core:
 *   - Auto-sync with debounce + lastSyncedEventCount tracking
 *   - buildMemoryContext() with peer cards + representations injection
 *   - Semantic deduplication chain: _trimRepresentation / _semanticOverlap /
 *     _deduplicateSemantic / _extractCardFacts
 *   - loadState/saveState persistence via ~/.dsh/honcho-sync-state.json
 *
 * Tools provided (25 total, grouped by domain):
 *   Memory  : honcho_recall, honcho_ask, honcho_remember, honcho_context
 *   Search  : honcho_search, honcho_session_search
 *   Profile : honcho_profile, honcho_representation
 *   Session : honcho_session, honcho_session_create, honcho_session_clone,
 *             honcho_session_peers, honcho_session_summaries, honcho_session_context
 *   Peer    : honcho_peer, honcho_peer_create, honcho_peer_list
 *   Message : honcho_message_send, honcho_message_get
 *   Conclude: honcho_conclude, honcho_conclude_list, honcho_conclude_query
 *   Admin   : honcho_status, honcho_dream, honcho_queue
 *
 * Configuration (NO settings panel — use environment variables):
 *   Edit ~/.config/systemd/user/dsh-web.service and add:
 *     Environment="HONCHO_URL=http://localhost:8000"
 *     Environment="HONCHO_WORKSPACE=my-workspace"
 *     Environment="HONCHO_USER_PEER=user"
 *     Environment="HONCHO_AGENT_PEER=agent"
 *
 * Installation:
 *   dsh plugin --profile web add link:https://github.com/nanpaidashi/dsh-honcho-sync dsh web
 *
 * @module @nanpaidashi/dsh-honcho-sync
 */

// HONCHO-SYNC REWRITE (2026-11-22): lokales Änderungspaket, siehe
// apply-dsh-honcho-fixes.ps1 (Fix 6-14) und
// C:\Users\dkdk9\source\repos\hermes\DOKU-DSH-Honcho-Sync-Injection.md.
// Dieser Marker ist der Idempotenz-Anker des Re-Apply-Skripts.

const name = 'honcho-sync';
// HONCHO-SYNC INJECT-FIX (2026-08-22): inject all consumed services (tools,
// sessionQuery, systemPrompt) so apply() runs only after they are ready.
const inject = ['tools', 'sessionQuery', 'systemPrompt'];

// ─── Config helpers ────────────────────────────────────────────────────────

// Extended defaults with local plugin knobs
// HONCHO-SYNC TUNING (2026-11-22): the retrieval knobs and the injection budget
// follow the official plastic-labs integrations (claude-honcho,
// opencode-honcho): the server bounds the payload through
// max_conclusions/search_top_k, and injectionMaxChars is only the last-resort
// ceiling. Measured session-start payload for this account: 10.950 chars.
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
  injectionMaxChars: 12000,
  // A query-curated representation is a few hundred chars long, so keeping
  // every block is cheap; the cap only guards an uncurated dump.
  reprMaxObs: 20,
  reprTimeoutMs: 8000,
  cardTimeoutMs: 5000,
  searchTopK: 5,
  searchMaxDistance: 0.7,
  maxConclusionsUser: 12,
  maxConclusionsAgent: 8,
  includeMostFrequent: true,
  summaryMaxChars: 4000,
  summaryTimeoutMs: 8000,
  // Failure behaviour: fail loudly instead of silently returning null, and
  // retry an injection that failed on an earlier turn of the same session.
  preflight: true,
  preflightTimeoutMs: 3000,
  injectionRetries: 3,
  errorLogMaxBytes: 1048576,
};

let _resolvedSettings = null; // Set by settings panel via scope.watch

// ─── Settings schema (DSH settings panel) ─────────────────────────────────

// HONCHO-SYNC CONFIG-SCHEMA (2026-11-22): DSH derives its settings form from
// the plugin's exported Config schema; without one the plugin has no panel page
// (the previous code called settings.register(), an API this DSH version no
// longer has). schemastery ships inside the DSH installation and is reachable
// from this package through a single link in the profile. When that link is
// missing, the plugin keeps working without a form instead of failing to load.
let Config;
try {
  const { default: z } = await import('@deepseek-ai/schemastery');
  Config = z.object({
    honchoUrl: z.string().description('Honcho base URL, e.g. http://host:8123').volatile(),
    workspace: z.string().description('Honcho workspace name').volatile(),
    userPeer: z.string().default('user').description('Peer that represents you').volatile(),
    agentPeer: z.string().default('agent').description('Peer that represents the agent').volatile(),
    autoRecall: z.boolean().default(true).description('Inject memory at session start').volatile(),
    autoSync: z.boolean().default(true).description('Upload new turns to Honcho').volatile(),
    preflight: z.boolean().default(true).description('Check /health at load and refuse to start when it fails').volatile(),
    preflightTimeoutMs: z.number().step(1).min(100).default(3000).description('Preflight deadline in ms').volatile(),
    injectionMaxChars: z.number().step(1).min(500).default(12000).description('Hard ceiling for one injected block').volatile(),
    summaryMaxChars: z.number().step(1).min(200).default(4000).description('Cap for the session summary').volatile(),
    searchTopK: z.number().step(1).min(1).max(100).default(5).description('Semantic conclusions pulled per peer').volatile(),
    searchMaxDistance: z.number().min(0).max(1).default(0.7).description('Maximum semantic distance (lower is stricter)').volatile(),
    maxConclusionsUser: z.number().step(1).min(1).max(100).default(12).description('Representation size for the user peer').volatile(),
    maxConclusionsAgent: z.number().step(1).min(1).max(100).default(8).description('Representation size for the agent peer').volatile(),
    includeMostFrequent: z.boolean().default(true).description('Add the most frequent conclusions').volatile(),
    reprMaxObs: z.number().step(1).min(1).default(20).description('Observation blocks kept per peer').volatile(),
    messageMaxChars: z.number().step(1).min(1000).default(25000).description('Per-message upload cap').volatile(),
    debounceMs: z.number().step(1).min(100).default(3000).description('Sync debounce in ms').volatile(),
    injectionRetries: z.number().step(1).min(0).max(10).default(3).description('Injection attempts per session').volatile(),
  }).description('Honcho memory bridge: session-start recall and turn sync');
} catch (error) {
  console.warn(`[honcho-sync] settings form unavailable (no @deepseek-ai/schemastery): ${error?.message ?? error}`);
}

/**
 * Unwrap a schemastery volatile value.
 * HONCHO-SYNC VOLATILE-FIX (2026-11-22): a `.volatile()` config field does not
 * arrive as a plain value but as `{ get() }`. Reading it directly yields an
 * object, and `Number(object)` is NaN — which would silently poison every budget
 * computation. Unwrap both shapes so the plugin works with or without a schema.
 */
function _unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get(); } catch { return undefined; }
  }
  return value;
}

/** First non-empty string among the candidates, unwrapping volatile values. */
function _pickString(...candidates) {
  for (const candidate of candidates) {
    const value = _unwrap(candidate);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/** Read one knob: resolved settings first, then the profile config, then the default. */
function _pick(resolvedSettings, config, key) {
  const value = _unwrap(resolvedSettings?.[key] ?? config?.[key]);
  if (value === undefined || value === null) return DEFAULTS[key];
  if (typeof DEFAULTS[key] === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : DEFAULTS[key];
  }
  if (typeof DEFAULTS[key] === 'boolean') return typeof value === 'boolean' ? value : Boolean(value);
  return value;
}

function getConfig(config, resolvedSettings) {
  const url = _pickString(resolvedSettings?.honchoUrl, config?.honchoUrl, process.env.HONCHO_URL).replace(/\/$/, '');
  const tuning = {
    debounceMs: _pick(resolvedSettings, config, 'debounceMs'),
    recallBudget: _pick(resolvedSettings, config, 'recallBudget'),
    messageMaxChars: _pick(resolvedSettings, config, 'messageMaxChars'),
    injectionMaxChars: _pick(resolvedSettings, config, 'injectionMaxChars'),
    reprMaxObs: _pick(resolvedSettings, config, 'reprMaxObs'),
    reprTimeoutMs: _pick(resolvedSettings, config, 'reprTimeoutMs'),
    cardTimeoutMs: _pick(resolvedSettings, config, 'cardTimeoutMs'),
    searchTopK: _pick(resolvedSettings, config, 'searchTopK'),
    searchMaxDistance: _pick(resolvedSettings, config, 'searchMaxDistance'),
    maxConclusionsUser: _pick(resolvedSettings, config, 'maxConclusionsUser'),
    maxConclusionsAgent: _pick(resolvedSettings, config, 'maxConclusionsAgent'),
    includeMostFrequent: _pick(resolvedSettings, config, 'includeMostFrequent'),
    summaryMaxChars: _pick(resolvedSettings, config, 'summaryMaxChars'),
    summaryTimeoutMs: _pick(resolvedSettings, config, 'summaryTimeoutMs'),
    preflight: _pick(resolvedSettings, config, 'preflight'),
    preflightTimeoutMs: _pick(resolvedSettings, config, 'preflightTimeoutMs'),
    injectionRetries: _pick(resolvedSettings, config, 'injectionRetries'),
    errorLogMaxBytes: _pick(resolvedSettings, config, 'errorLogMaxBytes'),
  };
  const peers = {
    workspace: _pickString(resolvedSettings?.workspace, config?.workspace, process.env.HONCHO_WORKSPACE),
    userPeer: _pickString(resolvedSettings?.userPeer, config?.userPeer, process.env.HONCHO_USER_PEER) || 'user',
    agentPeer: _pickString(resolvedSettings?.agentPeer, config?.agentPeer, process.env.HONCHO_AGENT_PEER) || 'agent',
  };
  const disabled = (configError) => ({
    honchoUrl: url,
    ...peers,
    ...tuning,
    autoRecall: false,
    autoSync: false,
    configError,
  });
  // HONCHO-SYNC CONFIG-FIX (2026-11-22): a broken honchoUrl used to surface as
  // `TypeError: Failed to parse URL from <garbage>` at the first request, long
  // after load. Validate here so apply() can refuse to start with a precise
  // message instead of failing somewhere downstream.
  if (!url) {
    return disabled('honchoUrl is not configured. Set honchoUrl in the profile patch (cordis.patch.yml) or the HONCHO_URL environment variable.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return disabled(`honchoUrl is not a valid absolute URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return disabled(`honchoUrl must use http or https, got ${JSON.stringify(parsed.protocol)}`);
  }
  if (!peers.workspace) {
    return disabled('workspace is not configured. Set workspace in the profile patch (cordis.patch.yml) or the HONCHO_WORKSPACE environment variable.');
  }
  return {
    honchoUrl: url,
    ...peers,
    ...tuning,
    autoRecall: _pick(resolvedSettings, config, 'autoRecall'),
    autoSync: _pick(resolvedSettings, config, 'autoSync'),
  };
}

// ─── Failure reporting ─────────────────────────────────────────────────────

// HONCHO-SYNC LOUD-FAIL (2026-11-22): failures used to reach `console.error`
// only — the stdout of whatever process hosts DSH — so a permanent breakage was
// invisible unless someone happened to read the terminal. Every warning and
// error now also goes to ctx.logger (which DSH names per plugin) and to an
// append-only file, so a failure stays findable days later.
let _pluginCtx = null;

/** Absolute path of the append-only plugin error log. */
function _errorLogPath() {
  return path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.dsh', 'logs', 'honcho-sync.log');
}

/** Append one line to the plugin error log, rotating at the configured size. */
function _appendErrorLog(line) {
  const logPath = _errorLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
      const limit = DEFAULTS.errorLogMaxBytes;
      if (fs.statSync(logPath).size > limit) fs.renameSync(logPath, `${logPath}.1`);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e; // No previous log is the normal first write.
    }
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch (e) {
    console.error(`[honcho-sync] cannot write ${logPath}: ${e.message}`);
  }
}

/**
 * Report a plugin failure through every available channel.
 * @param level - logger severity; `warn` and `error` are persisted to disk.
 * @param message - complete, self-contained description (include the URL or peer).
 */
function _honchoLog(level, message) {
  try {
    if (_pluginCtx?.logger) _pluginCtx.logger('honcho-sync')[level](message);
    else console[level === 'debug' ? 'log' : level](`[honcho-sync] ${message}`);
  } catch {
    // The logger itself is unavailable (early boot): keep the message on stderr.
    console.error(`[honcho-sync] ${message}`);
  }
  if (level === 'warn' || level === 'error') {
    _appendErrorLog(`${new Date().toISOString()} ${level.toUpperCase()} ${message}`);
  }
}

// ─── Persistence (debounce state survives DSH restart) ─────────────────────

// USERPROFILE fallback: HOME is usually unset on Windows, which silently broke
// sync-cursor persistence (duplicate syncs after a restart).
const PERSIST_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.dsh', 'honcho-sync-state.json');
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(PERSIST_FILE, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    _honchoLog('error', `cannot read sync state ${PERSIST_FILE}: ${e.message}`);
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Never fall back to `{}`: that silently re-syncs every session from zero.
    const aside = `${PERSIST_FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(PERSIST_FILE, aside); } catch (moveError) {
      _honchoLog('error', `sync state ${PERSIST_FILE} is corrupt and cannot be moved aside: ${moveError.message}`);
      throw e;
    }
    _honchoLog('error', `sync state ${PERSIST_FILE} is corrupt (${e.message}); moved to ${aside}, next sync starts at 0`);
    return {};
  }
}
function saveState(s) {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(s), 'utf8');
  } catch (e) {
    // Losing the cursor re-syncs whole sessions on the next start: must be loud.
    _honchoLog('error', `cannot write sync state ${PERSIST_FILE}: ${e.message}`);
    throw e;
  }
}

// ─── Main plugin ───────────────────────────────────────────────────────────

async function apply(ctx, config) {
  _pluginCtx = ctx;
  const sessionQuery = ctx.get('sessionQuery');
  const systemPrompt = ctx.get('systemPrompt');

  // HONCHO-SYNC SETTINGS-FIX (2026-11-22): the previous settings namespace
  // wiring called settingsCtx.settings.register(), which does not exist in this
  // DSH version — it threw `settingsCtx.settings.register is not a function` on
  // every load, so the block never took effect and only produced a startup
  // error. DSH derives settings forms from a plugin's exported Config schema,
  // which this plain .mjs plugin cannot provide without importing schemastery
  // from a profile install whose junction currently dangles. The knobs below
  // live in cordis.patch.yml and take effect on the next load.
  let resolvedSettings = { ...DEFAULTS, ...(config || {}) };
  /** Live view of the effective configuration. Never cache this across awaits. */
  const cfg = () => getConfig(config, resolvedSettings);
  const state = new Map();

  // Refuse to start on an unusable configuration instead of degrading into
  // silent no-ops: the fiber fails loudly, DSH itself keeps running.
  const initial = cfg();
  if (initial.configError) throw new Error(`honcho-sync: ${initial.configError}`);

  // ─── Honcho API helpers ────────────────────────────────────────────────

  /**
   * Call the Honcho API.
   * @param method - HTTP method.
   * @param path - path **relative** to honchoUrl, always starting with `/`.
   * @param body - JSON body; omitted for GET and DELETE.
   * @param timeoutMs - abort deadline for this request.
   * @returns the parsed JSON response, or the response text for non-JSON replies.
   * @throws when the path is not relative, the request fails, or the server
   * returns a non-2xx status. Callers decide whether the failure is fatal.
   */
  async function honchoRequest(method, path, body, timeoutMs = 15000) {
    const c = cfg();
    if (!c.honchoUrl) throw new Error('honcho-sync: honchoUrl is not configured');
    // HONCHO-SYNC URL-GUARD (2026-11-22): a path that already carries the base
    // URL produced `TypeError: Failed to parse URL from <url><url>` and was
    // silently swallowed here. Refuse it with a message that names the culprit.
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error(`honcho-sync: honchoRequest path must be relative and start with "/", got ${JSON.stringify(path)}`);
    }
    const url = `${c.honchoUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal };
    if (body !== undefined) opts.body = JSON.stringify(body);
    else if (method !== 'GET' && method !== 'DELETE') opts.body = '{}';
    try {
      const resp = await fetch(url, opts);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Honcho ${method} ${url} -> ${resp.status} ${resp.statusText} ${text.slice(0, 200)}`.trim());
      }
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('json')) return await resp.json();
      return await resp.text();
    } catch (e) {
      const message = e?.name === 'AbortError'
        ? `Honcho ${method} ${url} timed out after ${timeoutMs}ms`
        : (e?.message ?? String(e));
      _honchoLog('error', message);
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  // P0 fix (2026-08-20): per-directory LONG-LIVED sessions.
  // Official Honcho docs flag per-day session splitting as an anti-pattern
  // ("Don't scope sessions too thin") — the background Deriver needs a single
  // session to accumulate ~1000 tokens before it can reason effectively.
  // dateStr is accepted for backward compatibility but ignored.
  function honchoSessionId(cwd, _dateStr) {
    const basePrefix = cwd ? 'dsh-' + cwd.split('/').filter(Boolean).join('-').replace(/[^a-zA-Z0-9_-]/g, '-') : 'dsh-unknown';
    return basePrefix;
  }

  function extractText(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text)
      .join('');
  }

  // ─── Semantic deduplication chain (local plugin unique features) ──────

  /**
   * Trim and refine representation text:
   * 1. Split by top-level [timestamp] blocks
   * 2. Filter out blocks whose content overlaps with peer card facts (IP/keyword/phrase)
   * 3. Deduplicate semantically similar blocks
   * 4. Convert timestamps to CST (+8h), keep last N observations
   */
  function _trimRepresentation(text, maxObs, peerCard) {
    if (!text) return null;

    const lines = text.split('\n');
    const blocks = [];
    let current = [];
    for (const line of lines) {
      if (/^\[/.test(line.trim()) && !line.trim().startsWith('#')) {
        if (current.length > 0) blocks.push(current.join('\n'));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) blocks.push(current.join('\n'));

    const cardFacts = _extractCardFacts(peerCard);

    const filtered = blocks.filter(block => {
      const content = _blockText(block);
      for (const fact of cardFacts) {
        if (_semanticOverlap(content, fact)) return false;
      }
      return true;
    });

    const deduped = _deduplicateSemantic(filtered);

    const converted = deduped.map(b => {
      const m = b.match(/^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]/);
      if (m) {
        // HONCHO-SYNC TIMESTAMP-FIX (2026-11-22): the old code shifted every
        // timestamp by a hardcoded +8h (CST), which silently dated observations
        // in the future for a CET host. Honcho reports UTC; render local time.
        const date = new Date(m[1] + 'T' + m[2] + 'Z');
        const ts = date.toLocaleString('sv-SE').slice(0, 19);
        return '[' + ts + '] ' + b.slice(m[0].length).trimStart();
      }
      return b;
    });
    const kept = converted.slice(-maxObs);
    return kept.join('\n');
  }

  /** Extract IDENTITY/ATTRIBUTE/RELATIONSHIP/INSTRUCTION facts from a peer card */
  function _extractCardFacts(card) {
    if (!Array.isArray(card)) return [];
    return card
      .filter(f => f && typeof f === 'string')
      .map(f => {
        const m = f.match(/^(?:IDENTITY|ATTRIBUTE|RELATIONSHIP|INSTRUCTION):\s*(.+)$/);
        return m ? m[1].toLowerCase() : f.toLowerCase();
      })
      .filter(f => f.length > 10);
  }

  /** Extract the body text after the timestamp prefix of a block */
  function _blockText(block) {
    const m = block.match(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*(.+)$/);
    return m ? m[1] : block;
  }

  /**
   * Semantic overlap detection between two text strings.
   * Returns true if:
   *   - Both contain overlapping 192.168.x.x IPs
   *   - Keyword Jaccard similarity > 0.3
   *   - Any 3-gram phrase from a appears in b
   */
  function _semanticOverlap(a, b) {
    if (!a || !b) return false;
    const aL = a.toLowerCase();
    const bL = b.toLowerCase();

    // IP overlap
    const ipA = aL.match(/192\.168\.\d+\.\d+/g);
    const ipB = bL.match(/192\.168\.\d+\.\d+/g);
    if (ipA && ipB && ipA.some(ip => ipB.includes(ip))) return true;

    // Keyword overlap (Jaccard)
    const wordsA = new Set(aL.split(/\W+/).filter(w => w.length > 3));
    const wordsB = new Set(bL.split(/\W+/).filter(w => w.length > 3));
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = new Set([...wordsA, ...wordsB]).size;
    if (union === 0) return false;
    if (intersection / union > 0.3) return true;

    // Key phrase overlap (3-gram)
    const allWords = aL.split(/\W+/).filter(w => w.length > 2);
    for (let i = 0; i < allWords.length - 2; i++) {
      if (bL.includes(allWords.slice(i, i + 3).join(' '))) return true;
    }

    return false;
  }

  /** Content-based deduplication: deduplicate blocks with same leading content key */
  function _deduplicateSemantic(blocks) {
    const seen = new Map();
    for (const block of blocks) {
      const content = _blockText(block);
      const key = content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
      seen.set(key, block);
    }
    return Array.from(seen.values());
  }

  /**
   * P2 (2026-08-20): Filter representation to remove low-value content.
   * - Remove Pattern [medium] and Pattern [low] blocks entirely (including Type/Sources)
   * - Remove Premises: and Sources: sections (model doesn't need provenance)
   * - For Pattern [high]: keep only the pattern description line, remove Type/Sources
   * - Keep only high-value observations
   */
  function _filterRepresentation(text) {
    if (!text) return null;

    const lines = text.split('\n');
    const kept = [];
    let skipUntilBoundary = false; // Skip entire medium/low pattern block
    let inSources = false; // Inside a Sources section (any level)

    for (const line of lines) {
      const trimmed = line.trim();

      // Block boundaries: timestamp lines or ## section headers
      const isBoundary = /^\[\d{4}-\d{2}-\d{2}/.test(trimmed) || /^##/.test(trimmed);
      if (isBoundary) {
        skipUntilBoundary = false;
        inSources = false;
      }

      // A new Pattern line ends any previous pattern block
      const patternMatch = trimmed.match(/\*\*Pattern\*\*\s*\[(\w+)\]:/);
      if (patternMatch) {
        skipUntilBoundary = false;
        inSources = false;
        const level = patternMatch[1].toLowerCase();

        // Skip medium/low patterns entirely (this line + Type + Sources until next boundary)
        if (level === 'medium' || level === 'low') {
          skipUntilBoundary = true;
          continue;
        }

        // high: keep only the pattern description line
        kept.push(line);
        inSources = false;
        continue;
      }

      // Inside a skipped medium/low block
      if (skipUntilBoundary) {
        continue;
      }

      // Provenance lines — skip anywhere (they appear both inside and outside
      // Pattern blocks in Honcho representations).
      // Sources section (any form: "**Sources**:" or "Sources:") — skip it and its bullets
      if (/^\*{0,2}Sources\*{0,2}:/.test(trimmed)) {
        inSources = true;
        continue;
      }
      // Type line (e.g. "**Type**: tendency")
      if (/^\*{0,2}Type\*{0,2}:/.test(trimmed)) {
        continue;
      }
      // Premises section
      if (/^Premises:/.test(trimmed)) {
        inSources = true; // reuse inSources as a generic "skip bullets" flag
        continue;
      }
      // Bullet lines inside an active Sources/Premises section
      if (inSources) {
        if (/^- /.test(trimmed) || trimmed.startsWith('... and')) {
          continue;
        }
        // Non-bullet content ends the section
        inSources = false;
        // fall through to normal handling below
      }

      kept.push(line);
    }

    // Collapse 3+ consecutive blank lines to 1
    const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return result || null;
  }

  /**
   * HONCHO-SYNC BUDGET-FIX (2026-11-22): assemble the injected parts under a
   * character ceiling.
   *
   * The previous greedy walk let the first part consume the whole budget, so a
   * peer card larger than the ceiling silently dropped the summary and every
   * observation. Each part now gets a reserved share first, and whatever is
   * left over is handed to the parts that are still truncated, in priority
   * order.
   * @param parts - keyed payload sections; absent keys are skipped.
   * @param maxChars - total ceiling for the assembled body.
   * @returns the joined body, never longer than maxChars plus a truncation marker.
   */
  function _assembleWithReserves(parts, maxChars) {
    const layout = [
      { key: 'peer-context', share: 0.45 },
      { key: 'session-summary', share: 0.25 },
    ].filter((entry) => parts[entry.key]);
    if (layout.length === 0) return '';

    const allocation = new Map();
    let budget = maxChars;
    for (const { key, share } of layout) {
      const wanted = Math.min(parts[key].length, Math.floor(maxChars * share));
      const granted = Math.min(wanted, budget);
      allocation.set(key, granted);
      budget -= granted;
    }
    for (const { key } of layout) {
      if (budget <= 0) break;
      const granted = allocation.get(key);
      const missing = parts[key].length - granted;
      if (missing <= 0) continue;
      const extra = Math.min(missing, budget);
      allocation.set(key, granted + extra);
      budget -= extra;
    }
    return layout
      .map(({ key }) => _clampLines(parts[key], allocation.get(key)))
      .filter(Boolean)
      .join('\n\n');
  }

  // ─── Memory tools ──────────────────────────────────────────────────────

  function defineHonchoRecall() {
    return {
      name: 'honcho_recall',
      description: 'Quick semantic search across Honcho memory (messages + conclusions). Use for lookups: "what was decided about X".',
      parameters: {
        query: { type: 'string', required: true, description: 'Search query — describe what you are looking for.' },
        limit: { type: 'integer', description: 'Number of results to return per source. Default 5, max 10.' },
      },
      async execute(args, exec) {
        const n = Math.min(Math.max(args?.limit || 5, 1), 10);
        const cwd = exec?.agent?.session?.header?.cwd || '';
        const base = `/v3/workspaces/${cfg().workspace}`;

        // HONCHO-SYNC FIX (2026-08-22): normalize/validate the query before
        // sending. The model sometimes omits args (DSH parseArguments -> {}) or
        // passes a non-string; the server then answers 422 on BOTH /search and
        // /conclusions/query, which honchoRequest maps to null -> misleading
        // "server error or timeout".
        const raw = args?.query;
        const query = typeof raw === 'string' ? raw.trim() : (raw == null ? '' : String(raw).trim());
        if (!query) {
          return {
            ok: true,
            tool: 'honcho_recall',
            results: ['honcho_recall requires a non-empty string "query" with the search terms.'],
            count: 1,
          };
        }

        // P1 (2026-08-20): hybrid recall — messages AND conclusions in parallel.
        // Conclusions are the reasoned layer (explicit/deductive/inductive);
        // messages alone miss everything the Deriver/Dreamer has inferred.
        // HONCHO-SYNC LOUD-FAIL (2026-11-22): allSettled so one failing source
        // still returns the other's hits, and the failure is named in the result
        // the model sees instead of being swallowed.
        const [msgOutcome, conclOutcome] = await Promise.allSettled([
          honchoRequest('POST', `${base}/search`,
            { query, limit: n, max_tokens: 2000 },
            30000
          ),
          honchoRequest('POST', `${base}/conclusions/query`,
            { query, limit: n, max_distance: 0.85, filters: { observer: cfg().agentPeer, observed: cfg().userPeer } },
            30000
          ),
        ]);
        const msgResult = msgOutcome.status === 'fulfilled' ? msgOutcome.value : null;
        const conclResult = conclOutcome.status === 'fulfilled' ? conclOutcome.value : null;
        const sourceErrors = [];
        if (msgOutcome.status === 'rejected') sourceErrors.push(`search: ${msgOutcome.reason?.message ?? msgOutcome.reason}`);
        if (conclOutcome.status === 'rejected') sourceErrors.push(`conclusions: ${conclOutcome.reason?.message ?? conclOutcome.reason}`);

        // HONCHO-SYNC FALLBACK (2026-08-23): natural-language German questions
        // ("welche Bewerbungen wurden am 21. und 22. August versendet") rank
        // poorly against the english-oriented semantic stack, so when the first
        // search yields few/no hits we retry with a stopword-stripped phrase.
        // Combined results are deduped and sorted newest-first, which puts the
        // Telegram application messages (21./22.08) on top.
        const STOPWORDS = new Set([
          'der','die','das','den','dem','des','ein','eine','einer','einem','einen','eines',
          'und','oder','aber','am','um','im','in','an','auf','fuer','von','zu','mit','ueber',
          'nach','bei','aus','auch','noch','nicht','kein','keine','kann','koennen','wurde',
          'wurden','werden','wird','hat','haben','ist','sind','war','waren','welche','welcher',
          'welchem','welches','wie','was','wer','wo','wann','warum','denn','dann','dass','diese',
          'dieser','diesem','the','a','an','of','to','in','on','for','and','or','is','are','was',
          'were','have','has','had','be','by','with','from','at','as','it','this','that','these',
          'those','please','list','show','make','me','all','my','hier','bitte','auf','ueber',
        ]);
        const cleanedQuery = query
          .split(/\s+/)
          .map((t) => t.replace(/[.,!?;:"'()]/g, ''))
          .filter((t) => t.length > 2 && !STOPWORDS.has(t.toLowerCase()))
          .join(' ')
          .trim();

        const results = [];
        // /search returns a bare array (not {results: []})
        let msgArr = Array.isArray(msgResult) ? msgResult : (msgResult?.results || []);
        if (msgArr.length < 2 && cleanedQuery && cleanedQuery !== query) {
          const fbResult = await honchoRequest('POST', `${base}/search`,
            { query: cleanedQuery, limit: n, max_tokens: 2000 },
            30000
          );
          const fbArr = Array.isArray(fbResult) ? fbResult : (fbResult?.results || []);
          if (fbArr.length > 0) {
            const seen = new Set(msgArr.map((m) => m.id || m.content));
            for (const m of fbArr) {
              const key = m.id || m.content;
              if (!seen.has(key)) { seen.add(key); msgArr.push(m); }
            }
          }
        }
        if (msgArr.length > 0) {
          msgArr = [...msgArr].sort((a, b) =>
            String(b.created_at || '').localeCompare(String(a.created_at || ''))
          ).slice(0, n);
        }
        if (msgArr.length > 0) {
          for (const r of msgArr) {
            const content = (r.content || '').slice(0, 400);
            const peer = r.peer_id || '?';
            const ts = (r.created_at || '').replace('T', ' ').replace('Z', '').slice(0, 16);
            results.push(`[message ${peer} ${ts}] ${content}`);
          }
        } else if (!msgResult) {
          results.push('[message search failed — honcho server error or timeout (see ~/.dsh/logs/honcho-sync.log)]');
        }
        // /conclusions/query returns bare array or {results: []}
        const conclArr = Array.isArray(conclResult) ? conclResult : (conclResult?.results || []);
        if (conclArr.length > 0) {
          // HONCHO-SYNC FIX (2026-08-22): iterate conclArr. The server returns a
          // bare array, so `conclResult.results` is undefined and threw
          // TypeError: conclResult.results is not iterable.
          for (const r of conclArr) {
            const text = (r.conclusion || r.content || '').slice(0, 400);
            const type = r.level || r.conclusion_type || 'unknown';
            const conf = r.confidence != null ? ` conf=${Number(r.confidence).toFixed(2)}` : '';
            const peer = r.peer_id || r.observer_id || r.observer || '?';
            results.push(`[conclusion:${type} ${peer}${conf}] ${text}`);
          }
        }
        if (results.length === 0) results.push('No results found in messages or conclusions.');
        if (sourceErrors.length > 0) {
          results.push(`[honcho-sync: ${sourceErrors.join(' | ')}]`);
        }
        return { ok: true, tool: 'honcho_recall', results, count: results.length };
      },
    };
  }

  function defineHonchoAsk() {
    return {
      name: 'honcho_ask',
      description: 'Ask Honcho a question using dialectic reasoning. Takes 2-5 min. Use for deep questions: "what did we discuss about X".',
      parameters: {
        query: { type: 'string', required: true, description: 'The question to ask the memory system.' },
        peer: { type: 'string', description: `Which peer to query. Default: ${cfg().userPeer}.` },
      },
      async execute(args, exec) {
        const targetPeer = args.peer || cfg().userPeer;
        // P1 (2026-08-20): no date-window filter — sessions are long-lived per
        // directory, so the dialectic can reason over the full history.
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/peers/${targetPeer}/chat`,
          { query: args.query },
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
      description: 'Save a fact/decision/preference to Honcho memory. Use when user states something to persist across sessions.',
      parameters: {
        content: { type: 'string', required: true, description: 'The fact or information to remember.' },
        peer_id: { type: 'string', description: 'Who said it (defaults to user peer).' },
      },
      async execute(args, exec) {
        const peer = args.peer_id || cfg().userPeer;
        const cwd = exec?.agent?.session?.header?.cwd || '';
        const sessionId = honchoSessionId(cwd);
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/sessions/${sessionId}/messages`,
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
      description: 'Get full conversation context for a session. Use to read recent history from Honcho.',
      parameters: {
        session_id: { type: 'string', description: 'Session ID (omit for auto-detect from current cwd).' },
        tokens: { type: 'integer', description: 'Token budget for the summary (default: 500).' },
      },
      async execute(args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd || '';
        const sessionId = args.session_id || honchoSessionId(cwd);
        const tokens = args.tokens || 500;
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg().workspace}/sessions/${sessionId}/context?summary=true&tokens=${tokens}`
        );
        if (!result) return { ok: true, tool: 'honcho_context', text: 'Error retrieving context.' };
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { ok: true, tool: 'honcho_context', text: text.slice(0, 10000) || 'No context available.' };
      },
    };
  }

  // ─── Search tools ──────────────────────────────────────────────────────

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
          `/v3/workspaces/${cfg().workspace}/search`,
          { query: args.query, limit: args.limit || 10, max_tokens: args.max_tokens || 2000 }
        );
        if (!result) return { ok: true, tool: 'honcho_search', results: ['Error contacting Honcho server.'], count: 0 };
        const arr = Array.isArray(result) ? result : (result.results || []);
        const results = arr.map(r =>
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
          `/v3/workspaces/${cfg().workspace}/sessions/${args.session_id}/search`,
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

  // ─── Profile tools ─────────────────────────────────────────────────────

  function defineHonchoProfile() {
    return {
      name: 'honcho_profile',
      description: 'Get the peer card (profile) for a peer. Contains identity, attributes, relationships, and instructions observed by Honcho.',
      parameters: {
        peer_id: { type: 'string', required: true, description: 'The peer ID (e.g. "user" or "agent").' },
      },
      async execute(args) {
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg().workspace}/peers/${args.peer_id}/card`
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
          `/v3/workspaces/${cfg().workspace}/peers/${args.peer_id}/representation`,
          {},
          15000
        );
        if (!result) return { ok: true, tool: 'honcho_representation', text: 'Error contacting Honcho server.' };
        const text = typeof result === 'string' ? result : (result.representation || JSON.stringify(result));
        return { ok: true, tool: 'honcho_representation', text: text.slice(0, 10000) };
      },
    };
  }

  // ─── Session tools ─────────────────────────────────────────────────────

  function defineHonchoSession() {
    return {
      name: 'honcho_session',
      description: 'List Honcho sessions in the workspace. Returns session IDs, message counts, and metadata.',
      parameters: {
        limit: { type: 'integer', description: 'Max sessions to return (default: 20).' },
      },
      async execute(args) {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/sessions/list`,
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
          `/v3/workspaces/${cfg().workspace}/sessions`,
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
          `/v3/workspaces/${cfg().workspace}/sessions/${args.session_id}/clone`,
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
            `/v3/workspaces/${cfg().workspace}/sessions/${args.session_id}/peers`
          );
          if (!result) return { ok: true, tool: 'honcho_session_peers', peers: [] };
          const peers = Array.isArray(result) ? result : (result.items || []);
          return { ok: true, tool: 'honcho_session_peers', peers };
        } else if (action === 'add') {
          if (!args.peer_id) return { ok: false, tool: 'honcho_session_peers', text: 'peer_id required for add.' };
          const result = await honchoRequest('POST',
            `/v3/workspaces/${cfg().workspace}/sessions/${args.session_id}/peers`,
            { peer_id: args.peer_id }
          );
          return { ok: !!result, tool: 'honcho_session_peers', text: `Added ${args.peer_id} to session.` };
        } else if (action === 'remove') {
          if (!args.peer_id) return { ok: false, tool: 'honcho_session_peers', text: 'peer_id required for remove.' };
          const result = await honchoRequest('DELETE',
            `/v3/workspaces/${cfg().workspace}/sessions/${args.session_id}/peers`,
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
          `/v3/workspaces/${cfg().workspace}/sessions/${args.session_id}/summaries`
        );
        if (!result) return { ok: true, tool: 'honcho_session_summaries', summaries: [] };
        // API returns a session object with short_summary, or an array of summaries
        if (Array.isArray(result)) {
          return { ok: true, tool: 'honcho_session_summaries', summaries: result };
        }
        const summaries = [];
        if (result.short_summary) summaries.push(result.short_summary);
        if (result.long_summary) summaries.push(result.long_summary);
        if (result.summaries) summaries.push(...(Array.isArray(result.summaries) ? result.summaries : [result.summaries]));
        return { ok: true, tool: 'honcho_session_summaries', summaries };
      },
    };
  }

  function defineHonchoSessionContext() {
    return {
      name: 'honcho_session_context',
      description: 'Get full conversation context for a session. Use to read recent history from Honcho.',
      parameters: {
        session_id: { type: 'string', description: 'Session ID (omit for current cwd-based session).' },
        tokens: { type: 'integer', description: 'Token budget for the summary (default: 500).' },
      },
      async execute(args) {
        const sid = args.session_id || honchoSessionId('');
        const tokens = args.tokens || 500;
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg().workspace}/sessions/${sid}/context?summary=true&tokens=${tokens}`
        );
        if (!result) return { ok: true, tool: 'honcho_session_context', text: 'Error retrieving context.' };
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { ok: true, tool: 'honcho_session_context', text: text.slice(0, 10000) || 'No context available.' };
      },
    };
  }

  // ─── Peer tools ────────────────────────────────────────────────────────

  function defineHonchoPeer() {
    return {
      name: 'honcho_peer',
      description: 'List all peers in the Honcho workspace.',
      parameters: {},
      async execute() {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/peers/list`,
          {}
        );
        if (!result) return { ok: true, tool: 'honcho_peer', peers: [] };
        const peers = Array.isArray(result) ? result : (result.items || result.peers || []);
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
          `/v3/workspaces/${cfg().workspace}/peers`,
          body
        );
        if (!result) return { ok: false, tool: 'honcho_peer_create', text: 'Error creating peer.' };
        return { ok: true, tool: 'honcho_peer_create', text: `Peer ${args.peer_id} ready.`, peer: result };
      },
    };
  }

  function defineHonchoPeerList() {
    return {
      name: 'honcho_peer_list',
      description: 'List all peers in the Honcho workspace.',
      parameters: {},
      async execute() {
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/peers/list`,
          {}
        );
        if (!result) return { ok: true, tool: 'honcho_peer_list', peers: [] };
        const peers = Array.isArray(result) ? result : (result.items || result.peers || []);
        return { ok: true, tool: 'honcho_peer_list', peers };
      },
    };
  }

  // ─── Message tools (local plugin unique) ───────────────────────────────

  function defineHonchoMessageSend() {
    return {
      name: 'honcho_message_send',
      description: 'Send a message to a Honcho session. Useful for saving facts or adding context to memory.',
      parameters: {
        session_id: { type: 'string', description: 'Session ID (omit for current cwd-based session).' },
        content: { type: 'string', required: true, description: 'The message content.' },
        role: { type: 'string', enum: ['user', 'assistant'], description: 'Message role (default: user).' },
        peer_id: { type: 'string', description: 'Peer ID (default: user for user role, agent for assistant role).' },
      },
      async execute(args) {
        const sid = args.session_id || honchoSessionId('');
        const cfg = getConfig(config, resolvedSettings);
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/sessions/${sid}/messages`,
          {
            messages: [{
              role: args.role || 'user',
              content: args.content,
              peer_id: args.peer_id || (args.role === 'assistant' ? cfg().agentPeer : cfg().userPeer),
            }],
          }
        );
        if (!result) return { ok: false, tool: 'honcho_message_send', text: 'Error sending message.' };
        return { ok: true, tool: 'honcho_message_send', text: 'Message sent.' };
      },
    };
  }

  function defineHonchoMessageGet() {
    return {
      name: 'honcho_message_get',
      description: 'Get a single message from a Honcho session by message ID.',
      parameters: {
        session_id: { type: 'string', required: true, description: 'The session ID.' },
        message_id: { type: 'string', required: true, description: 'The message ID.' },
      },
      async execute(args) {
        const result = await honchoRequest('GET',
          `/v3/workspaces/${cfg().workspace}/sessions/${args.session_id}/messages/${args.message_id}`
        );
        if (!result) return { ok: true, tool: 'honcho_message_get', message: null };
        return { ok: true, tool: 'honcho_message_get', message: result };
      },
    };
  }

  // ─── Conclude tools ────────────────────────────────────────────────────

  function defineHonchoConclude() {
    return {
      name: 'honcho_conclude',
      description: 'Create a conclusion (explicit fact) in Honcho. Conclusions are high-confidence statements that persist across sessions.',
      parameters: {
        content: { type: 'string', required: true, description: 'The conclusion text.' },
        peer_id: { type: 'string', description: 'Which peer this conclusion is about (default: user peer).' },
      },
      async execute(args) {
        const peer = args.peer_id || cfg().userPeer;
        // API expects { conclusions: [{ content, peer_id, observer_id }] }
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/conclusions`,
          { conclusions: [{ content: args.content, peer_id: peer, observer_id: cfg().agentPeer, observed_id: peer }] }
        );
        if (!result) return { ok: false, tool: 'honcho_conclude', text: 'Error creating conclusion.' };
        const id = Array.isArray(result) ? result[0]?.id : (result.items?.[0]?.id || result.id);
        return { ok: true, tool: 'honcho_conclude', text: 'Conclusion saved.', id };
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
          `/v3/workspaces/${cfg().workspace}/conclusions/list`,
          body
        );
        if (!result) return { ok: true, tool: 'honcho_conclude_list', conclusions: [] };
        const conclusions = Array.isArray(result) ? result : (result.items || result.conclusions || []);
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
          `/v3/workspaces/${cfg().workspace}/conclusions/query`,
          { query: args.query, limit: args.limit || 10, filters: { observer: cfg().agentPeer, observed: cfg().userPeer } }
        );
        if (!result) return { ok: true, tool: 'honcho_conclude_query', conclusions: [] };
        const conclusions = Array.isArray(result) ? result : (result.items || result.conclusions || []);
        return { ok: true, tool: 'honcho_conclude_query', conclusions };
      },
    };
  }

  // ─── Admin tools ───────────────────────────────────────────────────────

  function defineHonchoStatus() {
    return {
      name: 'honcho_status',
      description: 'Check Honcho memory server health and statistics.',
      parameters: {},
      async execute() {
        const health = await honchoRequest('GET', '/health');
        const queue = await honchoRequest('GET',
          `/v3/workspaces/${cfg().workspace}/queue/status`
        );
        return {
          ok: true,
          tool: 'honcho_status',
          text: `Honcho: ${health?.status || 'unknown'} | Workspace: ${cfg().workspace || 'not set'} | URL: ${cfg().honchoUrl} | Queue: ${queue ? (queue.pending ?? '?') + ' pending' : 'n/a'}`,
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
        const observer = args.observer || cfg().agentPeer;
        const observed = args.observed || cfg().userPeer;
        const result = await honchoRequest('POST',
          `/v3/workspaces/${cfg().workspace}/schedule_dream`,
          { dream_type: args.dream_type || 'card_refresh', observer, observed }
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
          `/v3/workspaces/${cfg().workspace}/queue/status`
        );
        if (!result) return { ok: true, tool: 'honcho_queue', text: 'Error fetching queue status.' };
        return { ok: true, tool: 'honcho_queue', text: JSON.stringify(result, null, 2).slice(0, 3000) };
      },
    };
  }

  // ─── Register core tools (P2: reduced from 25 to 4 for context efficiency) ───
  // The full Honcho API surface remains available via direct HTTP calls
  // (see README "Advanced usage") or a companion shell script.

  const tools = [
    defineHonchoRecall(),   // semantic search (messages + conclusions)
    defineHonchoAsk(),      // deep dialectic reasoning
    defineHonchoRemember(), // save fact/decision
    defineHonchoContext(),  // session summary + recall
  ];

  // ─── DSH 0.1.0-rc.8 compatibility: JSON Schema + render ──────────────────

  function normalizeToolParameters(parameters) {
    // Already a JSON Schema object.
    if (
      parameters &&
      typeof parameters === 'object' &&
      parameters.type === 'object' &&
      parameters.properties &&
      typeof parameters.properties === 'object'
    ) {
      return parameters;
    }

    // Empty parameter list.
    if (
      !parameters ||
      typeof parameters !== 'object' ||
      Array.isArray(parameters) ||
      Object.keys(parameters).length === 0
    ) {
      return {
        type: 'object',
        properties: {},
        additionalProperties: false,
      };
    }

    const properties = {};
    const required = [];

    for (const [key, spec] of Object.entries(parameters)) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        properties[key] = {};
        continue;
      }

      // Copy the old parameter specification.
      const prop = { ...spec };

      // `required` belongs to the parent JSON Schema, not the property.
      if (prop.required === true) {
        required.push(key);
        delete prop.required;
      }

      properties[key] = prop;
    }

    const schema = {
      type: 'object',
      properties,
      additionalProperties: false,
    };

    if (required.length > 0) {
      schema.required = required;
    }

    return schema;
  }

  for (const tool of tools) {
    // Convert legacy parameter shorthand to standard JSON Schema.
    tool.parameters = normalizeToolParameters(tool.parameters);

    // DSH >= 2026 requires every tool to declare output { schema, render }.
    // Honcho plugin tools return { ok, tool, text, ... } objects.
    // render MUST return an ARRAY of content blocks: [{ type: 'text', text: '...' }].
    // If value has a 'text' field, show that; otherwise JSON-serialize the whole object.
    if (!tool.output) {
      tool.output = {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        render: (_args, value) => {
          let text;
          if (typeof value === 'string') text = value;
          else if (value && typeof value === 'object') {
            if (typeof value.text === 'string') text = value.text;
            else { try { text = JSON.stringify(value, null, 2); } catch { text = String(value); } }
          }
          else text = String(value);
          return [{ type: 'text', text }];
        },
      };
    }

    // HONCHO-SYNC TOOL-REG FIX (2026-08-22): register directly via the injected
    // `tools` service (inject: ['tools']) — the old ctx.effect + ctx.get('tools')
    // guard silently skipped registration when the tools service resolved after
    // the plugin's effect (tools vanished after a reload/recomposition).
    // ctx.effect wraps the returned disposer so an unload/reload unregisters the
    // tool cleanly instead of leaking a stale registration.
    ctx.effect(() => ctx.tools.register(tool), 'honcho-sync: ' + tool.name);
  }

  // ─── Context injection on session start (Layer 1) ──────────────────────

  // P1 (2026-08-20): semantic-aware memory injection.
  // Old: summary + tokens only (2 of 11 context() params).
  // New: adds search_query (current user message) so the injected context is
  // semantically relevant to what the user is actually asking — the "brain
  // associative recall" step. Cards + representations still injected as the
  // stable declarative/procedural layer.
  /** Shorten text to a budget without cutting a line in half. */
  function _clampLines(text, max) {
    if (!text || text.length <= max) return text;
    const cut = text.slice(0, Math.max(0, max));
    const newline = cut.lastIndexOf('\n');
    const kept = newline > max * 0.5 ? cut.slice(0, newline) : cut;
    return `${kept.trimEnd()}\n…[gekürzt]`;
  }

  /**
   * Build the peer-context path for one peer.
   *
   * HONCHO-SYNC API-FIX (2026-11-22): `GET /peers/{peer}/context` returns the
   * peer card and a representation in one response, and `max_conclusions`
   * bounds that representation server-side even without a search query
   * (measured against v3.0.11: 17.268 -> 1.319 chars).
   * @param peer - peer id to read.
   * @param c - effective configuration.
   * @param query - current user message; empty skips semantic curation.
   * @returns the request path, relative to honchoUrl.
   */
  function _peerContextPath(peer, c, query) {
    const params = new URLSearchParams();
    const cap = peer === c.agentPeer ? c.maxConclusionsAgent : c.maxConclusionsUser;
    params.set('max_conclusions', String(cap));
    if (c.includeMostFrequent) params.set('include_most_frequent', 'true');
    if (query) {
      params.set('search_query', query.slice(0, 300));
      params.set('search_top_k', String(c.searchTopK));
      params.set('search_max_distance', String(c.searchMaxDistance));
    }
    return `/v3/workspaces/${c.workspace}/peers/${peer}/context?${params.toString()}`;
  }

  /**
   * Fetch the memory block injected at session start.
   * @param honchoSid - Honcho session name for this working directory.
   * @param searchQuery - the user's current message, used to curate the representation.
   * @returns the `<memory-context>` payload, or null when nothing could be fetched.
   */
  async function buildMemoryContext(honchoSid, searchQuery) {
    const c = cfg();
    const query = (searchQuery || '').trim();
    const parts = {};
    const failures = [];

    // HONCHO-SYNC API-FIX (2026-11-22): one peer/context call per peer replaces
    // the former /card + /representation pair, and the summary comes from the
    // dedicated endpoint — /context only returns one above an undocumented
    // token threshold (measured: null at tokens=500 and 2000, present at 3000),
    // and it never returned the `search_results` field this code used to read.
    const [userResult, agentResult, summaryResult] = await Promise.allSettled([
      honchoRequest('GET', _peerContextPath(c.userPeer, c, query), undefined, c.reprTimeoutMs),
      honchoRequest('GET', _peerContextPath(c.agentPeer, c, query), undefined, c.reprTimeoutMs),
      honchoRequest('GET', `/v3/workspaces/${c.workspace}/sessions/${honchoSid}/summaries`, undefined, c.summaryTimeoutMs),
    ]);

    const peerParts = [];
    for (const [peer, result] of [[c.userPeer, userResult], [c.agentPeer, agentResult]]) {
      if (result.status !== 'fulfilled') {
        failures.push(`peer-context:${peer}: ${result.reason?.message ?? result.reason}`);
        continue;
      }
      const data = result.value ?? {};
      const card = Array.isArray(data.peer_card)
        ? data.peer_card.filter((fact) => typeof fact === 'string' && fact.trim().length > 0)
        : [];
      const representation = _filterRepresentation(
        _trimRepresentation(data.representation || '', c.reprMaxObs, card),
      );
      const chunks = [];
      if (card.length > 0) chunks.push(card.join('\n'));
      if (representation) chunks.push(representation);
      if (chunks.length > 0) peerParts.push(`[Peer: ${peer}]\n${chunks.join('\n\n')}`);
    }
    if (peerParts.length > 0) parts['peer-context'] = peerParts.join('\n\n');

    if (summaryResult.status === 'fulfilled') {
      const summaries = summaryResult.value ?? {};
      // Short first: the long summary is ~15k chars and would crowd out recall.
      const summaryText = String(summaries.short_summary?.content || summaries.long_summary?.content || '').trim();
      if (summaryText) parts['session-summary'] = `[Session Summary]\n${_clampLines(summaryText, c.summaryMaxChars)}`;
    } else {
      failures.push(`summaries: ${summaryResult.reason?.message ?? summaryResult.reason}`);
    }

    if (Object.keys(parts).length === 0) {
      _honchoLog('error', `memory injection for ${honchoSid} produced nothing: ${failures.join(' | ') || 'every endpoint returned empty data'}`);
      return null;
    }
    if (failures.length > 0) {
      _honchoLog('warn', `memory injection for ${honchoSid} is partial: ${failures.join(' | ')}`);
    }
    // Errors stay in the log; the injected text carries memory only.
    return `<memory-context>\n${_assembleWithReserves(parts, c.injectionMaxChars || DEFAULTS.injectionMaxChars)}\n</memory-context>`;
  }

  if (cfg().autoRecall && systemPrompt !== undefined) {
    ctx.on('session/event', async (session, event) => {
      if (!session || !event) return;
      if (event.type !== 'user/message') return;
      const sessionId = session.id;
      if (!sessionId) return;

      // HONCHO-SYNC INJECT-RETRY-FIX (2026-11-22): the old code marked the
      // session as injected *before* awaiting, so a single failed fetch disabled
      // memory for the rest of that session. The marker is now set only after a
      // successful injection, and a failing session is retried a bounded number
      // of times instead of silently giving up.
      //
      // HONCHO-SYNC INJECT-RACE-FIX (2026-11-22): moving that marker after the
      // await opened a race — two events of the same session (a second turn, or a
      // second agent on the same session) both passed the guard and both called
      // systemPrompt.context(), which allows one registration per name and threw
      // `prompt context "honcho:memory" is already registered`. An in-flight flag
      // now admits exactly one attempt at a time.
      const entry = state.get(sessionId) || {};
      if (entry.injected || entry.inflight) return;
      if ((entry.attempts || 0) >= cfg().injectionRetries) return;
      state.set(sessionId, { ...entry, inflight: true });

      try {
        const snapshot = await sessionQuery.readSession(sessionId);
        const header = snapshot.session;
        if (!header) {
          state.set(sessionId, { ...entry, inflight: false });
          return;
        }
        const cwd = header.cwd || '';
        const honchoSid = honchoSessionId(cwd);

        // Use the user's current message as the semantic query so the injected
        // recall is associative rather than pure recency.
        const userMsgText = extractText(event?.data?.content) || '';
        const text = await buildMemoryContext(honchoSid, userMsgText);
        if (text === null) {
          const attempts = (entry.attempts || 0) + 1;
          state.set(sessionId, { ...entry, inflight: false, attempts });
          _honchoLog('warn', `memory injection for ${honchoSid} failed (attempt ${attempts}/${cfg().injectionRetries}); retrying on the next turn`);
          return;
        }

        // Release our own previous registration before adding the new text; the
        // service keeps at most one entry per name in this scope.
        const previous = state.get(sessionId)?.injectDispose;
        if (typeof previous === 'function') {
          try { previous(); } catch (e) {
            _honchoLog('warn', `could not dispose the previous memory context for ${honchoSid}: ${e?.message ?? e}`);
          }
        }
        let dispose;
        try {
          dispose = systemPrompt.context({
            name: 'honcho:memory',
            order: 120,
            text,
          });
        } catch (e) {
          // Someone else already owns the name in this scope: the memory is
          // present either way, so this is a success, not a retryable failure.
          if (String(e?.message ?? e).includes('already registered')) {
            state.set(sessionId, { ...entry, inflight: false, injected: true });
            _honchoLog('info', `memory context for ${honchoSid} is already registered; keeping the existing entry`);
            return;
          }
          throw e;
        }

        // Re-check: if the session died while we were fetching, drop it.
        const sessionsService = ctx.get('sessions');
        const stillThere = sessionsService ? sessionsService.get(sessionId) : undefined;
        if (stillThere === undefined) {
          dispose();
          state.set(sessionId, { ...entry, inflight: false });
          return;
        }

        state.set(sessionId, { ...entry, inflight: false, injected: true, injectDispose: dispose });
        _honchoLog('info', `injected memory context for ${honchoSid} (${text.length} chars)`);
      } catch (e) {
        const attempts = (entry.attempts || 0) + 1;
        state.set(sessionId, { ...entry, inflight: false, attempts });
        _honchoLog('error', `memory injection failed for session ${sessionId} (attempt ${attempts}/${cfg().injectionRetries}): ${e?.message ?? e}`);
      }
    });
  }

  // ─── Auto-sync with persistence ────────────────────────────────────────

  async function postToHoncho(sessionId, messages) {
    const url = `${cfg().honchoUrl}/v3/workspaces/${cfg().workspace}/sessions/${sessionId}/messages`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    if (!resp.ok && resp.status !== 201) {
      const text = await resp.text().catch(() => '');
      // A rejected upload must not look like a sync: the caller keeps the cursor
      // unchanged so the batch is retried instead of silently dropped.
      throw new Error(`Honcho POST ${url} -> ${resp.status} ${resp.statusText} ${text.slice(0, 200)}`.trim());
    }
  }

  async function syncSession(sessionId) {
    if (!sessionQuery) return;
    const snapshot = await sessionQuery.readSession(sessionId);
    const header = snapshot.session;
    const events = snapshot.events || [];

    if (!header || events.length === 0) return;

    const cwd = header.cwd || '';
    const honchoSid = honchoSessionId(cwd);

    // Get sync state from persistent file (survives restart)
    const persisted = loadState();
    const s = persisted[honchoSid] || { lastSyncedEventCount: 0 };
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
          messages.push({ role: 'user', content: text.slice(0, cfg().messageMaxChars), peer_id: cfg().userPeer });
        }
      } else if (ev.type === 'assistant/message') {
        const msg = ev.data.message || ev.data;
        const text = extractText(msg.content);
        if (text) {
          messages.push({ role: 'assistant', content: text.slice(0, cfg().messageMaxChars), peer_id: cfg().agentPeer });
        }
      }
    }

    if (messages.length === 0) {
      persisted[honchoSid] = { ...s, lastSyncedEventCount: events.length };
      saveState(persisted);
      return;
    }

    await postToHoncho(honchoSid, messages);
    _honchoLog('info', `synced ${messages.length} messages to ${honchoSid}`);
    persisted[honchoSid] = { ...s, lastSyncedEventCount: events.length };
    saveState(persisted);
  }

  function scheduleSync(sessionId) {
    const s = state.get(sessionId) || { timer: null, lastAssistant: '' };
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      // A detached timer must not raise an unhandled rejection: report instead.
      syncSession(sessionId).catch((e) => _honchoLog('error', `sync failed for session ${sessionId}: ${e?.message ?? e}`));
    }, cfg().debounceMs);
    state.set(sessionId, s);
  }

  if (cfg().autoSync) {
    ctx.on('session/event', (session, event) => {
      if (!session || !event) return;
      if (event.type !== 'assistant/message' && event.type !== 'user/message') return;
      const sessionId = session.id;
      if (!sessionId) return;
      scheduleSync(sessionId);
    });
  }

  // ─── Preflight ─────────────────────────────────────────────────────────

  /**
   * HONCHO-SYNC PREFLIGHT (2026-11-22): prove the endpoint is reachable before
   * the first prompt needs it. A wrong host, a stopped container, or an
   * unreachable Tailscale name used to surface as a warning on stdout at the
   * first user message. apply() now rejects, the fiber is marked FAILED, DSH
   * logs it and keeps running — and the reason names the exact URL.
   * @throws when the health probe fails while `preflight` is enabled.
   */
  async function _preflight() {
    const c = cfg();
    if (!c.preflight) return;
    const url = `${c.honchoUrl}/health`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), c.preflightTimeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const body = await resp.json().catch(() => null);
      if (body?.status !== 'ok') throw new Error(`unexpected body ${JSON.stringify(body).slice(0, 120)}`);
      _honchoLog('info', `preflight ok: ${c.honchoUrl} workspace=${c.workspace} peers=${c.userPeer}/${c.agentPeer}`);
    } catch (e) {
      const reason = e?.name === 'AbortError' ? `timeout after ${c.preflightTimeoutMs}ms` : (e?.message ?? String(e));
      throw new Error(
        `honcho-sync: preflight failed for ${c.honchoUrl} (${reason}). `
        + 'Fix honchoUrl or the Honcho server, or set preflight: false in the profile patch to start without memory.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  await _preflight();

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
}

export { name, inject, apply, Config };
