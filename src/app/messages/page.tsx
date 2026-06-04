'use client';

// Messages — bot DM log + manual-takeover UI.
//
// What it shows:
//   - Big top toggle for the bot's auto-replies / pushes. Soft amber banner
//     when paused. The leader pauses to answer threads by hand; manual sends
//     bypass the pause flag.
//   - Filter tabs (All / Outbound / Inbound) + intent pill row.
//   - The message list: one row per JSONL entry from /api/slack/messages.
//     Click expands the row inline with full text + metadata + (for inbound)
//     a manual-send composer so the leader can reply right there.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ArrowLeft, ArrowRight, Send, AlertTriangle, Check, X, MessagesSquare } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { Avatar } from '../../components/Avatar';

type LogDirection = 'out' | 'in';
type LogHandledAs = 'github-login' | 'feedback-capture' | 'silent' | 'paused';

interface LogRow {
  ts: string;
  direction: LogDirection;
  slack_user_id?: string;
  recipient_name?: string;
  channel?: string;
  text: string;
  ok?: boolean;
  intent?: string;
  route?: string;
  reason?: string;
  handled_as?: LogHandledAs;
  captured_at: string;
}

interface PauseState {
  paused: boolean;
  paused_at?: string;
  paused_by?: string;
}

type DirectionFilter = 'all' | 'out' | 'in';
type IntentBucket =
  | 'all'
  | 'archive-reminder'
  | 'github-login'
  | 'feedback'
  | 'anomaly'
  | 'manual'
  | 'silent';

const INTENT_TABS: Array<{ id: IntentBucket; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'archive-reminder', label: 'Archive reminder' },
  { id: 'github-login', label: 'GitHub login' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'anomaly', label: 'Anomaly' },
  { id: 'manual', label: 'Manual' },
  { id: 'silent', label: 'Silent' }
];

const INTENT_LABEL: Record<string, string> = {
  'archive-reminder': 'Archive',
  'feedback-ask': 'Feedback ask',
  'feedback-ack': 'Feedback ack',
  'github-login': 'GH login',
  'github-confirm': 'GH confirm',
  'anomaly-push': 'Anomaly',
  'identity-prompt': 'Identity',
  'manual-send': 'Manual',
  other: 'Other'
};

const HANDLED_LABEL: Record<LogHandledAs, string> = {
  'github-login': 'Parsed GH login',
  'feedback-capture': 'Captured feedback',
  silent: 'Silent (no action)',
  paused: 'Paused (no action)'
};

// Slack conversations.history returns emoji as :shortcode: in the text field
// (e.g. `:warning:` instead of `⚠️`). Map a small whitelist of the codes our
// own bot uses back to unicode so the messages page reads naturally. Anything
// not in the map is left as-is.
const SLACK_EMOJI_MAP: Record<string, string> = {
  ':warning:': '⚠️',
  ':red_circle:': '🔴',
  ':large_orange_circle:': '🟠',
  ':rotating_light:': '🚨',
  ':information_source:': 'ℹ️',
  ':white_check_mark:': '✅',
  ':heavy_check_mark:': '✔️',
  ':x:': '❌',
  ':rocket:': '🚀',
  ':pray:': '🙏',
  ':wave:': '👋',
  ':point_right:': '👉',
  ':bulb:': '💡',
  ':tada:': '🎉'
};
function renderSlackEmoji(s: string): string {
  return s.replace(/:[a-z0-9_+-]+:/gi, (m) => SLACK_EMOJI_MAP[m.toLowerCase()] ?? m);
}

