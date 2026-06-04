'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronRight, AlertTriangle, Clock, ExternalLink, ArrowLeft } from 'lucide-react';

// /status/unclustered — the leader's "act on this" list. Every work thread
// the LLM couldn't tie to a registered GitHub project. The page's job is to
// make the right move obvious for each row:
//   - Register the repo in /sources/github, OR
//   - Tell the operator to tag the work on a tracked repo, OR
//   - Acknowledge it's research/prototype with no repo yet.
//
// Design moves (informed by the leader's "details please" feedback):
//   - Aging items (≥ 24h) get visual urgency — they're the ones the system
//     will DM operators about.
//   - Each row exposes operator + one-line detail + repo hint + age.
//   - Group by severity: 卡住 first, aging next, fresh last.
//   - Empty / loaded states get equal care, no "Loading..." flash.

type WorkItemStatus = '进行中' | '卡住' | '已完成';

interface UnclusteredItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  ownerName: string | null;
  detail: string | null;
  repo: string | null;
  firstSeenAt: string | null;
  ageHours: number | null;
  aging: boolean;
}

interface UnclusteredResponse {
  items: UnclusteredItem[];
  aggregate: {
    total: number;
    blocked: number;
    aging: number;
    fresh: number;
  };
}

const STATUS_LABEL: Record<WorkItemStatus, string> = {
  卡住: 'Blocked',
  进行中: 'In progress',
  已完成: 'Done'
};
const STATUS_PILL: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber/15 text-amber',
  进行中: 'bg-coral/15 text-coral-deep',
  已完成: 'bg-forest/10 text-forest'
};

