'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronRight, ChevronDown, ArrowLeft } from 'lucide-react';

// Workboard / All projects — the drill-down from `/status`. Tracked projects
// in flight (blocked + active in last 72h + wrapping / dormant), 3-column
// grid. Untracked work clustered into per-inferred-project summary cards
// (UNTRACKED pill), each linking to /status/unclustered for the per-item
// action list. Cards carry an Owner line so the leader knows who to ping.

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
  owner: string | null;
}
interface UntrackedProject {
  key: string;
  name: string;
  owner: string | null;
  workItems: DemoWorkItem[];
  ccCount: number;
  lastActivityAt: string | null;
}
interface UnclusteredItem {
  title: string;
  status: WorkItemStatus;
}
interface WorkboardView {
  projects: ProjectCard[];
  unclustered: UnclusteredItem[];
  untrackedProjects: UntrackedProject[];
  anomalies: unknown[];
  aggregate: { totalProjects: number; stuck: number };
}

const WORK_DOT: Record<WorkItemStatus, string> = {
  卡住: 'bg-rust',
  进行中: 'bg-ink-quiet',
  已完成: 'bg-forest'
};
const WORK_LABEL: Record<WorkItemStatus, string> = {
  卡住: 'Blocked',
  进行中: 'In progress',
  已完成: 'Done'
};
const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  blocked: 'Blocked',
  active: 'Active',
  wrapping: 'Wrapping up',
  dormant: 'Dormant'
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

const CARD_VISIBLE = 3;
// Card grid uses a fixed row height so all cards align. 232px gives room for
// title + 3 work items + owner row + metadata footer without truncating the
// owner line (the previous 200px squeezed Owner into the footer → ellipsis).
const CARD_ROW_HEIGHT = 'auto-rows-[232px]';
const RECENT_MS = 72 * 60 * 60 * 1000;

export default function AllProjectsPage() {
  const [data, setData] = useState<WorkboardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    document.title = 'All projects · Rocket Team';
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

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const [showOlder, setShowOlder] = useState(false);

  const projects = data?.projects ?? [];
  const untrackedProjects = data?.untrackedProjects ?? [];
  const agg = data?.aggregate;

  const isRecent = (iso: string | null): boolean =>
    iso !== null && Date.now() - Date.parse(iso) < RECENT_MS;
  const sortFn = (a: ProjectCard, b: ProjectCard): number => {
    const aB = a.status === 'blocked' ? 0 : 1;
    const bB = b.status === 'blocked' ? 0 : 1;
    if (aB !== bB) return aB - bB;
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return tb - ta;
  };
  const visibleProjects = projects
    .filter((p) => p.status === 'blocked' || isRecent(p.lastActivityAt))
    .sort(sortFn);
  const olderProjects = projects
    .filter((p) => p.status !== 'blocked' && !isRecent(p.lastActivityAt))
    .sort(sortFn);
  const hiddenCount = olderProjects.length;

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <Link
        href="/status"
        className="inline-flex items-center gap-1.5 text-[12px] text-ink-quiet hover:text-ink-muted transition-colors mb-3"
      >
        <ArrowLeft size={13} />
        Back to Workboard
      </Link>
      <header className="flex items-end justify-between gap-4 mb-3">
        <div>
          <div className="eyebrow mb-2">
            Rocket Team /{' '}
            <Link href="/status" className="hover:text-ink-muted transition-colors">
              Workboard
            </Link>{' '}
            / All projects
          </div>
          <h1 className="display-title">All projects</h1>
          {agg && (
            <p className="text-[13px] text-ink-quiet mt-2">
              {agg.totalProjects} project{agg.totalProjects === 1 ? '' : 's'} tracked
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

      {loading && !data && (
        <div className="space-y-2.5">
          <div className="eyebrow text-ink-quiet mb-2">Loading projects…</div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl border border-rule bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {data && visibleProjects.length > 0 && (
        <>
          <section className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ${CARD_ROW_HEIGHT} gap-3 mb-3.5`}>
            {visibleProjects.map((p) => (
              <ProjectCardView key={p.key} p={p} />
            ))}
          </section>
          {hiddenCount > 0 && (
            <>
              <button
                onClick={() => setShowOlder((v) => !v)}
                className="text-[12px] text-ink-quiet hover:text-ink-muted transition-colors mb-3 inline-flex items-center gap-1"
              >
                <ChevronDown
                  size={12}
                  className={`transition-transform duration-150 ${showOlder ? 'rotate-180' : ''}`}
                />
                {showOlder
                  ? `Hide ${hiddenCount} older`
                  : `Show ${hiddenCount} older project${hiddenCount === 1 ? '' : 's'} (no activity in 72h)`}
              </button>
              {showOlder && (
                <section className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ${CARD_ROW_HEIGHT} gap-3 mb-8 opacity-75`}>
                  {olderProjects.map((p) => (
                    <ProjectCardView key={p.key} p={p} />
                  ))}
                </section>
              )}
            </>
          )}
        </>
      )}

      {data && untrackedProjects.length > 0 && (
        <section className="mt-8">
          <div className="eyebrow text-ink-quiet mb-3">
            Untracked work · {untrackedProjects.length}
          </div>
          <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ${CARD_ROW_HEIGHT} gap-3`}>
            {untrackedProjects.map((p) => (
              <UntrackedCardView key={p.key} p={p} />
            ))}
          </div>
        </section>
      )}

      {data && projects.length === 0 && untrackedProjects.length === 0 && (
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

// Owner line — its own row above the metadata footer so it never collides
// with `N threads · Claude Code ×N · age` and gets ellipsis'd.
function OwnerRow({ owner }: { owner: string | null }) {
  if (!owner) return null;
  return (
    <div className="mt-2 text-[11.5px] text-ink-soft truncate">
      <span className="text-ink-quiet">Owner</span> {owner}
    </div>
  );
}

function CardBody({
  workItems
}: {
  workItems: DemoWorkItem[];
}) {
  const overflow = workItems.length - CARD_VISIBLE;
  const shown = workItems.slice(0, CARD_VISIBLE);
  return (
    <div className="space-y-1.5 flex-1 min-h-0">
      {shown.map((it, i) => (
        <div key={i} className="flex items-start gap-2.5 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[7px] ${WORK_DOT[it.status]}`}
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
      {overflow > 0 && (
        <div className="pl-4 text-[12px] font-medium text-ink-soft">+{overflow} more</div>
      )}
    </div>
  );
}

