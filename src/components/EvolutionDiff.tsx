'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { EvolutionDiff as EvolutionDiffType } from '@/types';

interface EvolutionDiffProps {
  open: boolean;
  agentName: string;
  context: string;
  onClose: () => void;
  onApplied: () => void;
}

export function EvolutionDiff({ open, agentName, context, onClose, onApplied }: EvolutionDiffProps) {
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<EvolutionDiffType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Trigger preview once when the modal opens with a fresh context.
  // Critical: do NOT trigger setState in the render body — that causes
  // infinite re-render loops in React 18 strict mode.
  useEffect(() => {
    if (!open) {
      setDiff(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff(null);
    (async () => {
      try {
        const res = await fetch('/api/evolution?action=preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_name: agentName, context })
        });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({ error: 'preview failed' }))) as { error?: string };
          throw new Error(e.error ?? 'preview failed');
        }
        const d = (await res.json()) as EvolutionDiffType;
        if (!cancelled) setDiff(d);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agentName, context]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="card-warm shadow-modal w-[680px] max-h-[80vh] flex flex-col">
        <header className="flex items-center justify-between px-5 py-4 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">
            画像变更预览 · <span className="font-mono text-coral-deep">{agentName}</span>
          </h2>
          <button onClick={onClose} className="text-ink-quiet hover:text-ink" aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && <p className="text-body text-ink-muted">正在计算差异…</p>}
          {error && <p className="text-body text-rust">{error}</p>}
          {diff && diff.patches.length === 0 && (
            <p className="text-body text-ink-muted">这段上下文没有触发任何画像变更。</p>
          )}
          {diff && diff.patches.length > 0 && (
            <div className="space-y-3">
              {diff.human_summary.length > 0 && (
                <ul className="text-body text-ink-soft list-disc pl-5 space-y-1">
                  {diff.human_summary.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
              <div className="rounded-md border border-rule bg-paper-subtle p-3 space-y-2">
                {diff.patches.map((p, i) => (
                  <DiffRow key={i} op={p.op} path={p.path} oldVal={p.old} newVal={p.value} />
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-rule flex justify-end gap-2">
          <button onClick={onClose} disabled={applying} className="btn-ghost text-caption">
            放弃
          </button>
          <button
            disabled={!diff || applying || diff.patches.length === 0}
            onClick={async () => {
              if (!diff) return;
              setApplying(true);
              try {
                const res = await fetch('/api/evolution?action=apply', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(diff)
                });
                if (!res.ok) {
                  const e = await res.json().catch(() => ({ error: '应用失败' }));
                  setError(e.error ?? '应用失败');
                  return;
                }
                onApplied();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setApplying(false);
              }
            }}
            className="btn-coral text-caption"
          >
            {applying ? '应用中…' : '确认应用'}
          </button>
        </footer>
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
  const opLabel: Record<typeof op, string> = { add: '新增', replace: '替换', remove: '删除' };
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
        <div className="bg-forest/10 text-ink px-1 rounded-sm inline-block">+ {stringify(newVal)}</div>
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
