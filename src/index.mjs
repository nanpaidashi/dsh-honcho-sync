/**
 * honcho-sync — Auto-sync DSH turns to Honcho
 *
 * Listens for session/event (global scope, receives all sessions) and
 * syncs completed turns to the Honcho API.
 *
 * Runs in the full Node.js environment (not the Cordis dynamic sandbox),
 * so fetch, timers, and all Node globals are available.
 *
 * @module @spenpa/dsh-honcho-sync
 */

const name = 'honcho-sync';
const inject = [];

/** Resolve config: cordis loader passes config as second arg to apply. */
function getConfig(config) {
  return {
    honchoUrl: (config?.honchoUrl || process.env.HONCHO_URL || 'http://192.168.0.4:8000').replace(/\/$/, ''),
    workspace: config?.workspace || process.env.HONCHO_WORKSPACE || 'hermes',
    debounceMs: config?.debounceMs ?? 3000,
  };
}

function apply(ctx, config) {
  const sessionQuery = ctx.get('sessionQuery');
  if (sessionQuery === undefined) return;

  const cfg = getConfig(config);
  const state = new Map();

  function extractText(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text)
      .join('');
  }

  function honchoSessionId(cwd) {
    if (!cwd) return 'dsh-unknown';
    return 'dsh-' + cwd.split('/').filter(Boolean).join('-').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

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

      // Deduplicate
      const s = state.get(honchoSid);
      if (s && s.lastAssistant === assistantContent) return;

      const messages = [];
      if (userContent) {
        messages.push({ role: 'user', content: userContent.slice(0, 25000), peer_id: 'shifu' });
      }
      if (assistantContent) {
        messages.push({ role: 'assistant', content: assistantContent.slice(0, 25000), peer_id: 'spenpa' });
      }

      if (messages.length === 0) return;

      await postToHoncho(honchoSid, messages);

      state.set(honchoSid, {
        timer: null,
        lastAssistant: assistantContent,
      });
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

  // Listen for session events (global scope: receives all sessions)
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
}

export { name, inject, apply };