function ageLabel(hours: number | null): string {
  if (hours === null) return 'just spotted';
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Strip the synthetic "unknown:email:..." prefix the resolver emits when an
// operator hasn't been mapped to a canonical name yet. The raw form is
// noise on the row; the leading mailbox is the actionable identity.
function tidyOwner(name: string | null): string {
  if (!name) return 'Unknown operator';
  const m = name.match(/^unknown:email:(.+)$/);
  if (m) return m[1];
  return name;
}

export default function UnclusteredPage() {
  const [data, setData] = useState<UnclusteredResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/unclustered', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setData((await res.json()) as UnclusteredResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'Unclustered work · Rocket Team';
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const items = data?.items ?? [];
  const blocked = items.filter((i) => i.status === '卡住');
  const aging = items.filter((i) => i.aging && i.status !== '已完成' && i.status !== '卡住');
  const fresh = items.filter((i) => !i.aging && i.status === '进行中');
  const done = items.filter((i) => i.status === '已完成');

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <Link
        href="/status/projects"
        className="inline-flex items-center gap-1.5 text-[12px] text-ink-quiet hover:text-ink-muted transition-colors mb-3"
      >
        <ArrowLeft size={13} />
        Back to All projects
      </Link>
      <div className="eyebrow mb-6">
        Rocket Team /{' '}
        <Link href="/status" className="hover:text-ink-muted transition-colors">
          Workboard
        </Link>{' '}
        /{' '}
        <Link href="/status/projects" className="hover:text-ink-muted transition-colors">
          All projects
        </Link>{' '}
        / Unclustered
      </div>

      <header className="flex items-end justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="display-title">Unclustered work</h1>
          {data && (
            <p className="text-[14px] text-ink-quiet mt-2.5 leading-relaxed max-w-2xl">
              {data.aggregate.total === 0 ? (
                <>Every thread is tied to a registered project. Nothing to do here.</>
              ) : (
                <>
                  <span className="text-ink font-medium">{data.aggregate.total}</span>{' '}
                  thread{data.aggregate.total === 1 ? '' : 's'} not yet tied to a GitHub repo.
                  {data.aggregate.aging > 0 && (
                    <>
                      {' '}
                      <span className="text-amber font-medium">
                        {data.aggregate.aging} aging ≥ 24h
                      </span>
                      {' '}— operators get a Slack ping if not resolved.
                    </>
                  )}
                </>
              )}
            </p>
          )}
        </div>
        <button
          onClick={refresh}
          aria-label="Refresh"
          className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors shrink-0 mb-0.5"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {data && data.aggregate.total > 0 && (
        <div className="flex items-center gap-2 mb-7">
          <Link
            href="/sources/github"
            className="inline-flex items-center gap-1.5 text-[13px] text-coral-deep hover:text-coral transition-colors px-3 py-1.5 rounded-md bg-coral/[0.07] hover:bg-coral/[0.12] border border-coral/15"
          >
            Manage tracked GitHub repos
            <ExternalLink size={12} />
          </Link>
          <span className="text-[12px] text-ink-ghost">
            Adding a repo to tracking auto-attributes future work on it.
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-[14px] text-ink">
          {error}{' '}
          <button onClick={refresh} className="ml-3 link-coral">
            Retry
          </button>
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 rounded-xl border border-rule bg-paper-card animate-pulse"
            />
          ))}
        </div>
      )}

      {data && data.aggregate.total === 0 && (
        <div className="rounded-xl border border-dashed border-forest/40 bg-forest/[0.04] px-8 py-16 text-center">
          <p className="font-serif text-[18px] text-ink">All clear here</p>
          <p className="text-[13px] text-ink-quiet mt-2">
            Every active work thread is tied to a registered GitHub repo.
          </p>
        </div>
      )}

      {data && data.aggregate.total > 0 && (
        <>
          {blocked.length > 0 && (
            <Section
              label="Blocked"
              count={blocked.length}
              tone="rust"
              hint="Stuck threads still without a project home. Resolve the block AND the registration."
            >
              {blocked.map((it) => (
                <Row key={it.id} item={it} />
              ))}
            </Section>
          )}
          {aging.length > 0 && (
            <Section
              label="In progress · aging"
              count={aging.length}
              tone="amber"
              hint="≥ 24h without a project. Operators will be DM'd."
            >
              {aging.map((it) => (
                <Row key={it.id} item={it} />
              ))}
            </Section>
          )}
          {fresh.length > 0 && (
            <Section
              label="In progress · fresh"
              count={fresh.length}
              tone="quiet"
              hint="< 24h. Still in grace period."
            >
              {fresh.map((it) => (
                <Row key={it.id} item={it} />
              ))}
            </Section>
          )}
          {done.length > 0 && (
            <Section
              label="Done"
              count={done.length}
              tone="quiet"
              hint="Already finished. No action needed; will fall off cache."
            >
              {done.map((it) => (
                <Row key={it.id} item={it} />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({
  label,
  count,
  tone,
  hint,
  children
}: {
  label: string;
  count: number;
  tone: 'rust' | 'amber' | 'quiet';
  hint: string;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'rust'
      ? 'text-rust'
      : tone === 'amber'
        ? 'text-amber'
        : 'text-ink-quiet';
  return (
    <section className="mb-7">
      <div className="flex items-baseline gap-2.5 mb-2.5">
        <span className={`eyebrow ${toneClass}`}>{label}</span>
        <span className="eyebrow text-ink-ghost">· {count}</span>
        <span className="text-[12px] text-ink-quiet ml-1">{hint}</span>
      </div>
      <div className="rounded-xl border border-rule bg-paper-card divide-y divide-rule-soft overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function Row({ item }: { item: UnclusteredItem }) {
  const owner = tidyOwner(item.ownerName);
  // The `[name]` page is keyed by canonical name. Synthetic operators (e.g.
  // `unknown:email:foo@bar.com` collapses to `foo@bar.com` after tidy) won't
  // match any roster row → linking them produces a dead 404. Render the email
  // as plain text in that case; keep the link for real canonical names.
  const isLinkable = !!item.ownerName && !item.ownerName.startsWith('unknown:');
  // Done rows are noise on this page — past tense, no action needed. Dim
  // them so severity grouping stays legible.
  const dim = item.status === '已完成';
  // "unattributed 17m ago" reads weird on Done rows ("just spotted, also
  // already done"). Use "closed" for Done — same shape, accurate verb.
  const ageVerb = item.status === '已完成' ? 'closed' : 'unattributed';
  return (
    <div
      className={`px-5 py-4 hover:bg-paper-subtle/40 transition-colors group ${
        dim ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${STATUS_PILL[item.status]}`}
            >
              {STATUS_LABEL[item.status]}
            </span>
            {item.aging && item.status !== '已完成' && (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-amber font-medium">
                <AlertTriangle size={10} strokeWidth={2.5} />
                aging
              </span>
            )}
            {item.repo && (
              <span className="text-[11px] text-ink-quiet font-mono truncate">{item.repo}</span>
            )}
          </div>
          <div className="text-[15px] text-ink leading-snug mb-1">{item.title}</div>
          {item.detail && (
            <p className="text-[13px] text-ink-soft leading-relaxed mt-1.5">{item.detail}</p>
          )}
          <div className="flex items-center gap-3 mt-2.5 text-[11.5px] text-ink-quiet">
            <span className="inline-flex items-center gap-1">
              <Clock size={11} />
              {ageVerb} {ageLabel(item.ageHours)}
            </span>
            <span className="text-ink-ghost">·</span>
            {isLinkable ? (
              <Link
                href={`/team/${encodeURIComponent(owner)}`}
                className="hover:text-ink-muted transition-colors inline-flex items-center gap-1"
              >
                {owner}
                <ChevronRight
                  size={11}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </Link>
            ) : (
              <span title="No canonical mapping for this operator yet">{owner}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
