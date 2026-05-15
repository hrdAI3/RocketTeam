'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronRight, Check } from 'lucide-react';

// Workboard — the attention-scarce leader view, project-axis.
//
// What the leader sees, top to bottom:
//   1. Open anomalies (the only thing to act on) — read-only cards on top.
//   2. Project cards — work threads grouped by repo. Anonymous: a card shows
//      its threads + a Claude Code count, never a member name.
//   3. Unclustered work — threads not yet tied to a project, flat list.
//
// Member names live one level down (/status/[name]). This page is a glance at
// what's in flight, not a roster of who's doing what.

type Severity = 'act-now' | 'next-glance' | 'fyi';
type WorkItemStatus = '进行中' | '卡住' | '调研中' | '已完成';
type ProjectStatus = 'blocked' | 'active' | 'wrapping' | 'dormant';

interface DemoWorkItem {
  title: string;
  status: WorkItemStatus;
  detail: string; // shown on the project detail page, not on the glance card
}
interface ProjectCard {
  key: string;
  name: string;
  workItems: DemoWorkItem[];
  ccCount: number;
  lastActivityAt: string | null;
  status: ProjectStatus;
}
interface UnclusteredItem {
  title: string;
  status: WorkItemStatus;
}
interface AnomalyLite {
  id: string;
  rule: string;
  subject: { kind: string; ref: string };
  severity_hint: Severity;
  triggered_at: string;
}
interface WorkboardView {
  projects: ProjectCard[];
  unclustered: UnclusteredItem[];
  anomalies: AnomalyLite[];
  aggregate: { totalProjects: number; stuck: number };
}

// Work-thread status → dot color. Deliberately a 3-state legible system, not
// four arbitrary hues: amber = the one that needs attention (stuck), forest =
// done, muted grey = the calm "ongoing" default (in progress / investigating
// collapse here — the glance doesn't need to tell those apart; the per-member
// detail page still shows the full status). Mark the exception, not the rule.
const WORK_DOT: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber',
  进行中: 'bg-ink-quiet',
  调研中: 'bg-ink-quiet',
  已完成: 'bg-forest'
};
// English status word for the dot's hover tooltip — the precise state on
// demand, without putting a legend on the glance.
const WORK_LABEL: Record<WorkItemStatus, string> = {
  卡住: 'Blocked',
  进行中: 'In progress',
  调研中: 'Investigating',
  已完成: 'Done'
};

