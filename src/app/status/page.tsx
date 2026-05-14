'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronRight, Check, HelpCircle } from 'lucide-react';
import { CONTEXT_WARN, QUOTA_WARN, QUOTA_7D_WARN, PACE_RISK, PACE_MIN_PROGRESS, PACE_MIN_REMAINING, PACE_MIN_UTIL } from '@/lib/cc_thresholds';

// CC status dashboard — the attention-scarce leader view.
//
// What the leader sees here, and ONLY this:
//   1. Open anomalies (the only thing to act on) — red cards on top.
//   2. A team aggregate strip (cost + activity counts).
//   3. A lean roster: one line per agent — anomaly flag, last active, current repo.
//      Zero-anomaly agents fall to the bottom. Click a row → per-agent detail.
//
// NOT shown here (by design): token-per-person, tool counts, session counts,
// model, persona, MBTI, "new task" button, prompt style, hook health,
// version status. Those are drill-down (per-agent page) or routed elsewhere
// (infra → maintainer, coaching → 1:1).

type ActivityFlag = 'active' | 'idle' | 'dormant' | 'never';
type Severity = 'act-now' | 'next-glance' | 'fyi';

// Subset of the collector's live CCStatus snapshot the roster might surface.
interface CcLive {
  context_pct?: number;
  session_health?: string;
  five_hour_utilization?: number;
  seven_day_utilization?: number;
  five_hour_reset_at?: number;
  seven_day_reset_at?: number;
  cost_usd?: number;
  model?: string;
  stale_seconds?: number;
}

const WINDOW_MS_5H = 5 * 60 * 60 * 1000;
const WINDOW_MS_7D = 7 * 24 * 60 * 60 * 1000;

function quotaPace(
  util: number | undefined,
  resetAtSec: number | undefined,
  windowMs: number
): { progress: number; projection: number } | null {
  if (typeof util !== 'number' || typeof resetAtSec !== 'number') return null;
  const elapsed = windowMs - (resetAtSec * 1000 - Date.now());
  const progress = Math.max(0, Math.min(1, elapsed / windowMs));
  if (progress <= 0) return { progress: 0, projection: util };
  return { progress, projection: util / progress };
}

type WorkItemStatus = '进行中' | '卡住' | '调研中' | '已完成';
interface WorkItem {
  title: string;
  status: WorkItemStatus;
  repo: string;
}
interface RosterRow {
  name: string;
  resolved: boolean;
  anomalies: Array<{ id: string; rule: string; severity: Severity }>;
  lastSessionAt: string | null;
  activityFlag: ActivityFlag;
  currentRepo: string | null;
  workHint?: string;
  workItems?: WorkItem[];
  live?: CcLive;
}
const WORK_DOT: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber',
  进行中: 'bg-coral',
  调研中: 'bg-ink-quiet',
  已完成: 'bg-forest'
};

interface QuotaRisk {
  name: string;
  window: '5h' | '7d';
  util: number;
  progress: number;
  projection: number;
  resetAt?: number;
  kind: 'pace' | 'near' | 'both';
  critical: boolean;
}
interface QuotaSnapshot {
  maxUtil5h: number | null;
  maxUtil7d: number | null;
}
interface TeamAggregate {
  liveCostUsd?: number;
  active: number;
  idle: number;
  dormant: number;
  noData: number;
  openAnomalies: number;
  actNow: number;
  quotaRisk: QuotaRisk[];
  quotaSnapshot?: QuotaSnapshot;
  contextHot: string[];
  lastActivityAt: string | null;
}

// Friendly labels for anomaly rule ids (engine + live-derived). The leader sees
// these instead of `quota.near_5h` etc.
const RULE_LABEL: Record<string, string> = {
  'override.spike': 'Override spike',
  'blocked.review_pending': 'Blocked on review',
  'blocked.cc_attested': 'Self-reported blocked',
  'dispatch.uncertain': 'Dispatch unclear',
  'silence.dormant': 'Silent too long',
  'quota.near_5h': '5h quota near limit',
  'quota.near_7d': '7d quota near limit',
  'quota.pace_5h': '5h usage pace at risk',
  'quota.pace_7d': '7d usage pace at risk',
  'context.near_full': 'Context near full'
};
const DANGER_LABEL: Record<string, string> = {
  rm_rf_dangerous: 'rm -rf on a risky target',
  force_push_protected: 'force-push to main',
  prod_target: 'production touched',
  secret_echo: 'secret in command line',
  drop_table: 'DROP / DELETE statement'
};
function ruleLabel(rule: string): string {
  if (RULE_LABEL[rule]) return RULE_LABEL[rule];
  if (rule.startsWith('danger.command.')) return DANGER_LABEL[rule.slice('danger.command.'.length)] ?? 'Dangerous command';
  return rule;
}

