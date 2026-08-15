/**
 * Browser half of dsh-honcho-sync: a settings section for the memory configuration.
 *
 * Pattern modeled after dsh-noema client UI — React component injected into
 * DSH settings.section slot, communicates via loopback route.
 *
 * Uses plain React.createElement (no JSX) — no TypeScript/JSX transformation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
const HONCHO_STATUS_ROUTE = '/_dsh/dsh-honcho-sync/status';

/** Client services required by this plugin. */
export const inject = ['slots', 'locale'];

/** Settings shape — mirrors the host schema. */
interface HonchoConfig {
  honchoUrl: string;
  workspace: string;
  userPeer: string;
  agentPeer: string;
  sessionStrategy: string;
  debounceMs: number;
  autoRecall: boolean;
  recallBudget: number;
  autoSync: boolean;
  messageMaxChars: number;
}

interface StatusPayload {
  ok: boolean;
  writable?: boolean;
  config?: HonchoConfig;
  error?: string;
}

// ─── Copy / labels (bilingual) ───

const COPY = {
  en: {
    title: 'Honcho Memory',
    intro: 'Long-term memory for DSH, backed by a self-hosted Honcho service. Configure connection, identity, and sync behavior below.',
    // Connection
    honchoUrl: 'Honcho URL',
    honchoUrlHint: 'Base URL of your Honcho server, e.g. http://<honcho-server-ip>:8000',
    workspace: 'Workspace',
    workspaceHint: 'Honcho workspace ID.',
    // Identity
    userPeer: 'User peer',
    userPeerHint: 'Your stable user identifier in Honcho.',
    aiPeer: 'AI peer',
    aiPeerHint: 'The AI-side peer name.',
    // Session
    sessionStrategy: 'Session strategy',
    sessionStrategyHint: 'How conversations map to Honcho sessions.',
    strategyPerSession: 'Per session',
    strategyPerDirectory: 'Per directory',
    strategyPerRepo: 'Per repo',
    strategyGlobal: 'Global',
    // Sync
    autoSync: 'Auto-sync',
    autoSyncHint: 'Automatically sync every conversation turn to Honcho.',
    debounceMs: 'Sync debounce (ms)',
    debounceMsHint: 'Delay after each turn before pushing to Honcho.',
    autoRecall: 'Auto-recall on session start',
    autoRecallHint: 'Fetch recent context from Honcho when a new session begins.',
    recallBudget: 'Recall token budget',
    recallBudgetHint: 'Default token limit for honcho_recall queries.',
    // Limits
    messageMaxChars: 'Message max chars',
    messageMaxCharsHint: 'Maximum characters per message sent to Honcho.',
    // UI
    status: 'Status',
    statusConnected: 'Connected',
    statusUnavailable: 'Unavailable',
    saved: 'Saved',
    notWritable: 'Settings are not writable in this session',
    loading: 'Loading settings\u2026',
    refresh: 'Refresh',
    note: 'Changes apply immediately. Honcho URL and workspace changes take effect after plugin reload.',
  },
  zh: {
    title: '红绸记忆',
    intro: '为 DSH 提供长期记忆，基于自托管的 Honcho 服务。在下面配置连接、身份和同步行为。',
    // Connection
    honchoUrl: 'Honcho 地址',
    honchoUrlHint: '你的 Honcho 服务器地址，例如 http://<honcho-server-ip>:8000',
    workspace: 'Workspace',
    workspaceHint: 'Honcho workspace ID。',
    // Identity
    userPeer: '用户标识',
    userPeerHint: '你在 Honcho 中的稳定用户标识。',
    aiPeer: 'AI 标识',
    aiPeerHint: 'AI 侧的 peer 名称。',
    // Session
    sessionStrategy: '会话策略',
    sessionStrategyHint: '对话如何映射到 Honcho 会话。',
    strategyPerSession: '每个会话',
    strategyPerDirectory: '每个目录',
    strategyPerRepo: '每个仓库',
    strategyGlobal: '全局',
    // Sync
    autoSync: '自动同步',
    autoSyncHint: '自动将每轮对话推送到 Honcho。',
    debounceMs: '同步延迟（毫秒）',
    debounceMsHint: '每轮对话后推送到 Honcho 的延迟时间。',
    autoRecall: '会话启动时自动 recall',
    autoRecallHint: '新会话开始时从 Honcho 加载近期上下文。',
    recallBudget: '召回 token 预算',
    recallBudgetHint: 'honcho_recall 查询的默认 token 上限。',
    // Limits
    messageMaxChars: '消息最大字符数',
    messageMaxCharsHint: '发送到 Honcho 的单条消息最大字符数。',
    // UI
    status: '状态',
    statusConnected: '已连接',
    statusUnavailable: '不可用',
    saved: '已保存',
    notWritable: '当前会话中设置不可写',
    loading: '正在加载设置\u2026',
    refresh: '刷新',
    note: '修改立即生效。Honcho 地址和 workspace 的修改在插件重载后生效。',
  },
};

