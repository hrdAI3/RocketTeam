'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronRight, ChevronDown, Check } from 'lucide-react';

// Workboard — the attention-scarce leader's landing page.
//
// THIS PAGE shows ONLY items that need leader intervention: open anomalies and
// blocked projects. Everything else (active projects humming along, wrapping
// up, dormant, unclustered work) lives one click away at `/status/projects`.
// Empty state ("All clear today") is the desired default — the leader walks
// in, sees nothing, and gets their day back.
//
// Member names live deeper still (`/status/[name]`). Names are deliberately
// absent from this glance.

type Severity = 'act-now' | 'next-glance' | 'fyi';
type WorkItemStatus = '进行中' | '卡住' | '已完成';
type ProjectStatus = 'blocked' | 'active' | 'wrapping' | 'dormant';

interface DemoWorkItem {
  title: string;
  status: WorkItemStatus;
  detail: string;
}
interface ProjectCard {
  key: string;
  name: string;
  workItems: DemoWorkItem[];
  ccCount: number;
  lastActivityAt: string | null;
  status: ProjectStatus;
}
interface AnomalyLite {
  id: string;
  rule: string;
  subject: { kind: string; ref: string };
  severity_hint: Severity;
  triggered_at: string;
}
interface UntrackedProjectRow {
  key: string;
  name: string;
  owner: string | null;
  workItems: Array<{ title: string; status: string; detail: string }>;
  ccCount: number;
  lastActivityAt: string | null;
}
interface WorkboardView {
  projects: ProjectCard[];
  unclustered: unknown[];
  untrackedProjects?: UntrackedProjectRow[];
  anomalies: AnomalyLite[];
  aggregate: { totalProjects: number; stuck: number };
  degraded?: 'empty-registry' | 'collector-down' | 'llm-stale';
}

interface ExternalOwnerRow {
  owner: string;
  name: string;
  fullName: string;
  responsible: string | null;
  responsibleLeft: boolean;
}

interface DepartureSuspect {
  name: string;
  reason: 'slack-deactivated' | 'cc-silent-30d';
  detail: string;
}
interface UnmappedCcActor {
  actor: string;
  event_count: number;
  last_seen: string;
}
interface RosterHealth {
  departureSuspects: DepartureSuspect[];
  unmappedCcActors: UnmappedCcActor[];
}

interface BriefAttention {
  text: string;
  why: string;
  severity: 'high' | 'medium' | 'low';
}
interface DailyBrief {
  date: string;
  headline: string;
  yesterday: string;
  attention: BriefAttention[];
  suggestion: string;
  signals: {
    active_people: number;
    commits_yesterday: number;
    prs_yesterday: number;
    top_projects: Array<{ name: string; commits: number }>;
    goals_total?: number;
    goals_at_risk?: number;
  };
  generated_at: string;
}

// One merged attention stream — every signal renders as a uniform row.
type AttentionItem =
  | { kind: 'anomaly'; data: AnomalyLite }
  | { kind: 'blocked'; data: ProjectCard }
  | { kind: 'unattributed'; rows: AnomalyLite[] }
  | { kind: 'untracked-project'; data: UntrackedProjectRow }
  | { kind: 'transfer'; data: ExternalOwnerRow }
  | { kind: 'handoff'; data: ExternalOwnerRow }
  | { kind: 'departure'; data: DepartureSuspect }
  | { kind: 'unmapped'; data: UnmappedCcActor };

function attentionKey(it: AttentionItem): string {
  if (it.kind === 'anomaly') return `a:${it.data.id}`;
  if (it.kind === 'blocked') return `b:${it.data.key}`;
  if (it.kind === 'transfer') return `t:${it.data.fullName}`;
  if (it.kind === 'handoff') return `h:${it.data.fullName}`;
  if (it.kind === 'untracked-project') return `up:${it.data.key}`;
  if (it.kind === 'departure') return `d:${it.data.name}`;
  if (it.kind === 'unmapped') return `u:${it.data.actor}`;
  return 'unattributed';
}

