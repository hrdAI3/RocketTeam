'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { QUOTA_WARN, QUOTA_7D_WARN, PACE_RISK, PACE_MIN_PROGRESS, PACE_MIN_REMAINING, PACE_MIN_UTIL } from '@/lib/cc_thresholds';

const QUOTA_WINDOW_MS_5H = 5 * 60 * 60 * 1000;
const QUOTA_WINDOW_MS_7D = 7 * 24 * 60 * 60 * 1000;

// Per-agent CC detail — drill-down. The leader opens this when they have a
// concern about a specific person. Detail (sessions, tools, tokens, stuck
// quotes) is fine here because it is pull, not push. Still no persona / MBTI /
// coaching metrics — those belong in a 1:1 or the person's own self-view.

type ActivityFlag = 'active' | 'idle' | 'dormant' | 'never';

interface SessionDetail {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  cwd?: string;
  gitBranch?: string;
  tools: Array<{ tool: string; count: number }>;
  stuck: string[];
  stuckCount: number;
}

// Mirrors the collector's live CCStatus snapshot (snake_case from the API). All
// fields optional — the collector may roll fields out incrementally and this is
// genuinely "current state", absent when the feed isn't wired.
interface CcLive {
  session_id?: string;
  cwd?: string;
  git_branch?: string | null;
  ts?: string;
  event?: string;
  stale_seconds?: number;
  session_started_at?: string;
  model?: string;
  context_tokens?: number;
  context_pct?: number;
  session_health?: string;
  cost_usd?: number;
  tokens_5h?: number;
  tokens_7d?: number;
  subscription_tier?: string;
  five_hour_utilization?: number;
  seven_day_utilization?: number;
  five_hour_reset_at?: number;
  seven_day_reset_at?: number;
  quota_stale?: boolean;
  turn_count?: number;
  tool_calls_total?: number;
  tool_calls_failed?: number;
  files_touched?: number;
}

interface OneAgentDetail {
  name: string;
  resolved: boolean;
  lastSessionAt: string | null;
  activityFlag: ActivityFlag;
  topicHint: string | null;
  cwdHint: string | null;
  gitBranchHint: string | null;
  modelHint: string | null;
  toolsLast24h: Array<{ tool: string; count: number }>;
  tokensWeek: { input: number; output: number; cacheRead: number; cacheCreate: number };
  sessionCountWeek: number;
  stuckSignalsLast24h: number;
  currentRepo: string | null;
  currentRepoName: string | null;
  currentBranch: string | null;
  recentSessions: SessionDetail[];
  recentStuckQuotes: string[];
  live?: CcLive;
  liveSessions?: CcLive[];
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

function ageStr(iso: string | null): string {
  if (!iso) return 'never';
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 60 / 24)}d ago`;
}
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const M = MONTHS[d.getMonth()];
  const D = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${M} ${D} · ${h}:${m}`;
}
// Branch names carry a redundant "worktree-" prefix; show the readable leaf.
// Must match the transform on the /status roster so the same branch reads the
// same everywhere.
function tidyBranch(b: string | null | undefined): string {
  if (!b) return '—';
  return b.replace(/^worktree-/, '');
}
function dur(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '—';
  const ms = Date.parse(end) - Date.parse(start);
  if (ms <= 0) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  return `${(min / 60).toFixed(1)}h`;
}
function fmtTokens(n: number | undefined): string {
  if (typeof n !== 'number') return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function agoSecs(s: number | undefined): string {
  if (typeof s !== 'number') return '—';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
function resetIn(unixSec: number | undefined): string {
  if (typeof unixSec !== 'number') return '';
  const ms = unixSec * 1000 - Date.now();
  if (ms <= 0) return 'resetting now';
  const h = ms / 3_600_000;
  if (h < 1) return `resets in ${Math.round(ms / 60_000)}m`;
  if (h < 48) return `resets in ${Math.round(h)}h`;
  return `resets in ${Math.round(h / 24)}d`;
}

type WorkItemStatus = '进行中' | '卡住' | '调研中' | '已完成';
interface WorkItem {
  title: string;
  repo: string;
  status: WorkItemStatus;
  detail: string;
}
interface WorkSummary {
  headline?: string;
  items?: WorkItem[] | null;
  generatedAt?: string;
  stale?: boolean;
}
const STATUS_DOT: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber',
  进行中: 'bg-coral',
  调研中: 'bg-ink-quiet',
  已完成: 'bg-forest'
};
// Status pill backgrounds — soft tints that don't compete with the content.
const STATUS_PILL: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber/15 text-amber',
  进行中: 'bg-coral/15 text-coral-deep',
  调研中: 'bg-paper-subtle text-ink-quiet',
  已完成: 'bg-forest/12 text-forest'
};
// LLM emits Chinese status enums; map to English for display. Keeping the wire
// shape unchanged so existing summary cache stays valid.
const STATUS_LABEL: Record<WorkItemStatus, string> = {
  卡住: 'Blocked',
  进行中: 'In progress',
  调研中: 'Investigating',
  已完成: 'Done'
};