// ─── Styles (DSH token-based, no hardcoded colors) ───

const styles = {
  section:     { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary)' },
  title:       { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
  intro:       { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary)' },
  note:        { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  row:         { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '12px 14px', background: 'var(--dsw-alias-bg-container)' },
  rowText:     { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 },
  rowLabel:    { fontSize: 14, fontWeight: 500, lineHeight: '22px' },
  rowHint:     { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  input:       { boxSizing: 'border-box', width: 220, flex: 'none', height: 32, padding: '4px 10px', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-input)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 },
  select:      { boxSizing: 'border-box', width: 220, flex: 'none', height: 32, padding: '4px 10px', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-input)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 },
  switch:      { flex: 'none', margin: 0, accentColor: 'var(--dsw-alias-button-primary-fill)' },
  statusCard:  { display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '12px 14px' },
  statusHead:  { display: 'flex', alignItems: 'center', gap: 8 },
  dot:         { boxSizing: 'border-box', width: 8, height: 8, borderRadius: '50%', flex: 'none' },
  statusLabel: { fontSize: 14, fontWeight: 500 },
  statusMeta:  { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
  actions:     { display: 'flex', gap: 8, marginTop: 4 },
  button:      { boxSizing: 'border-box', height: 28, padding: '0 12px', fontSize: 12, lineHeight: '18px', borderRadius: 14, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
  saved:       { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)', margin: 0 },
};

// ─── Field components ───

function TextRow({ copy, labelKey, hintKey, value, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);
  const commit = () => { if (draft !== String(value ?? '')) onCommit(draft); };
  return React.createElement('div', { style: styles.row },
    React.createElement('div', { style: styles.rowText },
      React.createElement('span', { style: styles.rowLabel }, copy[labelKey]),
      React.createElement('span', { style: styles.rowHint }, copy[hintKey]),
    ),
    React.createElement('input', {
      type: 'text', style: styles.input, value: draft, disabled,
      onChange: e => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: e => { if (e.key === 'Enter') commit(); },
    }),
  );
}

function NumberRow({ copy, labelKey, hintKey, value, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) { setDraft(String(value ?? '')); return; }
    if (n !== value) onCommit(n);
  };
  return React.createElement('div', { style: styles.row },
    React.createElement('div', { style: styles.rowText },
      React.createElement('span', { style: styles.rowLabel }, copy[labelKey]),
      React.createElement('span', { style: styles.rowHint }, copy[hintKey]),
    ),
    React.createElement('input', {
      type: 'number', style: styles.input, value: draft, disabled,
      onChange: e => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: e => { if (e.key === 'Enter') commit(); },
    }),
  );
}

function ToggleRow({ copy, labelKey, hintKey, checked, disabled, onChange }) {
  return React.createElement('div', { style: styles.row },
    React.createElement('div', { style: styles.rowText },
      React.createElement('span', { style: styles.rowLabel }, copy[labelKey]),
      React.createElement('span', { style: styles.rowHint }, copy[hintKey]),
    ),
    React.createElement('input', {
      type: 'checkbox', style: styles.switch, checked, disabled,
      onChange: e => onChange(e.target.checked),
    }),
  );
}

function SelectRow({ copy, labelKey, hintKey, value, options, disabled, onChange }) {
  return React.createElement('div', { style: styles.row },
    React.createElement('div', { style: styles.rowText },
      React.createElement('span', { style: styles.rowLabel }, copy[labelKey]),
      React.createElement('span', { style: styles.rowHint }, copy[hintKey]),
    ),
    React.createElement('select', {
      style: styles.select, disabled, value,
      onChange: e => onChange(e.target.value),
    },
      options.map(([k, label]) =>
        React.createElement('option', { key: k, value: k }, label)
      ),
    ),
  );
}

// ─── Main settings panel ───

export function HonchoMemorySettingsPanel({ ctx }) {
  const locale = useState(() => ctx.locale.getLocale().active)[0];
  // Re-render on locale change
  useEffect(() => {
    const unwatch = ctx.on('locale/change', () => {});
    return unwatch;
  }, []);
  const copy = COPY[locale === 'zh' ? 'zh' : 'en'];

  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(null);
  const [status, setStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const settings = status?.config;
  const writable = status?.writable === true;

  const showNotice = useCallback((text) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  }, []);

  const setField = useCallback(async (field, value) => {
    setBusy(true);
    try {
      const response = await fetch(HONCHO_STATUS_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'configure', field, value }),
      });
      const next = await response.json();
      if (!response.ok || !next.ok) throw new Error(next.error);
      setStatus(next);
      showNotice(copy.saved);
    } catch {
      showNotice(copy.notWritable);
    } finally {
      setBusy(false);
    }
  }, [showNotice, copy.saved, copy.notWritable]);

  const refreshStatus = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(HONCHO_STATUS_ROUTE, { cache: 'no-store' });
      setStatus(await response.json());
    } catch {
      setStatus(null);
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  if (!loaded && settings === undefined) {
    return React.createElement('section', { style: styles.section },
      React.createElement('p', { style: styles.intro }, copy.loading));
  }
  if (settings === undefined) {
    return React.createElement('section', { style: styles.section },
      React.createElement('p', { style: styles.intro }, copy.loading));
  }

  const sessionStrategies = [
    ['per-session', copy.strategyPerSession],
    ['per-directory', copy.strategyPerDirectory],
    ['per-repo', copy.strategyPerRepo],
    ['global', copy.strategyGlobal],
  ];

  return React.createElement('section', { style: styles.section },
    React.createElement('h2', { style: styles.title }, copy.title),
    React.createElement('p', { style: styles.intro }, copy.intro),

    // ── Connection ──
    React.createElement(TextRow, {
      copy, labelKey: 'honchoUrl', hintKey: 'honchoUrlHint',
      value: settings.honchoUrl ?? '', disabled: !writable || busy,
      onCommit: v => setField('honchoUrl', v),
    }),
    React.createElement(TextRow, {
      copy, labelKey: 'workspace', hintKey: 'workspaceHint',
      value: settings.workspace ?? '', disabled: !writable || busy,
      onCommit: v => setField('workspace', v),
    }),

    // ── Identity ──
    React.createElement(TextRow, {
      copy, labelKey: 'userPeer', hintKey: 'userPeerHint',
      value: settings.userPeer ?? 'user', disabled: !writable || busy,
      onCommit: v => setField('userPeer', v),
    }),
    React.createElement(TextRow, {
      copy, labelKey: 'aiPeer', hintKey: 'aiPeerHint',
      value: settings.agentPeer ?? 'agent', disabled: !writable || busy,
      onCommit: v => setField('agentPeer', v),
    }),

    // ── Session ──
    React.createElement(SelectRow, {
      copy, labelKey: 'sessionStrategy', hintKey: 'sessionStrategyHint',
      value: settings.sessionStrategy ?? 'per-directory', options: sessionStrategies,
      disabled: !writable || busy, onChange: v => setField('sessionStrategy', v),
    }),

    // ── Sync ──
    React.createElement(ToggleRow, {
      copy, labelKey: 'autoSync', hintKey: 'autoSyncHint',
      checked: settings.autoSync ?? true, disabled: !writable || busy,
      onChange: v => setField('autoSync', v),
    }),
    React.createElement(NumberRow, {
      copy, labelKey: 'debounceMs', hintKey: 'debounceMsHint',
      value: settings.debounceMs ?? 3000, disabled: !writable || busy,
      onCommit: v => setField('debounceMs', v),
    }),
    React.createElement(ToggleRow, {
      copy, labelKey: 'autoRecall', hintKey: 'autoRecallHint',
      checked: settings.autoRecall ?? true, disabled: !writable || busy,
      onChange: v => setField('autoRecall', v),
    }),
    React.createElement(NumberRow, {
      copy, labelKey: 'recallBudget', hintKey: 'recallBudgetHint',
      value: settings.recallBudget ?? 2000, disabled: !writable || busy,
      onCommit: v => setField('recallBudget', v),
    }),

    // ── Limits ──
    React.createElement(NumberRow, {
      copy, labelKey: 'messageMaxChars', hintKey: 'messageMaxCharsHint',
      value: settings.messageMaxChars ?? 25000, disabled: !writable || busy,
      onCommit: v => setField('messageMaxChars', v),
    }),

    React.createElement('p', { style: styles.note }, copy.note),

    // ── Status card ──
    React.createElement('div', { style: styles.statusCard },
      React.createElement('div', { style: styles.statusHead },
        React.createElement('div', {
          style: { ...styles.dot, background: settings && settings.honchoUrl ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' },
        }),
        React.createElement('span', { style: styles.statusLabel },
          copy.status + ': ' + (settings && settings.honchoUrl ? copy.statusConnected : copy.statusUnavailable),
        ),
      ),
      settings && settings.honchoUrl
        ? React.createElement('span', { style: styles.statusMeta }, settings.honchoUrl + (settings.workspace ? ' / ' + settings.workspace : ''))
        : null,
      React.createElement('div', { style: styles.actions },
        React.createElement('button', {
          type: 'button', style: styles.button, disabled: busy,
          onClick: () => void refreshStatus(),
        }, copy.refresh),
      ),
    ),

    notice ? React.createElement('p', { style: styles.saved }, notice) : null,
  );
}

/** Register the settings section slot. */
export function apply(ctx) {
  const Panel = () => React.createElement(HonchoMemorySettingsPanel, { ctx });
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'honcho-memory',
      order: 70,
      label: () => ctx.locale.getLocale().active === 'zh' ? '红绸记忆' : 'Honcho Memory',
    },
    Panel,
  ));
}
