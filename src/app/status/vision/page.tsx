'use client';

// Vision — the leader's strategic layer, one tier above Goals. Each area is a
// curated strategic bet; the page rolls Goals' LIVE 7d activity up into each
// area (commits / PRs, momentum, trend) and surfaces the two strategic-drift
// signals: "Strategy with no execution" (areas with no active linked goals) and
// "Execution with no strategy" (active goals linked to no area). One fetch to
// /api/vision returns the whole computed view. Goal→area links are owned by the
// goal (goals.json); linking from here POSTs {goal_id, vision_area_id}.

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Plus, Compass, X, Sparkles, Check } from 'lucide-react';

type Momentum = 'active' | 'quiet';
interface LinkedGoal {
  goal_id: string;
  title: string;
  momentum: Momentum;
  at_risk: boolean;
}
interface AreaProgress {
  area_id: string;
  title: string;
  description: string;
  target?: string;
  status: 'active' | 'archived';
  linked_goals: LinkedGoal[];
  commits_7d: number;
  prs_7d: number;
  commits_prev_7d: number;
  trend: 'up' | 'flat' | 'down';
  momentum: Momentum;
  at_risk_count: number;
}
interface OrphanGoal {
  goal_id: string;
  title: string;
  momentum: Momentum;
  at_risk: boolean;
  commits_7d: number;
}
interface VisionView {
  areas: AreaProgress[];
  areas_without_goals: AreaProgress[];
  goals_without_area: OrphanGoal[];
  window_days: 7;
  generated_at: string;
}
interface GoalSuggestion {
  title: string;
  description: string;
  linked_project_ids: string[];
  linked_project_names: string[];
  vision_area_id: string | null;
  vision_area_title: string | null;
  rationale: string;
}
interface SuggestView {
  suggestions: GoalSuggestion[];
  drift_count: number;
  area_gap_count: number;
  generated_at: string;
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
  target: string;
}
const EMPTY_FORM: FormState = { title: '', description: '', target: '' };

