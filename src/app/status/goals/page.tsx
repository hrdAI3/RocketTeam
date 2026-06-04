'use client';

// Goals — the leader's objective layer. Each goal is a curated title + the
// projects that serve it; the page shows LIVE 7d activity (commits / PRs / live
// runs) and a grounded momentum pill (active|quiet), never a synthesized
// percentage. Below the goals: Drift — active projects with real recent commits
// that serve no goal, so the leader either frames them as a goal or consciously
// deprioritizes. One fetch to /api/goals returns the whole computed view.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Plus, Target, X } from 'lucide-react';

type Momentum = 'active' | 'quiet';
interface LinkedProject {
  id: string;
  name: string;
  active: boolean;
}
interface GoalProgress {
  goal_id: string;
  title: string;
  description: string;
  status: 'active' | 'archived';
  linked_projects: LinkedProject[];
  commits_7d: number;
  prs_7d: number;
  live_runs: number;
  last_activity_at: string | null;
  momentum: Momentum;
  commits_prev_7d: number;
  trend: 'up' | 'flat' | 'down';
  at_risk: boolean;
  at_risk_reason: string | null;
}
interface DriftItem {
  project_id: string;
  name: string;
  commits_7d: number;
  last_commit_at: string | null;
}
interface GoalsView {
  goals: GoalProgress[];
  drift: DriftItem[];
  window_days: 7;
  generated_at: string;
}
interface ProjectOption {
  id: string;
  name: string;
}

// All display timestamps are Beijing (UTC+8) per project convention; storage
// stays UTC. Relative phrasing for recency.
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

interface FormState {
  id?: string; // present → edit mode
  title: string;
  description: string;
  linked: Set<string>;
  target: string;
}
const EMPTY_FORM: FormState = { title: '', description: '', linked: new Set(), target: '' };