function ageStr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (!Number.isFinite(min)) return '—';
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 60 / 24)}d`;
}

function beijingTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function rowKey(r: LogRow, idx: number): string {
  return `${r.captured_at}|${r.direction}|${r.slack_user_id ?? r.recipient_name ?? ''}|${idx}`;
}

function intentMatchesBucket(r: LogRow, bucket: IntentBucket): boolean {
  if (bucket === 'all') return true;
  if (bucket === 'silent') {
    if (r.direction === 'in') {
      return r.handled_as === 'silent' || r.handled_as === 'paused';
    }
    return false;
  }
  if (bucket === 'archive-reminder') return r.intent === 'archive-reminder';
  if (bucket === 'github-login') {
    return r.intent === 'github-login' || r.intent === 'github-confirm' || r.handled_as === 'github-login';
  }
  if (bucket === 'feedback') {
    return (
      r.intent === 'feedback-ask' ||
      r.intent === 'feedback-ack' ||
      r.handled_as === 'feedback-capture'
    );
  }
  if (bucket === 'anomaly') return r.intent === 'anomaly-push';
  if (bucket === 'manual') return r.intent === 'manual-send';
  return false;
}

export default function MessagesPage() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [pause, setPause] = useState<PauseState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [intentBucket, setIntentBucket] = useState<IntentBucket>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const toast = useToast();

  useEffect(() => {
    document.title = 'Messages · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [resMsg, resPause] = await Promise.all([
        fetch(`/api/slack/messages?limit=200&direction=${direction}`, { cache: 'no-store' }),
        fetch('/api/slack/pause', { cache: 'no-store' })
      ]);
      if (!resMsg.ok) throw new Error(`messages: HTTP ${resMsg.status}`);
      if (!resPause.ok) throw new Error(`pause: HTTP ${resPause.status}`);
      const msgJson = (await resMsg.json()) as { rows?: LogRow[] };
      const pauseJson = (await resPause.json()) as PauseState;
      setRows(msgJson.rows ?? []);
      setPause(pauseJson);
      setSyncedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [direction]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  const togglePause = useCallback(async () => {
    if (!pause || toggling) return;
    setToggling(true);
    try {
      const next = !pause.paused;
      const res = await fetch('/api/slack/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: next })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as PauseState;
      setPause(j);
      toast.push(next ? 'Bot paused · auto-reply off' : 'Bot resumed · auto-reply on', 'success');
    } catch (err) {
      toast.push(`Toggle failed: ${(err as Error).message}`, 'error');
    } finally {
      setToggling(false);
    }
  }, [pause, toggling, toast]);

  const visible = useMemo(() => {
    return rows.filter((r) => intentMatchesBucket(r, intentBucket));
  }, [rows, intentBucket]);

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-3">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Messages</div>
          <h1 className="display-title">Messages</h1>
          <p className="text-[13px] text-ink-quiet mt-2">
            Live log of Slack DMs the bot sends and receives. Pause auto-reply before taking over a thread manually.
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0 pb-1">
          {syncedAt !== null && (
            <span className="font-mono text-[11px] text-ink-quiet tabular-nums">
              synced {ageStr(new Date(syncedAt).toISOString())} ago
            </span>
          )}
          <button
            onClick={refresh}
            aria-label="Refresh"
            className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error}{' '}
          <button onClick={refresh} className="ml-3 link-coral">
            Retry
          </button>
        </div>
      )}

      {/* Pause toggle — the headline of the page. */}
      <section className="mt-6 mb-6 rounded-xl border border-rule bg-paper-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <MessagesSquare size={18} className="text-ink-soft" />
              <div className="font-serif text-[16px] font-medium text-ink">Bot auto-reply</div>
              {pause?.paused ? (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-mono bg-amber text-white">
                  PAUSED
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-mono bg-forest/15 text-forest">
                  ACTIVE
                </span>
              )}
            </div>
            <p className="text-[12.5px] text-ink-muted mt-1.5 leading-relaxed">
              {pause?.paused
                ? 'Paused — all auto-pushes (archive reminders / GH login asks / anomaly alerts) and auto-replies to inbound DMs are blocked. They\'re still logged. Manual sends (/api/slack/send or the composer below) are unaffected.'
                : 'Active — all auto DMs and inbound auto-replies are working normally.'}
            </p>
            {pause?.paused && pause.paused_at && (
              <p className="text-[11px] text-ink-quiet mt-1.5 font-mono tabular-nums">
                paused at {beijingTime(pause.paused_at)}
                {pause.paused_by && ` by ${pause.paused_by}`}
              </p>
            )}
          </div>
          <button
            onClick={togglePause}
            disabled={toggling || pause === null}
            className={
              pause?.paused
                ? 'shrink-0 px-4 py-2 rounded-md bg-forest text-white text-[13px] font-medium hover:bg-forest/90 disabled:opacity-50 transition-colors'
                : 'shrink-0 px-4 py-2 rounded-md bg-amber text-white text-[13px] font-medium hover:bg-amber/90 disabled:opacity-50 transition-colors'
            }
          >
            {pause === null ? '...' : pause.paused ? 'Resume Bot' : 'Pause Bot'}
          </button>
        </div>
      </section>

      {pause?.paused && (
        <div className="rounded-xl border border-amber/40 bg-amber/[0.07] px-4 py-3 mb-6 text-[12px] text-ink-soft flex items-start gap-2.5">
          <AlertTriangle size={14} className="text-amber shrink-0 mt-px" />
          <span className="leading-relaxed">
            Bot auto-reply is paused. Inbound messages still appear below — expand any inbound row to reply manually.
          </span>
        </div>
      )}

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex items-center rounded-md border border-rule bg-paper-card overflow-hidden">
          {(['all', 'out', 'in'] as DirectionFilter[]).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={
                direction === d
                  ? 'px-3 py-1.5 text-[12px] font-medium bg-coral text-white'
                  : 'px-3 py-1.5 text-[12px] text-ink-muted hover:bg-paper-subtle transition-colors'
              }
            >
              {d === 'all' ? 'All' : d === 'out' ? 'Outbound' : 'Inbound'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {INTENT_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setIntentBucket(tab.id)}
              className={
                intentBucket === tab.id
                  ? 'px-2.5 py-1 rounded text-[11.5px] font-medium bg-ink text-paper'
                  : 'px-2.5 py-1 rounded text-[11.5px] text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors'
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Message list */}
      {loading && rows.length === 0 && (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-rule bg-paper-subtle px-5 py-4 space-y-2">
              <div className="h-3 w-1/3 bg-paper-deep rounded animate-pulse" />
              <div className="h-3 w-2/3 bg-paper-deep rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div className="rounded-xl border border-rule bg-paper-card px-5 py-12 text-center text-[13px] text-ink-quiet">
          没有匹配的消息。如果消息日志文件还没创建,等 bot 发出第一条 DM 后就会出现。
        </div>
      )}

      <section className="space-y-2">
        {visible.map((r, idx) => {
          const k = rowKey(r, idx);
          const isExpanded = expanded === k;
          return (
            <MessageRow
              key={k}
              row={r}
              expanded={isExpanded}
              onToggle={() => setExpanded(isExpanded ? null : k)}
              onAfterSend={() => void refresh()}
            />
          );
        })}
      </section>
    </div>
  );
}

function MessageRow({
  row,
  expanded,
  onToggle,
  onAfterSend
}: {
  row: LogRow;
  expanded: boolean;
  onToggle: () => void;
  onAfterSend: () => void;
}) {
  const isOut = row.direction === 'out';
  const tone: 'rust' | 'amber' | 'neutral' =
    isOut && row.ok === false
      ? 'rust'
      : row.handled_as === 'paused'
        ? 'amber'
        : 'neutral';
  const frame =
    tone === 'rust'
      ? 'border-rust/45 bg-rust/[0.04]'
      : tone === 'amber'
        ? 'border-amber/45 bg-amber/[0.05]'
        : 'border-rule bg-paper-card';
  const bar = tone === 'rust' ? 'bg-rust' : tone === 'amber' ? 'bg-amber/70' : 'bg-ink-quiet';

  const resolvedName = row.recipient_name;
  const fallbackId = row.slack_user_id ?? '';
  // Unknown user: id present but no roster match → show short id + "(unknown)"
  // label, not a 11-char Slack id that crowds the layout.
  const isUnknown = !resolvedName && fallbackId.startsWith('U');
  const who = resolvedName ?? (isUnknown ? `${fallbackId.slice(0, 5)}…` : fallbackId || '—');
  const preview = renderSlackEmoji(row.text.replace(/\s+/g, ' ')).slice(0, 200);
  const intent = row.intent ?? (row.direction === 'in' ? row.handled_as ?? 'silent' : 'other');
  const intentLabel = INTENT_LABEL[intent] ?? intent;
  const okIcon =
    isOut && row.ok === false ? (
      <X size={13} className="text-rust" />
    ) : isOut && row.ok === true ? (
      <Check size={13} className="text-forest" />
    ) : null;

  return (
    <div className={`rounded-xl border ${frame}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left pl-3 pr-4 py-2.5 grid items-center gap-3"
        style={{
          gridTemplateColumns:
            // bar | dir | avatar | name (auto, capped) | intent pill (fixed) | preview (flex) | ok | age (fixed)
            '3px 14px 24px max-content 84px minmax(0,1fr) 14px 56px'
        }}
      >
        <span className={`w-[3px] self-stretch rounded-full ${bar}`} />
        {isOut ? (
          <ArrowRight size={14} className="text-ink-soft" />
        ) : (
          <ArrowLeft size={14} className="text-ink-quiet" />
        )}
        {resolvedName ? (
          <Avatar name={resolvedName} size="sm" />
        ) : (
          <span className="w-7 h-7 inline-flex items-center justify-center rounded-full border border-rule bg-paper-subtle text-ink-quiet text-[10px] font-mono">
            ??
          </span>
        )}
        <span
          className={
            'font-serif text-[13.5px] font-medium whitespace-nowrap ' +
            (isUnknown ? 'text-ink-quiet italic' : 'text-ink')
          }
          title={resolvedName ?? fallbackId}
        >
          {who}
        </span>
        <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full font-mono bg-paper-subtle text-ink-quiet text-center truncate">
          {intentLabel}
        </span>
        <span className="text-[12.5px] text-ink-muted truncate">{preview}</span>
        <span className="flex items-center justify-center">{okIcon}</span>
        <span className="font-mono text-[11px] text-ink-quiet text-right tabular-nums">
          {ageStr(row.ts)}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-rule px-4 py-3 space-y-3">
          <pre className="whitespace-pre-wrap font-sans text-[13px] text-ink leading-relaxed">
            {renderSlackEmoji(row.text)}
          </pre>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-ink-quiet font-mono">
            <Meta k="ts" v={beijingTime(row.ts)} />
            <Meta k="captured_at" v={beijingTime(row.captured_at)} />
            <Meta k="direction" v={row.direction} />
            {row.slack_user_id && <Meta k="slack_user_id" v={row.slack_user_id} />}
            {row.recipient_name && <Meta k="recipient" v={row.recipient_name} />}
            {row.channel && <Meta k="channel" v={row.channel} />}
            {row.intent && <Meta k="intent" v={row.intent} />}
            {row.route && <Meta k="route" v={row.route} />}
            {row.handled_as && <Meta k="handled_as" v={HANDLED_LABEL[row.handled_as]} />}
            {row.reason && <Meta k="reason" v={row.reason} />}
            {row.ok !== undefined && <Meta k="ok" v={String(row.ok)} />}
          </dl>
          {!isOut && row.slack_user_id && (
            <ManualComposer slackUserId={row.slack_user_id} onSent={onAfterSend} />
          )}
        </div>
      )}
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-ink-ghost">{k}</dt>
      <dd className="text-ink-soft truncate">{v}</dd>
    </>
  );
}

function ManualComposer({
  slackUserId,
  onSent
}: {
  slackUserId: string;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const toast = useToast();

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/slack/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slack_user_id: slackUserId, text: t })
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      toast.push('Sent ✓', 'success');
      setText('');
      onSent();
    } catch (err) {
      toast.push(`Send failed: ${(err as Error).message}`, 'error');
    } finally {
      setSending(false);
    }
  }, [text, sending, slackUserId, onSent, toast]);

  return (
    <div className="rounded-md border border-rule bg-paper-subtle p-2.5 space-y-2">
      <div className="text-[11px] uppercase tracking-wide font-mono text-ink-quiet">
        Manual reply · 绕过 pause flag
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`回复 ${slackUserId}…`}
        rows={3}
        className="w-full resize-y rounded-md border border-rule bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-quiet outline-none focus:border-coral transition-colors"
      />
      <div className="flex justify-end">
        <button
          onClick={send}
          disabled={!text.trim() || sending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-coral text-white text-[12.5px] font-medium hover:bg-coral/90 disabled:opacity-50 transition-colors"
        >
          <Send size={13} />
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
