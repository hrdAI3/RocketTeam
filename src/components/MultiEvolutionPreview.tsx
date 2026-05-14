'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, X, ChevronDown, ChevronUp } from 'lucide-react';
import { Avatar } from './Avatar';
import type { Department } from '@/types';

interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
  old?: unknown;
}
interface AgentDiff {
  agent_name: string;
  patches: PatchOp[];
  human_summary: string[];
}

interface MultiPreviewProps {
  open: boolean;
  context: string;
  deptMap: Record<string, Department>;
  onClose: () => void;
  onApplied: () => void;
}

interface ProgressState {
  candidates: string[];
  current?: string;
  done: boolean;
  diffs: AgentDiff[];
  noChange: string[];
  errors: Record<string, string>;
  fatal?: string;
}

export function MultiEvolutionPreview({
  open,
  context,
  deptMap,
  onClose,
  onApplied
}: MultiPreviewProps) {
  const [state, setState] = useState<ProgressState>({
    candidates: [],
    done: false,
    diffs: [],
    noChange: [],
    errors: {}
  });
  const [applyingAll, setApplyingAll] = useState(false);

  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setState({ candidates: [], done: false, diffs: [], noChange: [], errors: {} });
    setApplied(new Set());
    setExpanded(new Set());

    (async () => {
      try {
        const res = await fetch('/api/evolution/multi-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context }),
          signal: ctrl.signal
        });
        if (!res.ok || !res.body) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          setState((s) => ({ ...s, fatal: err.error ?? `Request failed ${res.status}`, done: true }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (event === 'start') {
                setState((s) => ({ ...s, candidates: parsed.candidates as string[] }));
              } else if (event === 'candidate') {
                setState((s) => ({ ...s, current: parsed.agent_name as string }));
              } else if (event === 'diff') {
                const d = parsed.diff as AgentDiff;
                setState((s) => ({ ...s, diffs: [...s.diffs, d] }));
                setExpanded((e) => new Set([...e, d.agent_name]));
              } else if (event === 'no_change') {
                setState((s) => ({ ...s, noChange: [...s.noChange, parsed.agent_name as string] }));
              } else if (event === 'agent_error') {
                setState((s) => ({
                  ...s,
                  errors: { ...s.errors, [parsed.agent_name as string]: parsed.error as string }
                }));
              } else if (event === 'done') {
                setState((s) => ({ ...s, done: true, current: undefined }));
              }
            } catch {
              /* skip */
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setState((s) => ({ ...s, fatal: (err as Error).message, done: true }));
      }
    })();

    return () => ctrl.abort();
  }, [open, context]);

  const applyOne = async (diff: AgentDiff) => {
    if (applied.has(diff.agent_name)) return;
    const res = await fetch('/api/evolution?action=apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diff)
    });
    if (res.ok) setApplied((s) => new Set([...s, diff.agent_name]));
  };

  const applyAll = async () => {
    setApplyingAll(true);
    for (const d of state.diffs) {
      if (!applied.has(d.agent_name)) {
        // eslint-disable-next-line no-await-in-loop
        await applyOne(d);
      }
    }
    setApplyingAll(false);
    onApplied();
  };

  if (!open) return null;

  const total = state.candidates.length;
  const reviewed =
    state.diffs.length + state.noChange.length + Object.keys(state.errors).length;
  const allApplied = state.diffs.length > 0 && state.diffs.every((d) => applied.has(d.agent_name));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="card-warm shadow-modal w-[920px] max-h-[85vh] flex flex-col animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-rule flex items-start justify-between">
          <div>
            <h2 className="font-serif text-[18px] text-ink leading-tight">Profile update preview</h2>
            <p className="text-caption text-ink-quiet leading-tight mt-0.5">
              The system has scanned every relevant member. Each change requires your confirmation before it&apos;s written.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-quiet hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {/* Progress */}
        <div className="px-6 py-3 border-b border-rule-soft flex items-center gap-3">
          {!state.done ? (
            <>
              <Loader2 size={14} className="text-coral animate-spin" />
              <div className="text-[13px] text-ink-soft">
                {state.current ? (
                  <>
                    Analyzing profile changes for <span className="font-serif text-ink">{state.current}</span>…
                  </>
                ) : (
                  'Selecting affected members…'
                )}
              </div>
              <span className="ml-auto font-mono text-[11px] text-ink-quiet">
                {reviewed} / {total > 0 ? total : '?'}
              </span>
            </>
          ) : (
            <>
              <Check size={14} className="text-forest" />
              <div className="text-[13px] text-ink-soft">
                Scan complete · {state.diffs.length} member{state.diffs.length === 1 ? '' : 's'} to update · {state.noChange.length} unchanged
              </div>
              {state.diffs.length > 0 && !allApplied && (
                <button
                  onClick={applyAll}
                  disabled={applyingAll}
                  className="btn-coral text-caption ml-auto"
                >
                  {applyingAll ? 'Applying…' : `Apply all (${state.diffs.length})`}
                </button>
              )}
              {allApplied && (
                <span className="ml-auto text-[12px] text-forest font-medium">All applied</span>
              )}
            </>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {state.fatal && (
            <div className="text-body text-rust">{state.fatal}</div>
          )}

          {state.diffs.length === 0 && state.done && !state.fatal && (
            <div className="text-body text-ink-muted">
              No member profiles were affected by this content. Try pasting a more specific observation.
            </div>
          )}

          {state.diffs.map((d) => {
            const isOpen = expanded.has(d.agent_name);
            const isApplied = applied.has(d.agent_name);
            return (
              <article
                key={d.agent_name}
                className="card-surface mb-3 overflow-hidden animate-fade-in"
              >
                <header
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-paper-subtle/40"
                  onClick={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(d.agent_name)) n.delete(d.agent_name);
                      else n.add(d.agent_name);
                      return n;
                    })
                  }
                >
                  <Avatar name={d.agent_name} dept={deptMap[d.agent_name]} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="font-serif text-[15px] text-ink leading-tight">
                      {d.agent_name}
                    </div>
                    <div className="text-[11px] text-ink-quiet leading-tight mt-0.5">
                      {d.human_summary.length > 0 ? d.human_summary[0] : `${d.patches.length} field change${d.patches.length === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <span className="text-[10.5px] font-mono text-ink-quiet shrink-0">
                    {d.patches.length} change{d.patches.length === 1 ? '' : 's'}
                  </span>
                  {isApplied ? (
                    <span className="text-[11px] text-forest font-medium shrink-0 inline-flex items-center gap-1">
                      <Check size={11} /> Applied
                    </span>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void applyOne(d);
                      }}
                      className="btn-coral text-caption shrink-0"
                    >
                      Apply
                    </button>
                  )}
                  {isOpen ? (
                    <ChevronUp size={14} className="text-ink-quiet" />
                  ) : (
                    <ChevronDown size={14} className="text-ink-quiet" />
                  )}
                </header>

                {isOpen && (
                  <div className="px-4 py-3 border-t border-rule-soft bg-paper-subtle/40">
                    {d.human_summary.length > 0 && (
                      <ul className="text-body text-ink-soft list-disc pl-5 mb-3 space-y-1">
                        {d.human_summary.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    )}
                    <div className="rounded-md bg-paper-card border border-rule-soft p-3 space-y-2">
                      {d.patches.map((p, i) => (
                        <DiffRow
                          key={i}
                          op={p.op}
                          path={p.path}
                          oldVal={p.old}
                          newVal={p.value}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })}

          {state.done && state.noChange.length > 0 && (
            <div className="mt-4 pt-3 border-t border-rule-soft">
              <div className="eyebrow mb-2">Unchanged ({state.noChange.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {state.noChange.map((n) => (
                  <span
                    key={n}
                    className="text-[11.5px] text-ink-quiet px-2 py-0.5 bg-paper-subtle rounded"
                  >
                    {n}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffRow({
  op,
  path,
  oldVal,
  newVal
}: {
  op: 'add' | 'replace' | 'remove';
  path: string;
  oldVal: unknown;
  newVal: unknown;
}) {
  const opLabel: Record<typeof op, string> = { add: 'add', replace: 'replace', remove: 'remove' };
  return (
    <div className="text-caption">
      <div className="font-mono text-ink-quiet mb-1">
        <span className="text-coral mr-1.5">{opLabel[op]}</span>
        {path}
      </div>
      {(op === 'replace' || op === 'remove') && oldVal !== undefined && (
        <div className="line-through text-ink-quiet">- {stringify(oldVal)}</div>
      )}
      {(op === 'replace' || op === 'add') && newVal !== undefined && (
        <div className="bg-forest/10 text-ink px-1 rounded-sm inline-block">
          + {stringify(newVal)}
        </div>
      )}
    </div>
  );
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