const DEPARTURE_REASON_LABEL: Record<DepartureSuspect['reason'], string> = {
  'slack-deactivated': 'Slack 已停用',
  'cc-silent-30d': 'CC 静默超 30 天'
};

const WORK_DOT: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber',
  进行中: 'bg-ink-quiet',
  已完成: 'bg-forest'
};
const WORK_LABEL: Record<WorkItemStatus, string> = {
  卡住: 'Blocked',
  进行中: 'In progress',
  已完成: 'Done'
};

const SEV_LABEL: Record<Severity, string> = {
  'act-now': 'Alert',
  'next-glance': 'Notice',
  fyi: 'FYI'
};

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
  'context.near_full': 'Context near full',
  'project.unattributed': 'Unattributed work'
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
  if (rule.startsWith('danger.command.'))
    return DANGER_LABEL[rule.slice('danger.command.'.length)] ?? 'Dangerous command';
  return rule;
}

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

const CARD_VISIBLE = 4; // attention page has fewer cards — each gets more room
const CARD_MIN_H = 'min-h-[200px]';

export default function WorkboardPage() {
  const [data, setData] = useState<WorkboardView | null>(null);
  const [externalOwners, setExternalOwners] = useState<ExternalOwnerRow[]>([]);
  const [health, setHealth] = useState<RosterHealth | null>(null);
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [briefOpen, setBriefOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    document.title = 'Workboard · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [resWb, resOwn, resHealth] = await Promise.all([
        fetch('/api/workboard', { cache: 'no-store' }),
        fetch('/api/repo-ownership', { cache: 'no-store' }),
        fetch('/api/roster/health', { cache: 'no-store' })
      ]);
      if (!resWb.ok) throw new Error(`Failed: ${resWb.status}`);
      setData((await resWb.json()) as WorkboardView);
      if (resOwn.ok) {
        const j = (await resOwn.json()) as { repos?: ExternalOwnerRow[] };
        setExternalOwners(j.repos ?? []);
      }
      if (resHealth.ok) {
        setHealth((await resHealth.json()) as RosterHealth);
      }
      setSyncedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Daily brief loads INDEPENDENTLY — it's supplementary and the first-ever
  // build runs an LLM call, so it must never gate the workboard's loading
  // state. Pops in when ready; refreshes hourly.
  useEffect(() => {
    const load = () =>
      fetch('/api/brief', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && !('error' in j)) setBrief(j as DailyBrief);
        })
        .catch(() => {});
    void load();
    const id = setInterval(load, 3600_000);
    return () => clearInterval(id);
  }, []);

  const anomalies = data?.anomalies ?? [];
  const blockedProjects = (data?.projects ?? []).filter((p) => p.status === 'blocked');
  const totalProjects = data?.aggregate.totalProjects ?? 0;

  // project.unattributed fires per-thread — could be many. Collapse them into
  // a single expandable group so they don't drown out the louder signals.
  const unattributedAnomalies = anomalies.filter((a) => a.rule === 'project.unattributed');
  const otherAnomalies = anomalies.filter((a) => a.rule !== 'project.unattributed');

  // Severity rank for the merged attention list. Loudest first: act-now
  // anomaly (real-time critical) → blocked project (project stuck, needs
  // unblocking) → next-glance anomaly (warning) → fyi anomaly (info) →
  // github-gap group (lowest urgency — leader hygiene, not a fire).
  // One merged, severity-sorted stream (matches the Rocket Team design's
  // Workboard). Every signal — anomalies, blocked projects, unattributed
  // work, personal-account repos — renders as one uniform row in a single
  // list. Loudest first.
  const rank = (it: AttentionItem): number => {
    if (it.kind === 'anomaly' && it.data.severity_hint === 'act-now') return 0;
    if (it.kind === 'blocked') return 1;
    if (it.kind === 'handoff') return 2; // departed-owner repo — leader must reassign
    if (it.kind === 'departure') return 2; // right after blocked — prominent
    if (it.kind === 'anomaly' && it.data.severity_hint === 'next-glance') return 3;
    if (it.kind === 'anomaly') return 4; // fyi
    if (it.kind === 'untracked-project') return 5; // per-project unattributed notice
    if (it.kind === 'unattributed') return 5; // legacy aggregate (unused now)
    if (it.kind === 'transfer') return 6; // governance FYI
    return 7; // unmapped (FYI)
  };
  const attentionItems: AttentionItem[] = [
    ...otherAnomalies.map((a) => ({ kind: 'anomaly' as const, data: a })),
    ...blockedProjects.map((p) => ({ kind: 'blocked' as const, data: p })),
    ...(health?.departureSuspects ?? []).map((d) => ({ kind: 'departure' as const, data: d })),
    // Replaced the single "Unattributed work · N" aggregate with one row per
    // inferred untracked project. Each row carries the owner + work titles so
    // the leader sees what's actually untracked (and Slack DMs the owner per
    // project, not per item). Falls back to the aggregate when the workboard
    // hasn't yet computed untrackedProjects (older API shape).
    ...((data?.untrackedProjects && data.untrackedProjects.length > 0)
      ? data.untrackedProjects.map((p) => ({ kind: 'untracked-project' as const, data: p }))
      : unattributedAnomalies.length > 0
        ? [{ kind: 'unattributed' as const, rows: unattributedAnomalies }]
        : []),
    // Departed-owner repos: tracked underneath (monitor skips their DMs, the
    // data still flows through repo_ownership) but NOT surfaced as attention
    // rows — leader explicitly asked to stop nagging about left members.
    // Re-enable by mapping responsibleLeft → 'handoff' if a future "handoff
    // queue" page wants them.
    ...externalOwners
      .filter((r) => !r.responsibleLeft)
      .map((r) => ({ kind: 'transfer' as const, data: r })),
    ...(health?.unmappedCcActors ?? []).map((u) => ({ kind: 'unmapped' as const, data: u }))
  ].sort((a, b) => rank(a) - rank(b));
  const attentionCount = attentionItems.length;
  const allClear = data !== null && attentionCount === 0;

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      {/* Minimal header — date eyebrow + Live, no hero title. The attention
          list IS the headline (matches Rocket Team design). */}
      <header className="flex items-center justify-between gap-4 mb-7 pb-4 border-b border-rule-soft">
        <div className="flex items-center gap-3">
          <span className="eyebrow">{dateStr}</span>
          {data && attentionCount > 0 && (
            <>
              <span className="w-[3px] h-[3px] rounded-full bg-ink-ghost" />
              <span className="eyebrow text-coral inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-coral animate-pulse-coral" />
                Live
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {syncedAt !== null && (
            <span className="font-mono text-[11px] text-ink-quiet tabular-nums">{syncedStr(syncedAt)}</span>
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

      {data?.degraded && (
        <div className="rounded-xl border border-amber/40 bg-amber/[0.07] px-4 py-3 mb-6 text-[12px] text-ink-soft flex items-start gap-2.5">
          <span className="text-amber shrink-0 mt-px">⚠</span>
          <span className="leading-relaxed">
            {data.degraded === 'empty-registry' && (
              <>
                Project registry is empty — workboard is grouping by raw repo strings as
                a fallback. Run <code className="font-mono text-[11px] px-1 bg-paper-subtle rounded">bun run sync --only=projects</code> to populate it.
              </>
            )}
            {data.degraded === 'collector-down' && (
              <>
                The CC collector is unreachable. Showing data derived from events.jsonl;
                live status may be stale.
              </>
            )}
            {data.degraded === 'llm-stale' && (
              <>
                One or more work summaries are serving the last cached value (LLM unreachable
                during refresh). Attribution may reference earlier registry state.
              </>
            )}
          </span>
        </div>
      )}

      {/* Daily leader brief — the "digest + predict" card. Synthesized once per
          working day; mirrors the Slack DM. Collapsible. */}
      {brief && (
        <div className="rounded-xl border border-coral/30 bg-coral-subtle/40 px-5 py-4 mb-6">
          <button
            onClick={() => setBriefOpen((o) => !o)}
            className="w-full flex items-start justify-between gap-4 text-left"
          >
            <div className="min-w-0">
              <div className="eyebrow text-coral-deep mb-1.5">📋 {brief.date} · Daily brief</div>
              <div className="font-serif text-[18px] text-ink leading-snug">{brief.headline}</div>
            </div>
            <ChevronDown
              size={16}
              className={`text-coral-deep shrink-0 mt-1 transition-transform ${briefOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {briefOpen && (
            <div className="mt-3 space-y-3">
              <p className="text-[13.5px] text-ink-soft leading-relaxed">{brief.yesterday}</p>
              {brief.attention.length > 0 && (
                <div className="space-y-1.5">
                  {brief.attention.map((a, i) => (
                    <div key={i} className="flex items-start gap-2.5 text-[13px]">
                      <span className="shrink-0 mt-px">
                        {a.severity === 'high' ? '🔴' : a.severity === 'medium' ? '🟠' : '⚪'}
                      </span>
                      <span className="min-w-0">
                        <span className="text-ink">{a.text}</span>
                        <span className="text-ink-quiet"> · {a.why}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {brief.suggestion && (
                <div className="flex items-start gap-2 pt-2 border-t border-coral/15 text-[13px]">
                  <span className="shrink-0">👉</span>
                  <span className="text-ink-soft font-medium">{brief.suggestion}</span>
                </div>
              )}
              <div className="text-[11px] text-ink-quiet font-mono pt-1">
                {brief.signals.active_people} active · {brief.signals.commits_yesterday} commits · {brief.signals.prs_yesterday} PR/review
                {typeof brief.signals.goals_total === 'number' && (
                  <>
                    {' · '}
                    {brief.signals.goals_total} 目标 · {brief.signals.goals_at_risk ?? 0} 风险
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2.5">
          <div className="eyebrow text-ink-quiet mb-2">Loading…</div>
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-rule bg-paper-subtle px-5 py-4 space-y-2"
            >
              <div className="h-3 w-1/3 bg-paper-deep rounded animate-pulse" />
              <div className="h-3 w-2/3 bg-paper-deep rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* One severity-sorted attention stream — anomalies, blocked projects,
          unattributed work, personal-account repos, all as uniform rows.
          Loudest first. The list IS the headline. */}
      {attentionItems.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mb-3">
            <div className="eyebrow">
              Needs your attention · {attentionCount} item{attentionCount === 1 ? '' : 's'}
            </div>
            <span className="text-[11px] text-ink-quiet">sorted by severity</span>
          </div>
          <section className="space-y-2">
            {attentionItems.map((it) => (
              <AttentionRow key={attentionKey(it)} item={it} onAction={refresh} />
            ))}
          </section>
        </>
      )}

      {/* 3 — All-clear empty state. The DESIRED default. */}
      {allClear && (
        <div className="py-16 flex flex-col items-center text-center animate-fade-in">
          <span className="w-14 h-14 rounded-full bg-forest/10 flex items-center justify-center mb-4">
            <Check size={26} strokeWidth={2.4} className="text-forest" />
          </span>
          <div className="font-serif text-[28px] text-ink leading-tight tracking-[-0.02em]">
            All clear today.
          </div>
          <p className="text-[13px] text-ink-muted mt-2 leading-relaxed max-w-sm">
            No anomalies, no blocked projects, no risky commands across the team&apos;s personal agents.
          </p>
          {syncedAt !== null && (
            <div className="font-mono text-[11px] text-ink-quiet mt-5">{syncedStr(syncedAt)}</div>
          )}
        </div>
      )}

      {/* 4 — Footer link to the full project board. */}
      {data && (
        <div className="mt-8 flex justify-end">
          <Link
            href="/status/projects"
            className="text-[13px] link-coral inline-flex items-center gap-1"
          >
            Browse all {totalProjects} project{totalProjects === 1 ? '' : 's'}
            <ChevronRight size={14} />
          </Link>
        </div>
      )}
    </div>
  );
}

// Uniform attention row — one shape for every signal kind. Normalizes each
// item into { bar tone, pulse, pill, title, detail, age, href } then renders
// the same layout. Matches the Rocket Team design's single-stream Workboard.
function AttentionRow({ item, onAction }: { item: AttentionItem; onAction: () => void }) {
  type Tone = 'rust' | 'amber' | 'neutral';
  let tone: Tone = 'neutral';
  let pulse = false;
  let pill = '';
  let title = '';
  let detail: React.ReactNode = '';
  let age = '';
  let href: string | null = null;
  let onClick: (() => void) | null = null;

  if (item.kind === 'anomaly') {
    const a = item.data;
    tone = a.severity_hint === 'act-now' ? 'rust' : a.severity_hint === 'next-glance' ? 'amber' : 'neutral';
    pulse = a.severity_hint === 'act-now';
    pill = SEV_LABEL[a.severity_hint];
    title = ruleLabel(a.rule);
    detail =
      a.subject.kind === 'agent' || a.subject.kind === 'repo'
        ? a.subject.ref
        : `${a.subject.kind}:${a.subject.ref}`;
    age = ageStr(a.triggered_at);
  } else if (item.kind === 'blocked') {
    const p = item.data;
    const blockers = p.workItems.filter((it) => it.status === '卡住');
    tone = 'rust';
    pulse = true;
    pill = 'Blocked';
    title = p.name;
    detail = (
      <>
        {blockers[0]?.title ?? 'Blocked'}
        {blockers.length > 1 && (
          <span className="text-rust font-medium ml-2">+{blockers.length - 1} more</span>
        )}
      </>
    );
    age = ageStr(p.lastActivityAt);
    href = `/status/project/${encodeURIComponent(p.key)}`;
  } else if (item.kind === 'unattributed') {
    const n = item.rows.length;
    tone = 'amber';
    pill = 'Notice';
    title = 'Unattributed work';
    detail = `${n} thread${n === 1 ? '' : 's'} couldn't be tied to a project`;
    age = ageStr(item.rows[0]?.triggered_at ?? null);
    href = '/status/projects';
  } else if (item.kind === 'untracked-project') {
    const p = item.data;
    const titles = p.workItems.slice(0, 2).map((it) => it.title);
    const extra = p.workItems.length - titles.length;
    tone = 'amber';
    pill = 'Untracked';
    title = p.name;
    // No owner name on the project-axis glance — show the work, not the person.
    detail = (
      <>
        <span className="truncate">{titles.join(' / ')}</span>
        {extra > 0 && <span className="text-ink-quiet ml-1">+{extra}</span>}
      </>
    );
    age = ageStr(p.lastActivityAt);
    href = `/status/unclustered?focus=${encodeURIComponent(p.key)}`;
  } else if (item.kind === 'transfer') {
    const r = item.data;
    tone = 'amber';
    pill = 'FYI';
    title = 'Repo on personal account';
    // /status is the project-axis glance — NO person names. Show the repo only
    // (owner login + responsible name live on the deeper ownership/team views;
    // the Slack DM still goes to the owner via the actuator).
    detail = (
      <>
        <span className="font-mono">{r.name}</span>
        <span className="text-ink-ghost mx-1.5">·</span>
        transfer to anzy-renlab-ai
      </>
    );
    age = 'ongoing';
    href = `https://github.com/${r.fullName}`;
  } else if (item.kind === 'handoff') {
    const r = item.data;
    tone = 'rust';
    pill = 'HANDOFF';
    title = 'Departed owner — repo needs handoff';
    detail = (
      <>
        <span className="font-mono">{r.name}</span>
        <span className="text-ink-ghost mx-1.5">·</span>
        原所属人已离职 · 转交 anzy-renlab-ai 或重新分配
      </>
    );
    age = 'action';
    href = `https://github.com/${r.fullName}`;
  } else if (item.kind === 'departure') {
    const d = item.data;
    tone = 'amber';
    pill = 'REVIEW';
    title = 'Possible departure';
    detail = (
      <>
        <span className="font-medium text-ink">{d.name}</span>
        <span className="text-ink-ghost mx-1.5">·</span>
        {DEPARTURE_REASON_LABEL[d.reason]}
        <span className="text-ink-ghost mx-1.5">·</span>
        确认离职?
      </>
    );
    age = 'review';
    onClick = () => {
      if (window.confirm(`确认 ${d.name} 已离职？将从合规/提醒中排除。`)) {
        void fetch(`/api/roster/${encodeURIComponent(d.name)}/mark-left`, {
          method: 'POST',
          cache: 'no-store'
        }).then(() => onAction());
      }
    };
  } else {
    const u = item.data;
    tone = 'neutral';
    pill = 'FYI';
    title = 'Unmapped CC user';
    detail = (
      <>
        <span className="font-mono">{u.actor}</span>
        <span className="text-ink-ghost mx-1.5">·</span>
        {u.event_count} events
        <span className="text-ink-ghost mx-1.5">·</span>
        点击对应到人
      </>
    );
    age = ageStr(u.last_seen);
    // Click → ask which roster member this actor is, then POST the mapping.
    // The 53k events tagged with this unknown actor re-attribute on next roll.
    onClick = () => {
      const name = window.prompt(
        `这个 CC 账号 "${u.actor}" 是哪位同事？\n输入花名（如 徐云昊）映射，留空取消：`
      );
      if (!name || !name.trim()) return;
      void fetch('/api/identity/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ actor: u.actor, name: name.trim() })
      })
        .then(async (r) => {
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            window.alert(`映射失败：${j.error ?? r.status}`);
            return;
          }
          onAction();
        })
        .catch((e) => window.alert(`映射失败：${(e as Error).message}`));
    };
  }

  const frame =
    tone === 'rust'
      ? 'border-rust/45 bg-rust/[0.045]'
      : tone === 'amber'
        ? 'border-amber/45 bg-amber/[0.05]'
        : 'border-rule bg-paper-card';
  const bar = tone === 'rust' ? 'bg-rust' : tone === 'amber' ? 'bg-amber/70' : 'bg-ink-quiet';
  const pillCls =
    pill === 'Alert' || pill === 'Blocked'
      ? 'bg-rust text-white'
      : pill === 'Notice' || pill === 'REVIEW'
        ? 'bg-amber text-white'
        : 'bg-amber/15 text-amber'; // FYI

  const inner = (
    <>
      <span className={`w-[3px] self-stretch rounded-full shrink-0 ${bar} ${pulse ? 'animate-pulse-rust' : ''}`} />
      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-mono shrink-0 ${pillCls}`}>
        {pill}
      </span>
      <span className="font-serif text-[14px] font-medium text-ink shrink-0">{title}</span>
      <span className="text-[12.5px] text-ink-muted min-w-0 truncate flex-1">{detail}</span>
      <span className="font-mono text-[11px] text-ink-quiet shrink-0 tabular-nums">{age}</span>
      <ChevronRight size={14} className="text-ink-ghost shrink-0" />
    </>
  );
  const cls = `lift rounded-xl pl-3 pr-4 py-3 flex items-center gap-3.5 border ${frame}`;
  if (href) {
    if (/^https?:\/\//.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={`${cls} cursor-pointer`}>
          {inner}
        </a>
      );
    }
    return (
      <Link href={href} className={`${cls} cursor-pointer`}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${cls} cursor-pointer w-full text-left`}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}