// Concrete one-liner for an anomaly — pulls the actual numbers from the live
// snapshot when we have them, so the leader reads "7d quota 35% · projected
// 122%" instead of the vague "7d usage pace at risk".
function describeAnomaly(rule: string, live: CcLive | undefined): string {
  if (live) {
    if (rule === 'quota.pace_5h') {
      const u = live.five_hour_utilization;
      const p = quotaPace(u, live.five_hour_reset_at, WINDOW_MS_5H);
      if (typeof u === 'number' && p) return `5h quota ${Math.round(u * 100)}% · projected ${Math.round(p.projection * 100)}%`;
    }
    if (rule === 'quota.pace_7d') {
      const u = live.seven_day_utilization;
      const p = quotaPace(u, live.seven_day_reset_at, WINDOW_MS_7D);
      if (typeof u === 'number' && p) return `7d quota ${Math.round(u * 100)}% · projected ${Math.round(p.projection * 100)}%`;
    }
    if (rule === 'quota.near_5h' && typeof live.five_hour_utilization === 'number') {
      return `5h quota ${Math.round(live.five_hour_utilization * 100)}% · near limit`;
    }
    if (rule === 'quota.near_7d' && typeof live.seven_day_utilization === 'number') {
      return `7d quota ${Math.round(live.seven_day_utilization * 100)}% · near limit`;
    }
    if (rule === 'context.near_full' && typeof live.context_pct === 'number') {
      return `Context ${Math.round(live.context_pct * 100)}% · near full`;
    }
  }
  return ruleLabel(rule);
}

interface AnomalyLite {
  id: string;
  rule: string;
  subject: { kind: string; ref: string };
  severity_hint: Severity;
  triggered_at: string;
  suggested_actions: Array<{ id: string; label: string }>;
}

interface ApiResponse {
  roster: RosterRow[];
  aggregate: TeamAggregate;
  anomalies: AnomalyLite[];
}

const FLAG_DOT: Record<ActivityFlag, string> = {
  active: 'bg-forest',
  idle: 'bg-amber',
  dormant: 'bg-ink-quiet',
  never: 'bg-rule-strong'
};
const FLAG_LABEL: Record<ActivityFlag, string> = {
  active: 'Active',
  idle: 'Idle',
  dormant: 'Dormant',
  never: 'No data'
};
const SEV_PILL: Record<Severity, string> = {
  'act-now': 'bg-rust text-white',
  'next-glance': 'bg-amber text-white',
  fyi: 'bg-ink-quiet text-white'
};
const SEV_LABEL: Record<Severity, string> = {
  'act-now': 'Alert',
  'next-glance': 'Notice',
  fyi: 'FYI'
};