export default function GoalsPage() {
  const [data, setData] = useState<GoalsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [, forceTick] = useState(0);

  useEffect(() => {
    document.title = 'Goals · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/goals', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setData((await res.json()) as GoalsView);
      setSyncedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Active project options for the form's multi-select. Reuse the project index
  // /api/team/context already builds; drop archived + virtual (un-attributable)
  // ids so a link always validates server-side.
  const loadProjects = useCallback(async () => {
    try {
      const ctx = await fetch('/api/team/context', { cache: 'no-store' }).then((r) => r.json());
      const opts: ProjectOption[] = ((ctx.projects ?? []) as Array<{ id: string; name: string; status?: string }>)
        .filter((p) => p.id && p.name && p.status === 'active' && !p.id.startsWith('virtual:'))
        .map((p) => ({ id: p.id, name: p.name }));
      setProjectOptions(opts);
    } catch {
      setProjectOptions([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadProjects();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh, loadProjects]);

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectOptions) m.set(p.id, p.name);
    return m;
  }, [projectOptions]);

  const openCreate = (seedProjectId?: string, seedTitle?: string) => {
    setForm({
      ...EMPTY_FORM,
      title: seedTitle ?? '',
      linked: new Set(seedProjectId ? [seedProjectId] : [])
    });
  };
  const openEdit = (g: GoalProgress) => {
    setForm({
      id: g.goal_id,
      title: g.title,
      description: g.description,
      linked: new Set(g.linked_projects.map((p) => p.id)),
      target: ''
    });
  };

  const submitForm = async () => {
    if (!form) return;
    if (!form.title.trim() || form.linked.size < 1) {
      setError('Goal needs a title and at least one linked project.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description,
        linked_project_ids: [...form.linked]
      };
      if (form.id) body.id = form.id;
      if (form.target.trim()) body.target = form.target.trim();
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Save failed: ${res.status}`);
      }
      setForm(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const archiveGoal = async (goalId: string) => {
    setError(null);
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: goalId, status: 'archived' })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Archive failed: ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const goals = data?.goals ?? [];
  const drift = data?.drift ?? [];

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-3 border-b border-rule-soft pb-4">
        <div>
          <span className="eyebrow">Goals</span>
          <h1 className="display-title mt-2">What the team is driving toward</h1>
        </div>
        <div className="flex items-center gap-2.5 shrink-0 pb-1">
          {syncedAt !== null && (
            <span className="text-[11px] text-ink-quiet tabular-nums">{syncedStr(syncedAt)}</span>
          )}
          <button
            onClick={() => openCreate()}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-coral hover:text-coral-deep transition-colors"
          >
            <Plus size={14} /> New goal
          </button>
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
          <button onClick={() => setError(null)} className="ml-3 link-coral">
            Dismiss
          </button>
        </div>
      )}

      {form && (
        <GoalForm
          form={form}
          setForm={setForm}
          options={projectOptions}
          saving={saving}
          onSubmit={submitForm}
          onCancel={() => setForm(null)}
        />
      )}

      {loading && !data && (
        <div className="space-y-2.5 mt-6">
          <div className="eyebrow text-ink-quiet mb-2">Loading goals…</div>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl border border-rule bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {data && (
        <>
          <section className="mt-6">
            {goals.length === 0 ? (
              <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-14 text-center">
                <p className="font-serif text-[18px] text-ink mb-1.5">No goals yet</p>
                <p className="text-[13px] text-ink-muted leading-relaxed max-w-md mx-auto">
                  Define what the team is driving toward.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {goals.map((g) => (
                  <GoalCard
                    key={g.goal_id}
                    g={g}
                    onEdit={() => openEdit(g)}
                    onArchive={() => archiveGoal(g.goal_id)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="mt-10">
            <div className="eyebrow text-ink-quiet mb-3">Drift · unassigned active work</div>
            {drift.length === 0 ? (
              <div className="rounded-xl border border-dashed border-rule bg-paper-card px-6 py-8 text-center">
                <p className="text-[13px] text-ink-muted">Every active project serves a goal.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-rule bg-paper-card divide-y divide-rule-soft">
                {drift.map((d) => (
                  <div key={d.project_id} className="flex items-center gap-4 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[15px] text-ink truncate">{d.name}</div>
                      <div className="text-[11.5px] text-ink-quiet tabular-nums">
                        {d.commits_7d} commit{d.commits_7d === 1 ? '' : 's'}, 7d
                        <span className="mx-1.5 text-ink-ghost">·</span>
                        {ageStr(d.last_commit_at)}
                      </div>
                    </div>
                    <button
                      onClick={() => openCreate(d.project_id, d.name)}
                      className="text-[12px] font-medium text-coral hover:text-coral-deep transition-colors shrink-0"
                    >
                      Create goal
                    </button>
                    <span
                      title="Deprioritize is coming in a later version — for now, frame it as a goal or leave it."
                      className="text-[12px] text-ink-quiet cursor-help shrink-0"
                    >
                      Deprioritize
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function GoalCard({
  g,
  onEdit,
  onArchive
}: {
  g: GoalProgress;
  onEdit: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="card-surface rounded-xl px-5 py-4 flex flex-col">
      <div className="flex items-start justify-between gap-2.5 mb-2">
        <h3 className="display-title text-[18px] leading-tight tracking-[-0.01em]">{g.title}</h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {g.at_risk && (
            <span
              title={g.at_risk_reason ?? ''}
              className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-rust text-white shrink-0"
            >
              ⚠ at risk
            </span>
          )}
          <MomentumPill momentum={g.momentum} />
        </div>
      </div>
      {g.description && (
        <p className="text-[13px] text-ink-quiet leading-snug mb-3 line-clamp-2">{g.description}</p>
      )}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {g.linked_projects.map((p) => (
          <span
            key={p.id}
            className={
              'text-[11px] px-2 py-0.5 rounded-full ' +
              (p.active
                ? 'bg-coral-subtle/40 text-coral'
                : 'bg-paper-subtle text-ink-quiet line-through')
            }
            title={p.active ? p.name : `${p.name} (archived — not counted)`}
          >
            {p.name}
          </span>
        ))}
      </div>
      <div className="mt-auto pt-2.5 border-t border-rule-soft flex items-center justify-between gap-2">
        <span className="text-[12px] text-ink-soft tabular-nums inline-flex items-center gap-1.5">
          <TrendArrow trend={g.trend} cur={g.commits_7d} prev={g.commits_prev_7d} />
          {g.commits_7d} commits · {g.prs_7d} PRs · {g.live_runs} live · 7d
        </span>
        <span className="text-[11px] text-ink-quiet tabular-nums shrink-0">
          {ageStr(g.last_activity_at)}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-2.5">
        <button onClick={onEdit} className="text-[11.5px] text-ink-quiet hover:text-coral transition-colors">
          Edit / Link
        </button>
        <button onClick={onArchive} className="text-[11.5px] text-ink-quiet hover:text-rust transition-colors">
          Archive
        </button>
      </div>
    </div>
  );
}

function TrendArrow({
  trend,
  cur,
  prev
}: {
  trend: 'up' | 'flat' | 'down';
  cur: number;
  prev: number;
}) {
  const glyph = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '→';
  const color = trend === 'up' ? 'text-coral' : trend === 'down' ? 'text-rust' : 'text-ink-quiet';
  return (
    <span className={`${color} shrink-0`} title={`本周 ${cur} · 上周 ${prev} commit`}>
      {glyph}
    </span>
  );
}

function MomentumPill({ momentum }: { momentum: Momentum }) {
  if (momentum === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full bg-coral text-white shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-white" />
        active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full bg-paper-subtle text-ink-quiet shrink-0">
      quiet
    </span>
  );
}

function GoalForm({
  form,
  setForm,
  options,
  saving,
  onSubmit,
  onCancel
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  options: ProjectOption[];
  saving: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(form.linked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setForm({ ...form, linked: next });
  };
  return (
    <div className="card-surface rounded-xl px-6 py-5 mb-6 mt-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Target size={15} className="text-coral" />
          <span className="font-serif text-[16px] text-ink">{form.id ? 'Edit goal' : 'New goal'}</span>
        </div>
        <button onClick={onCancel} aria-label="Close" className="text-ink-quiet hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <label className="block text-[12px] text-ink-muted mb-1">Title</label>
      <input
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        placeholder="e.g. Ship PMA v2"
        className="w-full mb-3 px-3 py-2 rounded-md border border-rule bg-paper text-body text-ink outline-none focus:border-coral"
      />
      <label className="block text-[12px] text-ink-muted mb-1">Description</label>
      <textarea
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        rows={2}
        placeholder="Optional context"
        className="w-full mb-3 px-3 py-2 rounded-md border border-rule bg-paper text-body text-ink outline-none focus:border-coral resize-none"
      />
      <label className="block text-[12px] text-ink-muted mb-1">Target (optional)</label>
      <input
        value={form.target}
        onChange={(e) => setForm({ ...form, target: e.target.value })}
        placeholder='e.g. "ship v2 by Jun 30"'
        className="w-full mb-3 px-3 py-2 rounded-md border border-rule bg-paper text-body text-ink outline-none focus:border-coral"
      />
      <label className="block text-[12px] text-ink-muted mb-1.5">
        Linked projects <span className="text-ink-quiet">(at least 1)</span>
      </label>
      <div className="max-h-44 overflow-y-auto rounded-md border border-rule bg-paper p-2 mb-4 space-y-0.5">
        {options.length === 0 ? (
          <div className="text-[12px] text-ink-quiet px-1 py-1">No active projects available.</div>
        ) : (
          options.map((p) => (
            <label
              key={p.id}
              className="flex items-center gap-2.5 px-2 py-1 rounded hover:bg-paper-subtle cursor-pointer"
            >
              <input
                type="checkbox"
                checked={form.linked.has(p.id)}
                onChange={() => toggle(p.id)}
                className="accent-coral"
              />
              <span className="text-[13px] text-ink truncate">{p.name}</span>
            </label>
          ))
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onSubmit}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-coral text-white text-[13px] font-medium hover:bg-coral-deep transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create goal'}
        </button>
        <button onClick={onCancel} className="text-[13px] text-ink-quiet hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}
