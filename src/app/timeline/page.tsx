'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, RefreshCw } from 'lucide-react';
import type { TimelineEvent } from '@/types';

// System log — second-level page. The /sources board only links here; the full
// audit trail of engine events (predictions, overrides, profile rebuilds, sync
// runs) lives on this page so the board stays a glance, not a feed.

const EVENT_LABEL: Record<string, string> = {
  task_predicted: 'Task predicted',
  task_overridden: 'Task reassigned',
  task_accepted: 'Task accepted',
  evolution_applied: 'Profile updated',
  bootstrap: 'Profile generated',
  override: 'Reassigned',
  agent_action: 'Agent action',
  sim_started: 'Simulation started',
  sim_completed: 'Simulation completed'
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${HH}:${mm}`;
}

export default function SystemLogPage() {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = 'System log · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/timeline?limit=200', { cache: 'no-store' }).catch(() => null);
    if (res && res.ok) setEvents(((await res.json()) as { events: TimelineEvent[] }).events);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-8">
        <div>
          <div className="eyebrow mb-2">
            Rocket Team / <Link href="/sources" className="hover:text-ink-muted transition-colors">Sources</Link> / System log
          </div>
          <h1 className="display-title">System log</h1>
        </div>
        <button onClick={refresh} aria-label="Refresh" className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors mb-0.5">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {events && events.length > 0 ? (
        <div className="rounded-xl border border-rule bg-paper-card overflow-hidden">
          <ul className="divide-y divide-rule-soft">
            {events.map((e, i) => (
              <li key={i} className="flex items-start gap-3 py-2.5 px-4 text-[13px] hover:bg-paper-subtle transition-colors group">
                <span className="text-[11px] text-ink-quiet shrink-0 w-[110px] mt-0.5 tabular-nums">{fmtDateTime(e.ts)}</span>
                <Activity size={12} className="text-ink-muted shrink-0 mt-1" />
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-paper-subtle text-ink-muted shrink-0 mt-0.5">{EVENT_LABEL[e.type] ?? e.type}</span>
                <span className="text-ink leading-relaxed flex-1 min-w-0">{e.summary}</span>
                {e.sim_id && <a href={`/sim/${e.sim_id}`} className="text-[11px] font-mono text-coral opacity-0 group-hover:opacity-100 transition-opacity shrink-0 self-center">replay →</a>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-rule p-6 text-center text-ink-quiet text-[13px]">
          {loading ? 'Loading…' : 'No events yet'}
        </div>
      )}
    </div>
  );
}