export default function AgentDetailPage() {
  const params = useParams();
  const name = decodeURIComponent(String(params.name ?? ''));
  const [d, setD] = useState<OneAgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [work, setWork] = useState<WorkSummary | null>(null);
  const [workLoading, setWorkLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cc-status/${encodeURIComponent(name)}`, { cache: 'no-store' });
      if (res.status === 404) {
        setError('Member not found');
        return;
      }
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setD((await res.json()) as OneAgentDetail);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  // Lazy: the work summary needs an LLM call, so fetch it separately so the
  // rest of the page paints immediately.
  const refreshWork = useCallback(async () => {
    setWorkLoading(true);
    try {
      const res = await fetch(`/api/cc-status/${encodeURIComponent(name)}/summary`, { cache: 'no-store' });
      if (res.ok) setWork((await res.json()) as WorkSummary);
    } catch {
      /* leave prior value */
    } finally {
      setWorkLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (d && d.activityFlag !== 'never') void refreshWork();
  }, [d, refreshWork]);

  useEffect(() => {
    document.title = `${name} · Status · Rocket Team`;
  }, [name]);

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <div className="eyebrow mb-6">
        Rocket Team / <Link href="/status" className="hover:text-ink-muted transition-colors">Status</Link> / {name}
      </div>

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error} <button onClick={refresh} className="ml-3 link-coral">Retry</button>
        </div>
      )}

      {loading && !d && <div className="h-40 rounded-xl border border-rule bg-paper-card animate-pulse" />}

      {d && (
        <>
          <header className="flex items-end justify-between mb-6">
            <div>
              <h1 className="display-title">{d.resolved ? d.name : <span className="text-amber">⚠ {d.name}</span>}</h1>
              <div className="text-[13px] text-ink-quiet mt-1.5 flex items-center gap-2">
                {d.activityFlag !== 'never' && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${FLAG_DOT[d.activityFlag]}`} />}
                <span>
                  {d.activityFlag === 'never'
                    ? 'No Claude Code data'
                    : `${FLAG_LABEL[d.activityFlag]} · last session ${ageStr(d.lastSessionAt)}${d.lastSessionAt && fmtDateTime(d.lastSessionAt) ? ` (${fmtDateTime(d.lastSessionAt)})` : ''}`}
                </span>
              </div>
            </div>
            {/* No 刷新 button on the no-data variant — refreshing the page does
                nothing; data only arrives via the CLI sync. */}
            {d.activityFlag !== 'never' && (
              <button onClick={refresh} aria-label="Refresh" className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors">
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            )}
          </header>

          {d.activityFlag === 'never' ? (
            // No Claude Code data — a centered, capped empty block (matches the
            // empty states on /status and /tasks).
            <section className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-14 text-center">
              <p className="font-serif text-[16px] text-ink mb-1.5">No Claude Code session data yet</p>
              <p className="text-[13px] text-ink-muted leading-relaxed max-w-md mx-auto">
                Once their collector uploads a session, run{' '}
                <code className="font-mono text-[12px] px-1.5 py-0.5 bg-paper-subtle rounded">bun run sync --only=cc</code> to pull.
              </p>
            </section>
          ) : (
            <>
              {/* "What is their Claude Code working on" — a system-written
                  summary read off the event stream + live snapshot (LLM, cached,
                  fetched lazily). The single most important thing on this page,
                  so it leads. */}
              <WorkSummaryCard work={work} loading={workLoading} />

              {/* Live snapshot — the near-real-time picture from the collector's
                  /api/cc-status feed: context window, session health, this
                  session's cost, quota windows, productivity counts. Rendered
                  only when that feed is wired and this person is running CC. */}
              {d.live && <LiveSection live={d.live} others={(d.liveSessions ?? []).filter((s) => s.session_id !== d.live!.session_id)} />}

              {/* Where they are + the week's totals. Repo / branch / cwd / model
                  reflect the live session when there is one, else the most
                  recent substantive session. */}
              <section className="rounded-xl border border-rule bg-paper-card p-5 mb-4">
                <div className="eyebrow mb-3">Where they are</div>
                <dl className="space-y-2 text-[13px]">
                  <Row label="Repo" value={d.currentRepoName ?? '—'} mono />
                  <Row label="Branch" value={d.currentBranch ?? '—'} mono />
                  <Row label="Working dir" value={d.cwdHint ?? '—'} mono />
                  <Row label="Model" value={d.modelHint ?? '—'} mono />
                  <Row label="Sessions/wk" value={String(d.sessionCountWeek)} />
                  <Row label="Tokens/wk" value={`in ${fmtTokens(d.tokensWeek.input)} · out ${fmtTokens(d.tokensWeek.output)}`} mono />
                  {d.stuckSignalsLast24h > 0 && (
                    <Row
                      label="Stuck 24h"
                      value={String(d.stuckSignalsLast24h)}
                      tone="warn"
                    />
                  )}
                </dl>
                {d.toolsLast24h.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-rule">
                    <div className="eyebrow mb-2">Top tools · 24h</div>
                    <div className="flex flex-wrap gap-1.5">
                      {d.toolsLast24h.map((t) => (
                        <span key={t.tool} className="text-[11px] font-mono px-2 py-0.5 rounded bg-paper-subtle text-ink-muted tabular-nums">
                          {t.tool} <span className="text-ink-quiet">×</span> {t.count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* Stuck quotes */}
              {d.recentStuckQuotes.length > 0 && (
                <section className="rounded-xl border border-amber/40 bg-amber/5 p-5 mb-4">
                  <div className="flex items-center gap-1.5 eyebrow text-amber mb-2">
                    <AlertTriangle size={11} /> Stuck signals · 24h
                  </div>
                  <ul className="space-y-1.5 text-[13px] text-ink-soft">
                    {d.recentStuckQuotes.slice(0, 5).map((q, i) => (
                      <li key={i} className="font-mono text-[12px] leading-relaxed">
                        {q.replace(/\s+/g, ' ').slice(0, 200)}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Recent sessions */}
              <section>
                <div className="eyebrow mb-3">Recent sessions · {d.recentSessions.length}</div>
                {d.recentSessions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-rule p-6 text-center text-ink-quiet text-[13px]">
                    No substantive sessions in the last 7 days.
                  </div>
                ) : (
                  <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
                    {d.recentSessions.map((s) => (
                      <div key={s.sessionId} className="flex items-center gap-3 px-4 py-2.5 bg-paper-card text-[12.5px]">
                        <code className="font-mono text-[11.5px] text-ink-quiet shrink-0 w-16">{s.sessionId.slice(0, 8)}</code>
                        <span className="text-ink-quiet shrink-0 w-24 tabular-nums">{ageStr(s.endedAt ?? s.startedAt)}</span>
                        <span className="text-ink-quiet shrink-0 w-12 tabular-nums text-right">{dur(s.startedAt, s.endedAt)}</span>
                        {s.gitBranch && <span className="font-mono text-[11.5px] text-ink-soft truncate flex-1 min-w-0" title={s.gitBranch}>{tidyBranch(s.gitBranch)}</span>}
                        {!s.gitBranch && <span className="flex-1" />}
                        {s.stuckCount > 0 && (
                          <span className="text-amber inline-flex items-center gap-1 shrink-0">
                            <AlertTriangle size={9} /> stuck × {s.stuckCount}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

function WorkItemRow({ it }: { it: WorkItem }) {
  const done = it.status === '已完成';
  return (
    <div className={`flex items-start gap-3 px-4 py-3 ${done ? 'opacity-65' : ''}`}>
      <span className={`inline-flex items-center gap-1 text-[10.5px] font-medium px-1.5 py-0.5 rounded shrink-0 mt-[2px] tabular-nums ${STATUS_PILL[it.status]}`}>
        <span className={`w-1 h-1 rounded-full ${STATUS_DOT[it.status]}`} />
        {STATUS_LABEL[it.status]}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[14px] leading-snug ${done ? 'text-ink-soft' : 'text-ink font-medium'}`}>{it.title}</div>
        {it.detail && <div className="text-[12.5px] text-ink-soft leading-relaxed mt-1">{it.detail}</div>}
      </div>
    </div>
  );
}

function WorkSummaryCard({ work, loading }: { work: WorkSummary | null; loading: boolean }) {
  const items = work?.items ?? [];
  // Nothing to show: not loading AND no items.
  if (!loading && items.length === 0) return null;
  // Group by repo (first-appearance order); items with no repo fall into a
  // trailing "其他" group. Headers only shown when there's more than one repo —
  // with a single repo the headline + the 当前位置 card already establish it.
  const groups: Array<{ repo: string; items: WorkItem[] }> = [];
  for (const it of items) {
    const key = it.repo || '';
    let g = groups.find((x) => x.repo === key);
    if (!g) {
      g = { repo: key, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  const showHeaders = groups.filter((g) => g.repo).length > 1;
  return (
    // Not a bordered box — the lede. It flows on the page; a hairline rule
    // separates it from the cards below.
    <section className="mb-6 pb-6 border-b border-rule">
      <div className="eyebrow mb-3 flex items-center gap-1.5">
        What Claude Code is doing
        {work?.stale && <span className="text-ink-ghost normal-case tracking-normal font-normal">· model unavailable — showing last result</span>}
      </div>
      {loading && items.length === 0 ? (
        <div className="space-y-3.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <div className="w-[3.75rem] h-3.5 rounded bg-paper-subtle animate-pulse shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 rounded bg-paper-subtle animate-pulse w-2/5" />
                <div className="h-3 rounded bg-paper-subtle animate-pulse w-[88%]" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {work?.headline && work.headline !== '数据不足' && work.headline !== 'Insufficient data' && (
            <p className="font-serif text-[18px] text-ink leading-snug mb-5">{work.headline}</p>
          )}
          <div className="space-y-3">
            {groups.map((g, gi) => (
              <div key={g.repo || `g${gi}`}>
                {showHeaders && (
                  <div className="flex items-baseline gap-2 mb-1.5 pl-1">
                    <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-paper-subtle text-ink-quiet">
                      {g.repo || 'Other'}
                    </span>
                    <span className="text-[10.5px] text-ink-ghost tabular-nums">{g.items.length} item{g.items.length === 1 ? '' : 's'}</span>
                  </div>
                )}
                <div className="rounded-xl border border-rule bg-paper-card overflow-hidden divide-y divide-rule-soft">
                  {g.items.map((it, ii) => (
                    <WorkItemRow key={`${it.title}-${ii}`} it={it} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {work?.generatedAt && (
            <div className="text-[10.5px] text-ink-quiet mt-3.5">Compiled {fmtDateTime(work.generatedAt)} · refreshes when activity changes</div>
          )}
        </>
      )}
    </section>
  );
}

function Row({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: 'warn' }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="text-ink-quiet text-[11px] uppercase tracking-wide shrink-0 w-24">{label}</dt>
      <dd className={`${mono ? 'font-mono text-[12px]' : 'text-[13px]'} ${tone === 'warn' ? 'text-amber' : 'text-ink'} break-all leading-relaxed`}>
        {value}
      </dd>
    </div>
  );
}

function LiveSection({ live, others }: { live: CcLive; others: CcLive[] }) {
  const hasQuota =
    typeof live.five_hour_utilization === 'number' || typeof live.seven_day_utilization === 'number';
  const hasSession = !!(live.session_id || live.session_started_at);
  if (!hasQuota && !hasSession) return null;
  // Light session context for the eyebrow when this is a real running session
  // (not just a quota-only fallback row).
  const extras: string[] = [];
  if (typeof live.turn_count === 'number') extras.push(`${live.turn_count} turn${live.turn_count === 1 ? '' : 's'}`);
  if (typeof live.files_touched === 'number') extras.push(`${live.files_touched} file${live.files_touched === 1 ? '' : 's'} touched`);
  return (
    <section className="mb-4">
      {hasSession && (
        <div className="eyebrow mb-3 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-forest" />
          Live
          <span className="text-ink-ghost normal-case tracking-normal font-normal">
            {live.session_started_at && live.ts ? ` · session age ${dur(live.session_started_at, live.ts)}` : ''}
            {typeof live.stale_seconds === 'number' ? ` · last action ${agoSecs(live.stale_seconds)}` : ''}
            {extras.length ? ` · ${extras.join(' · ')}` : ''}
          </span>
        </div>
      )}
      {hasQuota && (
        <div className="rounded-xl border border-rule bg-paper-card p-4">
          <div className="eyebrow mb-3">
            Quota windows
            {live.subscription_tier ? (
              <span className="text-ink-ghost normal-case tracking-normal"> · {live.subscription_tier}</span>
            ) : null}
            {live.quota_stale ? (
              <span className="text-amber normal-case tracking-normal"> · data may be stale</span>
            ) : null}
          </div>
          <div className="space-y-3">
            <QuotaBar label="5h window" util={live.five_hour_utilization} resetAt={live.five_hour_reset_at} warnAt={QUOTA_WARN} windowMs={QUOTA_WINDOW_MS_5H} />
            <QuotaBar label="7d window" util={live.seven_day_utilization} resetAt={live.seven_day_reset_at} warnAt={QUOTA_7D_WARN} windowMs={QUOTA_WINDOW_MS_7D} />
          </div>
        </div>
      )}
      {others.length > 0 && hasSession && (
        <div className="mt-3 rounded-xl border border-rule bg-paper-card overflow-hidden divide-y divide-rule">
          <div className="px-4 py-2 text-[11px] text-ink-quiet bg-paper-subtle">{others.length} other session{others.length === 1 ? '' : 's'} running</div>
          {others.map((s, i) => (
            <div key={s.session_id ?? i} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
              <code className="font-mono text-[11.5px] text-ink-quiet shrink-0 w-16">{(s.session_id ?? '').slice(0, 8)}</code>
              <span className="font-mono text-[11.5px] text-ink-soft truncate flex-1 min-w-0" title={s.cwd}>{s.cwd ?? '—'}</span>
              <span className="text-ink-quiet shrink-0 tabular-nums">{agoSecs(s.stale_seconds)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function QuotaBar({ label, util, resetAt, warnAt, windowMs }: { label: string; util?: number; resetAt?: number; warnAt: number; windowMs: number }) {
  if (typeof util !== 'number') {
    return (
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-ink-soft">{label}</span>
        <span className="text-ink-quiet">—</span>
      </div>
    );
  }
  const p = Math.round(util * 100);
  // Pace projection: at current rate, where will this be at window end?
  // (`util / progress`). When projection ≥ 1.0 and we have enough data, the
  // bar's amber and the right-hand label says "按节奏 X% (会超额)".
  let pace: { progress: number; projection: number } | null = null;
  if (typeof resetAt === 'number') {
    const elapsed = windowMs - (resetAt * 1000 - Date.now());
    const progress = Math.max(0, Math.min(1, elapsed / windowMs));
    if (progress > 0) pace = { progress, projection: util / progress };
  }
  const onPace =
    !!pace &&
    pace.progress >= PACE_MIN_PROGRESS &&
    1 - pace.progress >= PACE_MIN_REMAINING &&
    util >= PACE_MIN_UTIL &&
    pace.projection >= PACE_RISK;
  const hot = util >= warnAt || onPace;
  const reset = resetIn(resetAt);
  const projectedPct = pace ? Math.round(pace.projection * 100) : null;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px] mb-1">
        <span className="text-ink-soft">{label}</span>
        <span className={`tabular-nums ${hot ? 'text-amber font-medium' : 'text-ink-quiet'}`}>
          {p}%
          {onPace && projectedPct !== null && (
            <span className="text-amber font-normal"> · projected {projectedPct}%</span>
          )}
          {reset && <span className="text-ink-quiet font-normal"> · {reset}</span>}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-paper-subtle overflow-hidden relative">
        <div className={`h-full rounded-full ${hot ? 'bg-amber' : 'bg-forest'}`} style={{ width: `${Math.min(100, Math.max(2, p))}%` }} />
        {onPace && projectedPct !== null && projectedPct > p && (
          <div
            className="absolute top-0 h-full border-l border-amber/60"
            style={{ left: `${Math.min(100, projectedPct)}%` }}
            title={`projected ${projectedPct}%`}
          />
        )}
      </div>
    </div>
  );
}
