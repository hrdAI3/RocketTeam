'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { RefreshCw, MoreHorizontal, ChevronRight, ArrowLeft } from 'lucide-react';

// Project detail — the drill-down from a Workboard project card. A project is
// the unit here: its full thread list (grouped by status), how many Claude Code
// instances are on it, when it last moved. Still anonymous — no member names,
// same as the Workboard glance; this page is "what's the project doing", not
// "who's doing it".

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
  description?: string;
  profile?: ProjectProfile;
}

// §3.6 mirrors lib/projects.ts shapes. Replicated client-side so the page
// doesn't import the server module.
interface ProfileFact {
  value: string;
  evidence: Array<{
    source: string;
    source_id: string;
    quote: string;
    extracted_at: string;
  }>;
  last_evidence_ts: string;
  archived?: boolean;
  superseded_by?: string;
}
interface VocabularyFact extends ProfileFact {
  term: string;
  definition: string;
}
interface KeyPersonFact extends ProfileFact {
  name: string;
  role?: string;
}
interface ProjectProfile {
  vocabulary: VocabularyFact[];
  goals: ProfileFact[];
  key_people: KeyPersonFact[];
  open_questions: ProfileFact[];
}

// Status groups, in the order threads should read: stuck first, done last.
const GROUP_ORDER: WorkItemStatus[] = ['卡住', '进行中', '已完成'];
const GROUP_LABEL: Record<WorkItemStatus, string> = {
  卡住: 'Blocked',
  进行中: 'In progress',
  已完成: 'Done'
};
// On the detail page each thread sits under an explicit status group header,
// so a colored dot is decoded immediately — unlike the Workboard glance, four
// distinct hues are legible here and give the grouped list life.
const WORK_DOT: Record<WorkItemStatus, string> = {
  卡住: 'bg-amber',
  进行中: 'bg-coral',
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

          {/* Threads first — that's what the leader came for. About/Override
              panels sit BELOW so the page reads work-first, not meta-first. */}
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
                    <div key={i} className="flex items-start gap-3 px-5 py-3.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[10px] ${WORK_DOT[it.status]}`}
                      />
                      <div className="min-w-0 flex-1">
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

          <AboutPanel description={d.description} profile={d.profile} />

          <OverridePanel id={id} onApplied={() => void refresh()} />
        </>
      )}
    </div>
  );
}