// Project status — blocked gets the loud treatment (it's the exception that
// earns visual weight); the rest stay quiet (a small dot + word).
const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  blocked: 'Blocked',
  active: 'Active',
  wrapping: 'Wrapping up',
  dormant: 'Dormant'
};
const PROJECT_STATUS_DOT: Record<ProjectStatus, string> = {
  blocked: 'bg-rust',
  active: 'bg-coral',
  wrapping: 'bg-forest',
  dormant: 'bg-ink-quiet'
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

// Friendly labels for anomaly rule ids. The leader sees these instead of
// `quota.pace_7d` etc.
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

export default function WorkboardPage() {
  const [data, setData] = useState<WorkboardView | null>(null);
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
      const res = await fetch('/api/workboard', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setData((await res.json()) as WorkboardView);
      setSyncedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep the "synced Nm ago" label honest between fetches.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const projects = data?.projects ?? [];
  const unclustered = data?.unclustered ?? [];
  const anomalies = data?.anomalies ?? [];
  const agg = data?.aggregate;

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-3">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Workboard</div>
          <h1 className="display-title">Workboard</h1>
          {agg && (
            <p className="text-[13px] text-ink-quiet mt-2">
              {agg.totalProjects} project{agg.totalProjects === 1 ? '' : 's'}
              {agg.stuck > 0 && (
                <>
                  <span className="mx-1.5 text-ink-ghost">·</span>
                  <span className="text-rust font-medium">{agg.stuck} blocked</span>
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2.5 shrink-0 pb-1">
          {syncedAt !== null && (
            <span className="text-[11px] text-ink-quiet tabular-nums">{syncedStr(syncedAt)}</span>
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
      <div className="mb-8" />

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error}{' '}
          <button onClick={refresh} className="ml-3 link-coral">
            Retry
          </button>
        </div>
      )}

      {/* 1 — Anomalies. The only thing to act on. Empty = good. Read-only here;
          act on them from the per-member detail page. */}
      {anomalies.length > 0 ? (
        <section className="mb-8 space-y-2">
          <div className="eyebrow text-rust mb-2">Needs your attention · {anomalies.length}</div>
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
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${SEV_PILL[a.severity_hint]}`}
                >
                  {SEV_LABEL[a.severity_hint]}
                </span>
                {/* Signal leads — the person is context, not the headline. The
                    name is needed (the leader has to know who to talk to) but
                    it stays quiet so the glance reads as a signal, not a roster
                    of monitored people. */}
                <span className="text-[13px] font-semibold text-ink shrink-0">
                  {ruleLabel(a.rule)}
                </span>
                <span className="text-[12.5px] text-ink-quiet min-w-0 truncate flex-1">
                  {a.subject.kind === 'agent'
                    ? a.subject.ref
                    : `${a.subject.kind}:${a.subject.ref}`}
                </span>
                <span className="text-[11.5px] text-ink-quiet shrink-0 tabular-nums">
                  {ageStr(a.triggered_at)}
                </span>
              </div>
            ))}
        </section>
      ) : (
        data && (
          <div className="mb-8 rounded-xl border border-forest/40 bg-forest/[0.07] px-5 py-4 flex items-center gap-3.5">
            <span className="w-9 h-9 rounded-full bg-forest/20 flex items-center justify-center shrink-0">
              <Check size={18} strokeWidth={2.8} className="text-forest" />
            </span>
            <div className="min-w-0">
              <div className="font-serif text-[16px] text-ink leading-tight">
                Nothing needs your attention today
              </div>
              <div className="text-[12.5px] text-ink-quiet mt-0.5">
                No stuck signals · no unusual silence · no risky commands · no quota alerts
              </div>
            </div>
          </div>
        )
      )}

      {loading && !data && (
        <div className="space-y-2.5">
          <div className="eyebrow text-ink-quiet mb-2">Loading workboard…</div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl border border-rule bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {/* 2 — Project cards + the unclustered bucket, balanced across two
          columns (see ProjectGrid) so the long tail packs tight and the two
          columns end at roughly even heights. */}
      {data && (projects.length > 0 || unclustered.length > 0) && (
        <ProjectGrid projects={projects} unclustered={unclustered} />
      )}

      {/* Empty — no projects and no unclustered threads. */}
      {data && projects.length === 0 && unclustered.length === 0 && (
        <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-16 text-center">
          <p className="font-serif text-[18px] text-ink mb-1.5">No work threads yet</p>
          <p className="text-[13px] text-ink-muted leading-relaxed max-w-md mx-auto">
            Once the collector receives uploaded sessions, run{' '}
            <code className="font-mono text-[12px] px-1.5 py-0.5 bg-paper-subtle rounded">
              bun run sync
            </code>{' '}
            to pull.
          </p>
        </div>
      )}
    </div>
  );
}

// Estimated rendered height of a card — used only to balance the columns in
// ProjectGrid. Rough is fine; it just has to rank cards sensibly.
function estProjectHeight(p: ProjectCard): number {
  const VISIBLE = 4;
  return 113 + Math.min(p.workItems.length, VISIBLE) * 21 + (p.workItems.length > VISIBLE ? 28 : 0);
}

const GRID_COLS = 3;

function ProjectGrid({
  projects,
  unclustered
}: {
  projects: ProjectCard[];
  unclustered: UnclusteredItem[];
}) {
  // Greedy bin-packing into three columns: tallest card first, each dropped
  // into whichever column is currently shortest. Three columns (not two)
  // because one card — the multi-thread hero — is roughly twice the height of
  // the long tail of single-thread cards; with only two bins the columns have
  // a hard imbalance floor (~95px ragged edge). Three bins absorb the tall
  // card and end near-even.
  const cards: Array<{ node: React.ReactNode; h: number }> = projects.map((p) => ({
    node: <ProjectCardView key={p.key} p={p} />,
    h: estProjectHeight(p)
  }));
  if (unclustered.length > 0) {
    cards.push({
      node: <UnclusteredCard key="__unclustered" items={unclustered} />,
      h: 84 + unclustered.length * 21
    });
  }
  const cols: React.ReactNode[][] = Array.from({ length: GRID_COLS }, () => []);
  const heights = new Array<number>(GRID_COLS).fill(0);
  for (const c of [...cards].sort((a, b) => b.h - a.h)) {
    let min = 0;
    for (let i = 1; i < GRID_COLS; i++) if (heights[i] < heights[min]) min = i;
    cols[min].push(c.node);
    heights[min] += c.h;
  }
  // 8 cards never divide evenly into 3 columns, so some height spread is
  // unavoidable. Render tallest column first → the residual spread reads as a
  // deliberate left-to-right descending stagger, not a ragged middle bulge.
  const order = heights.map((_, i) => i).sort((a, b) => heights[b] - heights[a]);
  return (
    <section className="grid grid-cols-3 gap-2.5 items-start mb-8">
      {order.map((ci) => (
        <div key={ci} className="space-y-2.5">
          {cols[ci]}
        </div>
      ))}
    </section>
  );
}

function ProjectCardView({ p }: { p: ProjectCard }) {
  const VISIBLE = 4;
  const blocked = p.status === 'blocked';
  const overflow = p.workItems.length - VISIBLE;
  const shown = p.workItems.slice(0, VISIBLE);
  // The whole card is a link into the project detail page — that's where the
  // full thread list lives. A native <Link> gives correct keyboard/focus
  // behavior for free.
  return (
    <Link
      href={`/status/project/${encodeURIComponent(p.key)}`}
      className={`block rounded-xl border px-5 py-4 transition-colors cursor-pointer hover:border-ink-ghost focus-visible:border-ink-ghost ${
        blocked ? 'border-rust bg-rust/[0.035]' : 'border-rule bg-paper-card'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3 mb-3 min-h-[24px]">
        <h3 className="font-serif text-[18px] text-ink leading-tight truncate">{p.name}</h3>
        {/* "active" is the healthy default — mark the exception, not the rule.
            Only blocked / wrapping / dormant earn a badge. */}
        {blocked ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-rust text-white font-medium uppercase tracking-wide shrink-0">
            Blocked
          </span>
        ) : p.status !== 'active' ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-quiet shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${PROJECT_STATUS_DOT[p.status]}`} />
            {PROJECT_STATUS_LABEL[p.status]}
          </span>
        ) : null}
      </div>
      <div className="space-y-1.5">
        {shown.map((it, i) => (
          <div key={i} className="flex items-baseline gap-2.5 min-w-0">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[6px] ${WORK_DOT[it.status]}`}
              title={WORK_LABEL[it.status]}
            />
            <span
              className="text-[13px] text-ink-soft leading-snug line-clamp-2"
              title={it.title}
            >
              {it.title}
            </span>
          </div>
        ))}
      </div>
      {overflow > 0 && (
        <div className="mt-2.5 pl-4 text-[12px] font-medium text-ink-soft">+{overflow} more</div>
      )}
      <div className="flex items-center justify-between mt-3.5 pt-3 border-t border-rule-soft text-[11.5px] text-ink-quiet">
        <span>
          {p.workItems.length > 1 && (
            <>
              {p.workItems.length} threads
              <span className="mx-1.5 text-ink-ghost">·</span>
            </>
          )}
          Claude Code ×{p.ccCount}
        </span>
        <span className="inline-flex items-center gap-1 tabular-nums">
          {ageStr(p.lastActivityAt)}
          <ChevronRight size={13} className="text-ink-ghost" />
        </span>
      </div>
    </Link>
  );
}

function UnclusteredCard({ items }: { items: UnclusteredItem[] }) {
  return (
    <div className="rounded-xl border border-rule bg-paper-card px-5 pt-4 pb-5">
      <div className="eyebrow text-ink-quiet mb-1">Unclustered work · {items.length}</div>
      <p className="text-[12px] text-ink-quiet mb-3">Not tied to a project yet.</p>
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-baseline gap-2.5 min-w-0">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[6px] ${WORK_DOT[it.status]}`}
              title={WORK_LABEL[it.status]}
            />
            <span
              className="text-[13px] text-ink-soft leading-snug line-clamp-2"
              title={it.title}
            >
              {it.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