function ageStr(iso: string | null): string {
  if (!iso) return 'never';
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 60 / 24)}d ago`;
}
function syncedStr(ms: number | null): string {
  if (ms === null) return '';
  const min = (Date.now() - ms) / 60000;
  if (min < 1) return 'just synced';
  if (min < 60) return `synced ${Math.round(min)}m ago`;
  return `synced ${Math.round(min / 60)}h ago`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const ZH = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base' });

export default function StatusPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    document.title = 'Status · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/cc-status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setData((await res.json()) as ApiResponse);
      setSyncedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Leader hits 已处理 / 稍后 / 忽略 on a card. POSTs the action, refetches
  // the roster so the card disappears (suppressed). The log behind this
  // endpoint is also product feedback — what kinds of alerts get acted on.
  const onAnomalyAction = useCallback(
    async (a: AnomalyLite, action: 'resolve' | 'dismiss' | 'snooze', minutes?: number) => {
      await fetch('/api/anomalies/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: a.id,
          rule: a.rule,
          subjectRef: a.subject.ref,
          action,
          minutes
        })
      });
      await refresh();
    },
    [refresh]
  );

  // Keep the "X 分钟前同步" label honest between fetches.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const roster = data?.roster ?? [];
  const agg = data?.aggregate;
  const anomalies = data?.anomalies ?? [];

  // Lookup so the anomaly cards above can resolve concrete numbers (7d 35% ·
  // 按节奏预计 122%) from each subject's live snapshot.
  const liveByName = new Map(roster.map((r) => [r.name, r.live]));
  // Anomaly-having agents appear in cards above only — not duplicated as a
  // separate "要看的" roster group. The "有 Claude Code 数据" group lists every
  // with-data person, so a flagged person's work threads are still visible
  // here (without a redundant anomaly pill — that's what the card is for).
  const clean = roster.filter((r) => r.activityFlag !== 'never');
  const noData = roster
    .filter((r) => r.activityFlag === 'never')
    .slice()
    .sort((a, b) => ZH.compare(a.name, b.name));

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-3">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Status</div>
          <h1 className="display-title">Status</h1>
        </div>
        <div className="flex items-center gap-2.5 shrink-0 pb-0.5">
          {syncedAt !== null && <span className="text-[11px] text-ink-quiet tabular-nums">{syncedStr(syncedAt)}</span>}
          <button onClick={refresh} aria-label="Refresh" className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>
      <div className="mb-7" />

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error} <button onClick={refresh} className="ml-3 link-coral">Retry</button>
        </div>
      )}

      {/* 1 — Team aggregate. Sits at the top so the leader sees the team's
          working rhythm before drilling into anomalies. */}
      {agg && (
        <section className="mb-7">
          <div className="rounded-xl border border-rule bg-paper-card overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-3 pb-1">
              <div className="eyebrow">Team</div>
              <span
                title="Active = Claude Code session in the last 2 hours. Idle = no action for 2–24 hours but used today. Dormant = no action for more than 24 hours."
                className="inline-flex items-center text-ink-ghost hover:text-ink-quiet"
              >
                <HelpCircle size={12} strokeWidth={2} />
              </span>
            </div>
            <div className="grid grid-cols-3 divide-x divide-rule">
              <FlagStat dot="bg-forest" label="Active" value={agg.active} />
              <FlagStat dot="bg-amber" label="Idle" value={agg.idle} />
              <FlagStat dot="bg-ink-quiet" label="Dormant" value={agg.dormant} />
            </div>
          </div>
        </section>
      )}

      {/* 2 — Anomalies. The only thing to act on. Empty = good. */}
      {anomalies.length > 0 ? (
        <section className="mb-7 space-y-2">
          <div className="eyebrow text-rust mb-1">
            Needs your attention · {anomalies.length}
            {agg && agg.actNow > 0 && <span className="ml-2 text-ink-quiet">({agg.actNow} alert{agg.actNow === 1 ? '' : 's'})</span>}
          </div>
          {anomalies
            .slice()
            .sort((a, b) => {
              const r = { 'act-now': 0, 'next-glance': 1, fyi: 2 };
              return r[a.severity_hint] - r[b.severity_hint];
            })
            .map((a) => (
              <div
                key={a.id}
                className={`rounded-xl border px-4 py-3 flex items-center gap-3 flex-wrap ${
                  a.severity_hint === 'act-now'
                    ? 'border-rust bg-rust/5'
                    : a.severity_hint === 'next-glance'
                      ? 'border-amber bg-amber/5'
                      : 'border-rule bg-paper-subtle'
                }`}
              >
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${SEV_PILL[a.severity_hint]}`}>
                  {SEV_LABEL[a.severity_hint]}
                </span>
                <span className="text-[13.5px] font-semibold text-ink shrink-0">
                  {a.subject.kind === 'agent' ? a.subject.ref : `${a.subject.kind}:${a.subject.ref}`}
                </span>
                <span className="text-[12.5px] text-ink-soft min-w-0 truncate flex-1">
                  {a.subject.kind === 'agent' ? describeAnomaly(a.rule, liveByName.get(a.subject.ref)) : ruleLabel(a.rule)}
                </span>
                <span className="text-[11.5px] text-ink-quiet shrink-0 tabular-nums">{ageStr(a.triggered_at)}</span>
                <button
                  onClick={() => onAnomalyAction(a, 'resolve')}
                  className="text-[11.5px] px-2.5 py-1 rounded-md bg-coral text-paper hover:bg-coral-deep transition-colors shrink-0"
                >
                  Resolve
                </button>
                <button
                  onClick={() => onAnomalyAction(a, 'dismiss')}
                  className="text-[11.5px] px-2 py-1 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors shrink-0"
                >
                  Dismiss
                </button>
                {a.subject.kind === 'agent' && (
                  <Link
                    href={`/status/${encodeURIComponent(a.subject.ref)}`}
                    className="text-[12px] link-coral shrink-0 inline-flex items-center gap-0.5"
                  >
                    Details <ChevronRight size={12} />
                  </Link>
                )}
              </div>
            ))}
        </section>
      ) : (
        data && (
          <div className="mb-7 rounded-xl border border-forest/40 bg-forest/[0.07] px-5 py-4 flex items-center gap-3.5">
            <span className="w-9 h-9 rounded-full bg-forest/20 flex items-center justify-center shrink-0">
              <Check size={18} strokeWidth={2.8} className="text-forest" />
            </span>
            <div className="min-w-0">
              <div className="font-serif text-[16px] text-ink leading-tight">Nothing needs your attention today</div>
              <div className="text-[12.5px] text-ink-quiet mt-0.5">No stuck signals · no unusual silence · no risky commands · no quota alerts</div>
            </div>
          </div>
        )
      )}

      {loading && !data && (
        <div>
          <div className="eyebrow text-ink-quiet mb-2">Loading status…</div>
          <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-11 bg-paper-card animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {/* 3 — Roster. One line per agent. Anomaly agents first. */}
      {data && (
        <section className="space-y-4">
          {clean.length > 0 && (
            <div>
              <div className="eyebrow mb-2 text-ink-quiet">With Claude Code data · {clean.length}</div>
              <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
                {clean.map((r) => (
                  <RosterLine key={r.name} r={r} />
                ))}
              </div>
            </div>
          )}

          {noData.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer eyebrow text-ink-quiet hover:text-ink-muted list-none [&::-webkit-details-marker]:hidden">
                No Claude Code data · {noData.length}
                <span className="group-open:hidden"> (expand)</span>
                <span className="hidden group-open:inline"> (collapse)</span>
              </summary>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-1.5">
                {noData.map((r) => (
                  <Link
                    key={r.name}
                    href={`/status/${encodeURIComponent(r.name)}`}
                    className="text-[12.5px] text-ink-quiet hover:text-ink hover:underline transition-colors truncate"
                  >
                    {r.resolved ? r.name : `⚠ ${r.name}`}
                  </Link>
                ))}
              </div>
            </details>
          )}

          {clean.length === 0 && noData.length === roster.length && roster.length > 0 && (
            <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-16 text-center">
              <p className="font-serif text-[18px] text-ink mb-1.5">No Claude Code activity yet</p>
              <p className="text-[13px] text-ink-muted leading-relaxed max-w-md mx-auto">
                Once the collector receives uploaded sessions, run{' '}
                <code className="font-mono text-[12px] px-1.5 py-0.5 bg-paper-subtle rounded">bun run sync --only=cc</code> to pull.
              </p>
            </div>
          )}
        </section>
      )}

    </div>
  );
}