function CardFooter({
  ccCount,
  threadCount,
  lastActivityAt,
  showChevron
}: {
  ccCount: number;
  threadCount: number;
  lastActivityAt: string | null;
  showChevron: boolean;
}) {
  return (
    <div className="flex items-center justify-between mt-2 pt-2.5 border-t border-rule-soft text-[11.5px] text-ink-quiet gap-2">
      <span className="truncate">
        {threadCount > 1 && (
          <>
            {threadCount} threads
            <span className="mx-1.5 text-ink-ghost">·</span>
          </>
        )}
        Claude Code ×{ccCount}
      </span>
      <span className="inline-flex items-center gap-1 tabular-nums shrink-0">
        {ageStr(lastActivityAt)}
        {showChevron && <ChevronRight size={13} className="text-ink-ghost" />}
      </span>
    </div>
  );
}

function ProjectCardView({ p }: { p: ProjectCard }) {
  const blocked = p.status === 'blocked';
  return (
    <Link
      href={`/status/project/${encodeURIComponent(p.key)}`}
      className={`lift group relative block rounded-xl border px-5 py-4 cursor-pointer h-full flex flex-col ${
        blocked
          ? 'border-coral/50 bg-rust/[0.035] hover:bg-rust/[0.07]'
          : 'border-rule bg-paper-card hover:border-rule-strong'
      } focus-visible:border-coral`}
    >
      <div className="flex items-baseline justify-between gap-2.5 mb-3 min-h-[24px]">
        <h3 className="font-serif text-[17px] text-ink leading-tight tracking-[-0.01em] truncate">
          {p.name}
        </h3>
        {blocked ? (
          <span className="font-mono text-[9.5px] px-2.5 py-0.5 rounded-full bg-rust text-white font-medium uppercase tracking-[0.06em] shrink-0">
            Blocked
          </span>
        ) : p.status !== 'active' ? (
          <span
            className={`font-mono text-[9.5px] uppercase tracking-[0.06em] font-medium shrink-0 ${
              p.status === 'wrapping' ? 'text-forest' : 'text-ink-quiet'
            }`}
          >
            {PROJECT_STATUS_LABEL[p.status]}
          </span>
        ) : null}
      </div>
      <CardBody workItems={p.workItems} />
      <OwnerRow owner={p.owner} />
      <CardFooter
        ccCount={p.ccCount}
        threadCount={p.workItems.length}
        lastActivityAt={p.lastActivityAt}
        showChevron
      />
    </Link>
  );
}

function UntrackedCardView({ p }: { p: UntrackedProject }) {
  // Drill into the per-item action list filtered to this inferred project.
  // /status/unclustered already shows ownerName + detail + age per row; the
  // ?focus=<key> hint lets that page highlight / scroll to the matching rows.
  return (
    <Link
      href={`/status/unclustered?focus=${encodeURIComponent(p.key)}`}
      className="lift group relative block rounded-xl border border-amber/40 bg-amber/[0.04] px-5 py-4 cursor-pointer h-full flex flex-col hover:bg-amber/[0.07] hover:border-amber/60 focus-visible:border-amber"
    >
      <div className="flex items-baseline justify-between gap-2.5 mb-3 min-h-[24px]">
        <h3 className="font-serif text-[17px] text-ink leading-tight tracking-[-0.01em] truncate">
          {p.name}
        </h3>
        <span className="font-mono text-[9.5px] px-2.5 py-0.5 rounded-full bg-amber/20 text-amber font-medium uppercase tracking-[0.06em] shrink-0">
          Untracked
        </span>
      </div>
      <CardBody workItems={p.workItems} />
      <OwnerRow owner={p.owner} />
      <CardFooter
        ccCount={p.ccCount}
        threadCount={p.workItems.length}
        lastActivityAt={p.lastActivityAt}
        showChevron
      />
    </Link>
  );
}
