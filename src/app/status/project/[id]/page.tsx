'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';

// Project detail — the drill-down from a Workboard project card. A project is
// the unit here: its full thread list (grouped by status), how many Claude Code
// instances are on it, when it last moved. Still anonymous — no member names,
// same as the Workboard glance; this page is "what's the project doing", not
// "who's doing it".

type WorkItemStatus = '进行中' | '卡住' | '调研中' | '已完成';
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

// Status groups, in the order threads should read: stuck first, done last.
const GROUP_ORDER: WorkItemStatus[] = ['卡住', '进行中', '调研中', '已完成'];
const GROUP_LABEL: Record<WorkItemStatus, string> = {
  卡住: 'Blocked',
  进行中: 'In progress',
  调研中: 'Investigating',
  已完成: 'Done'
};
// On the detail page each thread sits under an explicit status group header,
// so a colored dot is decoded immediately — unlike the Workboard glance, four
// distinct hues are legible here and give the grouped list life.
const WORK_DOT: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber',
  进行中: 'bg-coral',
  调研中: 'bg-sky',
  已完成: 'bg-forest'
};

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

function ageStr(iso: string | null): string {
  if (!iso) return 'never';
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 60 / 24)}d ago`;
}

export default function ProjectDetailPage() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id ?? ''));
  const [d, setD] = useState<ProjectCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workboard/project/${encodeURIComponent(id)}`, {
        cache: 'no-store'
      });
      if (res.status === 404) {
        setError('Project not found');
        return;
      }
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setD((await res.json()) as ProjectCard);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.title = `${id} · Workboard · Rocket Team`;
  }, [id]);

  const groups = GROUP_ORDER.map((status) => ({
    status,
    label: GROUP_LABEL[status],
    items: (d?.workItems ?? []).filter((it) => it.status === status)
  })).filter((g) => g.items.length > 0);

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <div className="eyebrow mb-6">
        Rocket Team /{' '}
        <Link href="/status" className="hover:text-ink-muted transition-colors">
          Workboard
        </Link>{' '}
        / {id}
      </div>

      {error && (
        <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-16 text-center">
          <p className="font-serif text-[18px] text-ink mb-1.5">{error}</p>
          <Link href="/status" className="text-[13px] link-coral">
            Back to Workboard
          </Link>
        </div>
      )}

      {loading && !d && (
        <div className="h-40 rounded-xl border border-rule bg-paper-card animate-pulse" />
      )}

      {d && (
        <>
          <header className="flex items-start justify-between gap-4 mb-8">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="display-title">{d.name}</h1>
                {d.status === 'blocked' ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-rust text-white font-medium uppercase tracking-wide shrink-0">
                    Blocked
                  </span>
                ) : d.status !== 'active' ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-quiet shrink-0">
                    <span className={`w-1.5 h-1.5 rounded-full ${PROJECT_STATUS_DOT[d.status]}`} />
                    {PROJECT_STATUS_LABEL[d.status]}
                  </span>
                ) : null}
              </div>
              <p className="text-[13px] text-ink-quiet mt-2">
                {d.workItems.length} thread{d.workItems.length === 1 ? '' : 's'}
                <span className="mx-1.5 text-ink-ghost">·</span>
                Claude Code ×{d.ccCount}
                <span className="mx-1.5 text-ink-ghost">·</span>
                last active {ageStr(d.lastActivityAt)}
              </p>
            </div>
            <button
              onClick={refresh}
              aria-label="Refresh"
              className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors shrink-0"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </header>

          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-14 text-center text-ink-quiet text-[13px]">
              No work threads on this project.
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.status} className="mb-6">
                <div className="eyebrow text-ink-quiet mb-2.5">
                  {g.label} · {g.items.length}
                </div>
                <div className="rounded-xl border border-rule bg-paper-card divide-y divide-rule-soft">
                  {g.items.map((it, i) => (
                    <div key={i} className="flex items-baseline gap-3 px-5 py-3.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[7px] ${WORK_DOT[it.status]}`}
                      />
                      <div className="min-w-0">
                        <div className="text-[13.5px] text-ink leading-snug">{it.title}</div>
                        {it.detail && (
                          <div className="text-[12.5px] text-ink-soft leading-relaxed mt-1">
                            {it.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
}