// "Hot" live signals worth a tiny chip on the roster row — only the ones the
// leader would want to notice at a glance (context window near full, quota
// window near limit). Everything else from the live snapshot lives on the
// detail page. Empty array when nothing is hot.
// Each window contributes at most one chip — the more informative of (current
// util near limit) vs (projected to exceed at current rate). Pace wins when
// fired because it carries the "how bad it'll get" number.
function quotaChip(
  label: '5h' | '7d',
  util: number | undefined,
  resetAt: number | undefined,
  windowMs: number,
  warnAt: number
): string | null {
  if (typeof util !== 'number') return null;
  const p = quotaPace(util, resetAt, windowMs);
  const onPace =
    p &&
    p.progress >= PACE_MIN_PROGRESS &&
    1 - p.progress >= PACE_MIN_REMAINING &&
    util >= PACE_MIN_UTIL &&
    p.projection >= PACE_RISK;
  if (onPace) return `${label} ↑${Math.round(p!.projection * 100)}%`;
  if (util >= warnAt) return `${label} ${Math.round(util * 100)}%`;
  return null;
}

function hotChips(live: CcLive | undefined): string[] {
  if (!live) return [];
  const out: string[] = [];
  if (typeof live.context_pct === 'number' && live.context_pct >= CONTEXT_WARN) {
    out.push(`Context ${Math.round(live.context_pct * 100)}%`);
  } else if (live.session_health === '⚠超长') {
    out.push('Context overflow');
  }
  const c5 = quotaChip('5h', live.five_hour_utilization, live.five_hour_reset_at, WINDOW_MS_5H, QUOTA_WARN);
  if (c5) out.push(c5);
  const c7 = quotaChip('7d', live.seven_day_utilization, live.seven_day_reset_at, WINDOW_MS_7D, QUOTA_7D_WARN);
  if (c7) out.push(c7);
  return out;
}

