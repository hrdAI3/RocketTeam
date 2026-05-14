'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Activity, FileText, ChevronRight, AlertTriangle } from 'lucide-react';
import { deptLabel } from '../../components/utils';
import type { TeamMemberProfile, Department } from '@/types';

// Member reference list — "深入" / debug view.
//
// This is NOT the leader's primary surface. CC work status lives at /status.
// The persona profiles here (MBTI, capabilities, persona narrative) exist so
// the PMA simulation can predict task owners; this page is just a way to
// inspect them. Each row links to BOTH the CC status (/status/<name>) and the
// PMA profile detail (/agents/<name>).

type AgentItem = TeamMemberProfile | { name: string; _error: string };

const DEPT_ORDER: Department[] = ['老板', '研发', '产品', '职能', '运营'];

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agents', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = (await res.json()) as { agents: AgentItem[] };
      setAgents(data.agents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.title = 'Team · Rocket Team';
  }, []);

  const real = useMemo(
    () => (agents ?? []).filter((a): a is TeamMemberProfile => !('_error' in a)),
    [agents]
  );
  const corrupted = (agents ?? []).filter((a): a is { name: string; _error: string } => '_error' in a);

  // Group by department.
  const byDept = useMemo(() => {
    const m = new Map<string, TeamMemberProfile[]>();
    for (const a of real) {
      const d = a.dept ?? '其他';
      const list = m.get(d) ?? [];
      list.push(a);
      m.set(d, list);
    }
    return m;
  }, [real]);

  return (
    <div className="px-12 py-10 max-w-[1000px] mx-auto">
      <header className="flex items-start justify-between mb-3">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Team</div>
          <h1 className="display-title">Team</h1>
        </div>
        <button onClick={refresh} aria-label="Refresh" className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>
      <p className="prose-warm text-body text-ink-muted mb-8 max-w-2xl">
        PMA profiles for all 24 members (used for task simulation). This is a reference view. To see what each member&apos;s Claude Code is doing right now, go to{' '}
        <Link href="/status" className="link-coral">Status</Link>.
      </p>

      {error && (
        <div className="rounded-xl border border-rust bg-paper-card p-4 mb-6 text-body text-ink">
          {error} <button onClick={refresh} className="ml-3 link-coral">Retry</button>
        </div>
      )}
      {corrupted.length > 0 && (
        <div className="rounded-xl border border-amber bg-paper-card p-4 mb-6 text-body text-ink">
          {corrupted.length} corrupted profile{corrupted.length === 1 ? '' : 's'}: {corrupted.map((c) => c.name).join(', ')}
        </div>
      )}

      {loading && !agents && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 rounded-lg border border-rule bg-paper-card animate-pulse" />
          ))}
        </div>
      )}

      {agents && real.length === 0 && (
        <div className="rounded-2xl border border-dashed border-rule p-12 text-center bg-paper-card">
          <p className="font-serif text-title text-ink mb-2">No member data yet</p>
          <p className="text-body text-ink-muted">Run <code className="font-mono text-[13px] px-1.5 py-0.5 bg-paper-subtle rounded">bun run bootstrap</code> to generate profiles from meeting notes.</p>
        </div>
      )}

      {real.length > 0 && (
        <div className="space-y-6">
          {DEPT_ORDER.filter((d) => byDept.has(d)).concat([...byDept.keys()].filter((d) => !DEPT_ORDER.includes(d as Department)) as Department[]).map((dept) => {
            const list = byDept.get(dept) ?? [];
            if (list.length === 0) return null;
            return (
              <div key={dept}>
                <div className="eyebrow mb-2">{deptLabel(dept)} · {list.length}</div>
                <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
                  {list
                    .slice()
                    .sort((a, b) => {
                      const aLead = (a.role ?? '').includes('负责人') ? 0 : 1;
                      const bLead = (b.role ?? '').includes('负责人') ? 0 : 1;
                      if (aLead !== bLead) return aLead - bLead;
                      return a.name.localeCompare(b.name, 'zh-Hans-CN');
                    })
                    .map((a) => (
                      <div key={a.name} className="flex items-center gap-3 px-4 py-2.5 bg-paper-card">
                        <span className="font-serif text-[14.5px] text-ink min-w-[5rem] shrink-0">{a.name}</span>
                        <span className="text-[12px] text-ink-quiet shrink-0">{a.role ?? 'Member'}</span>
                        {a.tier === 'stub' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-paper-subtle text-ink-quiet shrink-0 inline-flex items-center gap-1">
                            <AlertTriangle size={8} /> thin profile
                          </span>
                        )}
                        <span className="ml-auto flex items-center gap-3 shrink-0">
                          <Link href={`/status/${encodeURIComponent(a.name)}`} className="text-[12px] text-ink-muted hover:text-ink inline-flex items-center gap-0.5">
                            <Activity size={11} /> Status
                          </Link>
                          <Link href={`/agents/${encodeURIComponent(a.name)}`} className="text-[12px] text-ink-quiet hover:text-ink inline-flex items-center gap-0.5">
                            <FileText size={11} /> PMA profile <ChevronRight size={11} />
                          </Link>
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