// §3.4 leader override panel — split / merge / rename. Defaults collapsed so
// the detail page reads as the project view first; expand on demand.
// Server-side validation lives in /api/projects/[id]/override; this UI just
// gates which fields show per kind.
function OverridePanel({ id, onApplied }: { id: string; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'split' | 'merge' | 'rename'>('split');
  const [targetId, setTargetId] = useState('');
  const [newName, setNewName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, string> = { kind, reason };
      if (kind === 'merge') body.target_id = targetId.trim();
      if (kind === 'rename') body.new_name = newName.trim();
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setMsg(data.error ?? `HTTP ${res.status}`);
      } else {
        setMsg('Override saved. Resolver will respect it on the next sync.');
        setReason('');
        setTargetId('');
        setNewName('');
        onApplied();
      }
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-[11px] text-ink-quiet hover:text-ink-soft"
      >
        <MoreHorizontal size={14} />
        {open ? 'Hide leader override' : 'Leader override (split / merge / rename)'}
      </button>
      {open && (
        <div className="mt-3 rounded-xl border border-rule bg-paper-card p-5">
          <p className="text-[11.5px] text-ink-soft leading-relaxed mb-4">
            Tell the resolver this project is mis-shaped. The auto-resolver will
            stop touching it after you save; future passes leave its
            shape alone. The override entry is appended to{' '}
            <code className="font-mono text-[11px] px-1 bg-paper-subtle rounded">projects.json</code>{' '}
            with your reason.
          </p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {(['split', 'merge', 'rename'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`px-3 py-2 rounded-lg border text-[12px] ${
                  kind === k
                    ? 'border-coral bg-coral/[0.08] text-ink'
                    : 'border-rule bg-paper-subtle text-ink-soft hover:bg-paper-card'
                }`}
              >
                {k === 'split' && 'Split (this is two projects)'}
                {k === 'merge' && 'Merge into another'}
                {k === 'rename' && 'Rename'}
              </button>
            ))}
          </div>
          {kind === 'merge' && (
            <label className="block mb-3 text-[12px] text-ink-soft">
              Target project id
              <input
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                placeholder="e.g. matrix"
                className="block w-full mt-1 px-3 py-2 rounded-md border border-rule bg-paper-subtle text-[12.5px] font-mono focus:bg-paper-card focus:border-coral focus:outline-none transition-colors"
              />
            </label>
          )}
          {kind === 'rename' && (
            <label className="block mb-3 text-[12px] text-ink-soft">
              New name
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Display name"
                className="block w-full mt-1 px-3 py-2 rounded-md border border-rule bg-paper-subtle text-[12.5px] focus:bg-paper-card focus:border-coral focus:outline-none transition-colors"
              />
            </label>
          )}
          <label className="block mb-3 text-[12px] text-ink-soft">
            Reason (≤200 chars)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="What did the resolver get wrong?"
              className="block w-full mt-1 px-3 py-2 rounded-md border border-rule bg-paper-subtle text-[12.5px] resize-none focus:bg-paper-card focus:border-coral focus:outline-none transition-colors"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={submit}
              disabled={busy || !reason.trim()}
              className="btn-coral disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Saving…' : 'Save override'}
            </button>
            {msg && (
              <span className="text-[11.5px] text-ink-soft">{msg}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// §3.6 staleness rendering. Each fact's `last_evidence_ts` drives a 4-level
// state: fresh / aging / stale / archived. `archived` skips render entirely.
// Computed at render time — no cron, no background sweep.
type Staleness = 'fresh' | 'aging' | 'stale' | 'archived';
function stalenessOf(iso: string): Staleness {
  const days = (Date.now() - Date.parse(iso)) / 86400000;
  if (!Number.isFinite(days)) return 'stale';
  if (days <= 7) return 'fresh';
  if (days <= 14) return 'aging';
  if (days <= 60) return 'stale';
  return 'archived';
}
const STALENESS_CLASS: Record<Staleness, string> = {
  fresh: '',
  aging: 'opacity-75',
  stale: 'opacity-55',
  archived: 'hidden'
};

function daysAgoLabel(iso: string): string {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(d) || d < 0) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d}d ago`;
}

function AboutPanel({
  description,
  profile
}: {
  description: string | undefined;
  profile: ProjectProfile | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Skip render entirely when there's nothing to show — keeps the detail page
  // clean for projects that haven't been bootstrapped yet.
  const hasProfile =
    !!profile &&
    (profile.vocabulary.length +
      profile.goals.length +
      profile.key_people.length +
      profile.open_questions.length >
      0);
  if (!description && !hasProfile) return null;
  return (
    <section className="mb-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-[12px] text-ink-soft hover:text-ink"
      >
        <ChevronRight
          size={14}
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="eyebrow">About</span>
      </button>
      {open && (
        <div className="mt-3 rounded-xl border border-rule bg-paper-card p-5 space-y-5">
          {description && (
            <p className="text-[12.5px] text-ink-soft leading-relaxed">{description}</p>
          )}
          {profile && profile.goals.length > 0 && (
            <ProfileSection
              title="Goals"
              facts={profile.goals.filter((f) => !f.archived)}
              renderKey={(f) => f.value}
            />
          )}
          {profile && profile.vocabulary.length > 0 && (
            <ProfileSection
              title="Vocabulary"
              facts={profile.vocabulary.filter((f) => !f.archived)}
              renderKey={(f) => `${(f as VocabularyFact).term}：${(f as VocabularyFact).definition}`}
            />
          )}
          {profile && profile.key_people.length > 0 && (
            <ProfileSection
              title="Key people"
              facts={profile.key_people.filter((f) => !f.archived)}
              renderKey={(f) => {
                const kp = f as KeyPersonFact;
                return kp.role ? `${kp.name} · ${kp.role}` : kp.name;
              }}
            />
          )}
          {profile && profile.open_questions.length > 0 && (
            <ProfileSection
              title="Open questions"
              facts={profile.open_questions.filter((f) => !f.archived)}
              renderKey={(f) => f.value}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ProfileSection({
  title,
  facts,
  renderKey
}: {
  title: string;
  facts: ProfileFact[];
  renderKey: (f: ProfileFact) => string;
}) {
  const visible = facts.filter((f) => stalenessOf(f.last_evidence_ts) !== 'archived');
  if (visible.length === 0) return null;
  return (
    <div>
      <div className="eyebrow text-ink-quiet mb-2">{title}</div>
      <ul className="space-y-1.5">
        {visible.map((f, i) => {
          const sta = stalenessOf(f.last_evidence_ts);
          return (
            <li
              key={i}
              className={`text-[12.5px] text-ink-soft leading-relaxed flex items-baseline gap-2 ${STALENESS_CLASS[sta]}`}
            >
              <span className="text-ink-ghost shrink-0 mt-[2px]">·</span>
              <span className="flex-1">{renderKey(f)}</span>
              {sta === 'stale' && (
                <span className="text-[10.5px] text-ink-quiet shrink-0">
                  last evidence {daysAgoLabel(f.last_evidence_ts)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