function FlagStat({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[11.5px] text-ink-quiet">{label}</div>
        <div className="font-serif text-[24px] text-ink leading-tight tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function RosterLine({ r }: { r: RosterRow }) {
  const chips = hotChips(r.live);
  // Anomaly text is intentionally NOT shown here — the cards above are the
  // place for "act on this". The roster shows the parallel work streams.
  // When the LLM cached items array is empty but we still have a headline,
  // render the headline as a single synthesized item so every row gets the
  // same coral-dot rhythm (no "some rows have dots, some don't").
  const rawItems = r.workItems ?? [];
  const items =
    rawItems.length > 0
      ? rawItems
      : r.workHint
        ? [{ title: r.workHint, status: '进行中' as WorkItemStatus, repo: r.currentRepo ?? '' }]
        : [];
  const useStack = items.length > 0;
  return (
    <Link
      href={`/status/${encodeURIComponent(r.name)}`}
      className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-paper-subtle bg-paper-card"
    >
      <span className={`w-2 h-2 rounded-full shrink-0 mt-[7px] ${FLAG_DOT[r.activityFlag]}`} title={FLAG_LABEL[r.activityFlag]} />
      <span className="font-serif text-[14.5px] text-ink w-28 shrink-0 truncate mt-px" title={r.name}>
        {r.resolved ? r.name : <span className="text-amber">⚠ {r.name}</span>}
      </span>
      {useStack ? (
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {items.map((it, i) => (
            <div key={i} className="flex items-baseline gap-2 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${WORK_DOT[it.status]} self-center`} />
              <span className="text-[12.5px] text-ink-soft truncate" title={it.repo ? `${it.repo} · ${it.title}` : it.title}>
                {it.title}
              </span>
              {it.repo && (
                <span className="text-[10.5px] font-mono text-ink-quiet shrink-0 hidden sm:inline">{it.repo}</span>
              )}
            </div>
          ))}
        </div>
      ) : r.workHint ? (
        <span className="text-[12.5px] text-ink-soft truncate flex-1 min-w-0 mt-[3px]" title={r.currentRepo ?? ''}>
          {r.workHint}
        </span>
      ) : (
        <span className="text-[12px] font-mono text-ink-quiet truncate flex-1 min-w-0 mt-[3px]" title={r.currentRepo ?? ''}>
          {r.currentRepo ?? '—'}
        </span>
      )}
      {chips.map((c) => (
        <span key={c} className="text-[10.5px] px-1.5 py-0.5 rounded bg-amber/10 text-amber shrink-0 tabular-nums mt-[3px]">
          {c}
        </span>
      ))}
      <span className="text-[12px] text-ink-quiet shrink-0 tabular-nums w-[5.5rem] text-right mt-[3px]">{ageStr(r.lastSessionAt)}</span>
      <ChevronRight size={13} className="text-ink-quiet shrink-0 mt-[5px]" />
    </Link>
  );
}

function Agg({
  label,
  value,
  caption,
  tone
}: {
  label: string;
  value: number | string;
  caption?: string;
  tone?: 'warn';
}) {
  const color = tone === 'warn' ? 'text-amber' : 'text-ink';
  return (
    <div className="bg-paper-card px-4 py-3.5 flex flex-col">
      <div className="eyebrow">{label}</div>
      <div className={`font-serif text-[19px] leading-snug mt-1.5 tabular-nums ${color}`}>{value}</div>
      {caption && <div className="text-[10.5px] text-ink-quiet mt-1.5 truncate">{caption}</div>}
    </div>
  );
}