export default function VisionPage() {
  const [data, setData] = useState<VisionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [suggest, setSuggest] = useState<SuggestView | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    document.title = 'Vision · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/vision', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setData((await res.json()) as VisionView);
      setSyncedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const openCreate = () => setForm({ ...EMPTY_FORM });
  const openEdit = (a: AreaProgress) =>
    setForm({ id: a.area_id, title: a.title, description: a.description, target: a.target ?? '' });

  const submitForm = async () => {
    if (!form) return;
    if (!form.title.trim()) {
      setError('Area needs a title.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description,
        target: form.target.trim()
      };
      if (form.id) body.id = form.id;
      const res = await fetch('/api/vision', {
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

  const archiveArea = async (areaId: string) => {
    setError(null);
    try {
      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: areaId, status: 'archived' })
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

  // Link (or unlink) a goal to an area — POSTs {goal_id, vision_area_id}. The
  // route writes goals.json (the single source of the link), then we refresh.
  const linkGoal = async (goalId: string, areaId: string) => {
    setError(null);
    try {
      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal_id: goalId, vision_area_id: areaId })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Link failed: ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // AI 提议:on-demand LLM pass over drift + areas → grounded goal proposals.
  const runSuggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const res = await fetch('/api/vision/suggest', { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Suggest failed: ${res.status}`);
      }
      setSuggest((await res.json()) as SuggestView);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  // Accept a proposal → create the goal (tagged vision_area_id) via the existing
  // goals endpoint, drop it from the list, refresh the rolled-up view.
  const acceptSuggestion = async (s: GoalSuggestion, idx: string) => {
    setAccepting(idx);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: s.title,
        description: s.description,
        linked_project_ids: s.linked_project_ids
      };
      if (s.vision_area_id) body.vision_area_id = s.vision_area_id;
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Create failed: ${res.status}`);
      }
      setSuggest((prev) =>
        prev ? { ...prev, suggestions: prev.suggestions.filter((x) => x !== s) } : prev
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAccepting(null);
    }
  };

  const dismissSuggestion = (s: GoalSuggestion) =>
    setSuggest((prev) =>
      prev ? { ...prev, suggestions: prev.suggestions.filter((x) => x !== s) } : prev
    );

  const areas = data?.areas ?? [];
  const noExec = data?.areas_without_goals ?? [];
  const noStrategy = data?.goals_without_area ?? [];

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-3 border-b border-rule-soft pb-4">
        <div>
          <span className="eyebrow">Vision</span>
          <h1 className="display-title mt-2">The strategic bets above the goals</h1>
        </div>
        <div className="flex items-center gap-2.5 shrink-0 pb-1">
          {syncedAt !== null && (
            <span className="text-[11px] text-ink-quiet tabular-nums">{syncedStr(syncedAt)}</span>
          )}
          <button
            onClick={runSuggest}
            disabled={suggesting}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-coral hover:text-coral-deep transition-colors disabled:opacity-50"
            title="AI 读 drift 项目 + 愿景区,提议可执行目标"
          >
            <Sparkles size={14} className={suggesting ? 'animate-pulse' : ''} />
            {suggesting ? '思考中…' : 'AI 提议目标'}
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-coral hover:text-coral-deep transition-colors"
          >
            <Plus size={14} /> New area
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
        <AreaForm
          form={form}
          setForm={setForm}
          saving={saving}
          onSubmit={submitForm}
          onCancel={() => setForm(null)}
        />
      )}

      {suggest && (
        <section className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={13} className="text-coral" />
            <span className="eyebrow text-coral">AI 提议的目标</span>
            <span className="text-[11px] text-ink-quiet">
              {suggest.drift_count} drift 项目 · {suggest.area_gap_count} 个空愿景区
            </span>
            <button
              onClick={() => setSuggest(null)}
              className="ml-auto text-[11.5px] text-ink-quiet hover:text-ink transition-colors"
            >
              收起
            </button>
          </div>
          {suggest.suggestions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-rule bg-paper-card px-6 py-8 text-center">
              <p className="text-[13px] text-ink-muted">
                没有可提议的目标 — drift 项目都已目标化,或暂无 drift 工作可框定。
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {suggest.suggestions.map((s, i) => {
                const idx = `${i}:${s.title}`;
                return (
                  <div key={idx} className="card-surface rounded-xl px-5 py-4 border-l-2 border-l-coral">
                    <div className="flex items-start justify-between gap-3 mb-1.5">
                      <h3 className="display-title text-[16px] leading-tight">{s.title}</h3>
                      {s.vision_area_title ? (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-coral-subtle/40 text-coral shrink-0">
                          → {s.vision_area_title}
                        </span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-paper-subtle text-ink-quiet shrink-0">
                          未归战略区
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <p className="text-[13px] text-ink-quiet leading-snug mb-2">{s.description}</p>
                    )}
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {s.linked_project_names.map((n) => (
                        <span
                          key={n}
                          className="text-[11px] px-2 py-0.5 rounded-full bg-paper-subtle text-ink-soft"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                    {s.rationale && (
                      <p className="text-[11.5px] text-ink-quiet italic mb-3 leading-snug">
                        {s.rationale}
                      </p>
                    )}
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => acceptSuggestion(s, idx)}
                        disabled={accepting === idx}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-coral text-white text-[12px] font-medium hover:bg-coral-deep transition-colors disabled:opacity-50"
                      >
                        <Check size={13} />
                        {accepting === idx ? '建中…' : '建为目标'}
                      </button>
                      <button
                        onClick={() => dismissSuggestion(s)}
                        className="text-[12px] text-ink-quiet hover:text-ink transition-colors"
                      >
                        忽略
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {loading && !data && (
        <div className="space-y-2.5 mt-6">
          <div className="eyebrow text-ink-quiet mb-2">Loading vision…</div>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl border border-rule bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {data && (
        <>
          <section className="mt-6">
            {areas.length === 0 ? (
              <div className="rounded-xl border border-dashed border-rule bg-paper-card px-8 py-14 text-center">
                <p className="font-serif text-[18px] text-ink mb-1.5">No vision areas yet</p>
                <p className="text-[13px] text-ink-muted leading-relaxed max-w-md mx-auto">
                  Define the strategic bets your goals roll up into.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {areas.map((a) => (
                  <AreaCard
                    key={a.area_id}
                    a={a}
                    onEdit={() => openEdit(a)}
                    onArchive={() => archiveArea(a.area_id)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Strategic-drift signal (a) — strategy with no execution ── */}
          <section className="mt-10">
            <div className="eyebrow text-ink-quiet mb-3">Strategy with no execution</div>
            {noExec.length === 0 ? (
              <div className="rounded-xl border border-dashed border-rule bg-paper-card px-6 py-8 text-center">
                <p className="text-[13px] text-ink-muted">Every active area has a goal driving it.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-rule bg-paper-card divide-y divide-rule-soft">
                {noExec.map((a) => (
                  <div key={a.area_id} className="flex items-center gap-4 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[15px] text-ink truncate">{a.title}</div>
                      <div className="text-[11.5px] text-ink-quiet">
                        No active goal is linked to this area.
                      </div>
                    </div>
                    <button
                      onClick={() => openEdit(a)}
                      className="text-[12px] font-medium text-coral hover:text-coral-deep transition-colors shrink-0"
                    >
                      Edit area
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Strategic-drift signal (b) — execution with no strategy ── */}
          <section className="mt-10">
            <div className="eyebrow text-ink-quiet mb-3">Execution with no strategy</div>
            {noStrategy.length === 0 ? (
              <div className="rounded-xl border border-dashed border-rule bg-paper-card px-6 py-8 text-center">
                <p className="text-[13px] text-ink-muted">Every active goal serves a vision area.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-rule bg-paper-card divide-y divide-rule-soft">
                {noStrategy.map((g) => (
                  <div key={g.goal_id} className="flex items-center gap-4 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[15px] text-ink truncate flex items-center gap-2">
                        <span className={'w-1.5 h-1.5 rounded-full shrink-0 ' + (g.momentum === 'active' ? 'bg-coral' : 'bg-ink-ghost')} />
                        {g.title}
                      </div>
                      <div className="text-[11.5px] text-ink-quiet tabular-nums">
                        {g.commits_7d} commit{g.commits_7d === 1 ? '' : 's'}, 7d
                        {g.at_risk && <span className="ml-2 text-rust">⚠ at risk</span>}
                      </div>
                    </div>
                    <label className="text-[11.5px] text-ink-quiet shrink-0">Link to area</label>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) void linkGoal(g.goal_id, e.target.value);
                      }}
                      className="text-[12px] px-2 py-1.5 rounded-md border border-rule bg-paper text-ink outline-none focus:border-coral shrink-0 max-w-[200px]"
                    >
                      <option value="" disabled>
                        Choose area…
                      </option>
                      {areas.map((a) => (
                        <option key={a.area_id} value={a.area_id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
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

function AreaCard({
  a,
  onEdit,
  onArchive
}: {
  a: AreaProgress;
  onEdit: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="card-surface rounded-xl px-5 py-4 flex flex-col">
      <div className="flex items-start justify-between gap-2.5 mb-2">
        <h3 className="display-title text-[18px] leading-tight tracking-[-0.01em]">{a.title}</h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {a.at_risk_count > 0 && (
            <span
              title={`${a.at_risk_count} linked goal(s) at risk`}
              className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-rust text-white shrink-0"
            >
              ⚠ {a.at_risk_count} at risk
            </span>
          )}
          <MomentumPill momentum={a.momentum} />
        </div>
      </div>
      {a.description && (
        <p className="text-[13px] text-ink-quiet leading-snug mb-2 line-clamp-2">{a.description}</p>
      )}
      {a.target && (
        <p className="text-[11.5px] text-ink-soft mb-3 italic">🎯 {a.target}</p>
      )}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {a.linked_goals.length === 0 ? (
          <span className="text-[11px] text-ink-quiet italic">No linked goals</span>
        ) : (
          a.linked_goals.map((g) => (
            <a
              key={g.goal_id}
              href="/status/goals"
              title={g.at_risk ? `${g.title} (at risk)` : g.title}
              className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-coral-subtle/40 text-coral hover:bg-coral-subtle transition-colors"
            >
              <span className={'w-1.5 h-1.5 rounded-full shrink-0 ' + (g.momentum === 'active' ? 'bg-coral' : 'bg-ink-ghost')} />
              {g.title}
            </a>
          ))
        )}
      </div>
      <div className="mt-auto pt-2.5 border-t border-rule-soft flex items-center justify-between gap-2">
        <span className="text-[12px] text-ink-soft tabular-nums inline-flex items-center gap-1.5">
          <TrendArrow trend={a.trend} cur={a.commits_7d} prev={a.commits_prev_7d} />
          {a.commits_7d} commits · {a.prs_7d} PRs · 7d
        </span>
        <span className="text-[11px] text-ink-quiet tabular-nums shrink-0">
          {a.linked_goals.length} goal{a.linked_goals.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-2.5">
        <button onClick={onEdit} className="text-[11.5px] text-ink-quiet hover:text-coral transition-colors">
          Edit
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

function AreaForm({
  form,
  setForm,
  saving,
  onSubmit,
  onCancel
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  saving: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="card-surface rounded-xl px-6 py-5 mb-6 mt-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Compass size={15} className="text-coral" />
          <span className="font-serif text-[16px] text-ink">{form.id ? 'Edit area' : 'New area'}</span>
        </div>
        <button onClick={onCancel} aria-label="Close" className="text-ink-quiet hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <label className="block text-[12px] text-ink-muted mb-1">Title</label>
      <input
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        placeholder="e.g. Own the CN learning market"
        className="w-full mb-3 px-3 py-2 rounded-md border border-rule bg-paper text-body text-ink outline-none focus:border-coral"
      />
      <label className="block text-[12px] text-ink-muted mb-1">Description</label>
      <textarea
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        rows={2}
        placeholder="Optional context — why this bet matters"
        className="w-full mb-3 px-3 py-2 rounded-md border border-rule bg-paper text-body text-ink outline-none focus:border-coral resize-none"
      />
      <label className="block text-[12px] text-ink-muted mb-1">North star (optional)</label>
      <input
        value={form.target}
        onChange={(e) => setForm({ ...form, target: e.target.value })}
        placeholder='e.g. "10k weekly active by Q4"'
        className="w-full mb-4 px-3 py-2 rounded-md border border-rule bg-paper text-body text-ink outline-none focus:border-coral"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={onSubmit}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-coral text-white text-[13px] font-medium hover:bg-coral-deep transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create area'}
        </button>
        <button onClick={onCancel} className="text-[13px] text-ink-quiet hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}
