'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Github, RefreshCw, Slack, NotebookText, ScrollText, ChevronRight, AlertTriangle } from 'lucide-react';
import { cn } from '../../components/utils';

// Sources — the four feeds that power the status board and the anomaly engine.
// CC SESSIONS is the primary one (it tells the system what every Claude Code is
// doing), so it leads. Flat layout, no decorative icon-in-circle chrome, no
// cards nested inside cards. Connection state is one vocabulary: Connected / Not connected.

interface CcSourceStatus {
  base: string;
  reachable: boolean;
  collectorError?: string;
  knownUsers: number;
  perUser: Array<{ email: string; lastSyncedMtime: string | null }>;
  ccEventCount: number;
  agentsWithData: number;
}

interface GithubStatus {
  connected: boolean;
  org_or_user?: string;
  last_sync_at?: string;
  selected_repos?: Array<{ owner: string; name: string }>;
}

interface SlackStatus {
  connected: boolean;
  team?: string;
  last_sync_at?: string;
  selected_channels?: Array<{ id: string; name: string }>;
}

function ageStr(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 60 / 24)}d ago`;
}

export default function SourcesPage() {
  const [cc, setCc] = useState<CcSourceStatus | null>(null);
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [meetingCount, setMeetingCount] = useState<number | null>(null);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = 'Sources · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [ccRes, slackRes, ghRes, mRes, tlRes] = await Promise.all([
      fetch('/api/cc-status/source', { cache: 'no-store' }).catch(() => null),
      fetch('/api/slack/status', { cache: 'no-store' }).catch(() => null),
      fetch('/api/github/status', { cache: 'no-store' }).catch(() => null),
      fetch('/api/meetings', { cache: 'no-store' }).catch(() => null),
      fetch('/api/timeline?limit=200', { cache: 'no-store' }).catch(() => null)
    ]);
    if (ccRes && ccRes.ok) setCc((await ccRes.json()) as CcSourceStatus);
    if (slackRes && slackRes.ok) setSlack((await slackRes.json()) as SlackStatus);
    if (ghRes && ghRes.ok) setGithub((await ghRes.json()) as GithubStatus);
    if (mRes && mRes.ok) setMeetingCount(((await mRes.json()) as { meetings: unknown[] }).meetings.length);
    if (tlRes && tlRes.ok) setEventCount(((await tlRes.json()) as { events: unknown[] }).events.length);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-8">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Sources</div>
          <h1 className="display-title">Sources</h1>
        </div>
        <button onClick={refresh} aria-label="Refresh" className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors mb-0.5">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {/* Claude Code Sessions — primary source */}
      <section className="mb-8">
        <div className="rounded-xl border border-rule bg-paper-card p-6">
          <div className="flex items-baseline justify-between gap-4">
            <div className="flex items-baseline gap-3 min-w-0">
              <h2 className="font-serif text-[19px] text-ink leading-tight">Claude Code Sessions</h2>
              <ConnBadge connected={cc?.reachable} loading={!cc} />
            </div>
            {cc && <code className="font-mono text-[11px] text-ink-quiet shrink-0 hidden md:block">{cc.base}</code>}
          </div>
          <p className="text-[13px] text-ink-muted leading-relaxed mt-2.5">
            Each member&apos;s local Claude Code session log (model, tokens, tool calls, stuck signals, cwd) uploads to the collector. The system pulls and normalizes them into events, polling the collector&apos;s live status endpoint (context usage, session health, quota windows, session cost). Anomalies land in &quot;Needs your attention.&quot;
          </p>
          {cc && (
            <>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-2 text-[13px]">
                <InlineStat n={cc.knownUsers} label="collector users" />
                <InlineStat
                  n={cc.agentsWithData}
                  label="members connected"
                  hint={cc.agentsWithData < cc.knownUsers ? `${cc.knownUsers - cc.agentsWithData} unmapped` : undefined}
                />
                <InlineStat n={cc.ccEventCount} label="events ingested" tabular />
              </div>
              <p className="mt-3 text-[11.5px] text-ink-quiet">
                {cc.ccEventCount > 0 ? (
                  <>Run <code className="font-mono text-[11px] px-1.5 py-0.5 bg-paper-subtle rounded">bun run sync</code> to pull the latest sessions</>
                ) : (
                  <>Once members upload sessions, run <code className="font-mono text-[11px] px-1.5 py-0.5 bg-paper-subtle rounded">bun run sync</code></>
                )}
              </p>
              {cc.collectorError && (
                <div className="mt-3 text-[12px] text-rust flex items-center gap-1.5">
                  <AlertTriangle size={11} /> {cc.collectorError}
                </div>
              )}
              {cc.perUser.length > 0 && (
                <details className="mt-3 group">
                  <summary className="cursor-pointer text-[12px] text-ink-quiet hover:text-ink-muted list-none [&::-webkit-details-marker]:hidden">
                    Synced users · {cc.perUser.length}
                    <span className="group-open:hidden"> (expand)</span>
                    <span className="hidden group-open:inline"> (collapse)</span>
                  </summary>
                  <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-1">
                    {cc.perUser.map((u) => (
                      <div key={u.email} className="flex items-center justify-between text-[11.5px] px-2 py-1 rounded bg-paper-subtle">
                        <span className="font-mono text-ink-soft truncate">{u.email}</span>
                        <span className="text-ink-quiet shrink-0 ml-2 tabular-nums">{u.lastSyncedMtime ? ageStr(u.lastSyncedMtime) : 'not synced'}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </section>

      {/* Other three sources */}
      <section className="mb-10">
        <div className="eyebrow mb-2">Other sources</div>
        <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
          <SourceRow
            href="/sources/slack"
            icon={<Slack size={16} strokeWidth={1.8} className="text-[#611F69]" />}
            name="Slack"
            connected={!!slack?.connected}
            desc="Mentions, unanswered questions, channel activity"
            meta={slack?.connected ? `${slack.team ?? ''}${slack.selected_channels ? ` · ${slack.selected_channels.length} channel${slack.selected_channels.length === 1 ? '' : 's'}` : ''} · synced ${ageStr(slack.last_sync_at)}` : undefined}
          />
          <SourceRow
            href="/sources/github"
            icon={<Github size={16} strokeWidth={1.8} className="text-ink" />}
            name="GitHub"
            connected={!!github?.connected}
            desc="PR open / merge, review wait, commits, CI failures"
            meta={github?.connected ? `${github.org_or_user ?? ''}${github.selected_repos ? ` · ${github.selected_repos.length} repo${github.selected_repos.length === 1 ? '' : 's'}` : ''} · synced ${ageStr(github.last_sync_at)}` : undefined}
          />
          <SourceRow
            href="/meetings"
            icon={<NotebookText size={16} strokeWidth={1.8} className="text-ink-muted" />}
            name="Meetings"
            connected
            connectedLabel={meetingCount !== null ? `${meetingCount} file${meetingCount === 1 ? '' : 's'}` : '…'}
            desc="Action items, callouts, decisions. Open to view and append"
          />
        </div>
      </section>

      {/* System log — full audit trail lives on its own second-level page. */}
      <section>
        <div className="eyebrow mb-2">Audit</div>
        <div className="rounded-xl border border-rule overflow-hidden">
          <SourceRow
            href="/timeline"
            icon={<ScrollText size={16} strokeWidth={1.8} className="text-ink-muted" />}
            name="System log"
            connected
            connectedLabel={eventCount !== null ? `${eventCount} event${eventCount === 1 ? '' : 's'}` : '…'}
            desc="Engine audit trail — predictions, overrides, profile rebuilds, sync runs"
          />
        </div>
      </section>
    </div>
  );
}

function ConnBadge({ connected, loading }: { connected?: boolean; loading?: boolean }) {
  if (loading) return <span className="text-[10.5px] text-ink-quiet">Checking…</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px]', connected ? 'bg-forest/10 text-forest' : 'bg-rust/10 text-rust')}>
      <span className={cn('w-1.5 h-1.5 rounded-full', connected ? 'bg-forest' : 'bg-rust')} />
      {connected ? 'Connected' : 'Not connected'}
    </span>
  );
}

function InlineStat({ n, label, hint, tabular }: { n: number; label: string; hint?: string; tabular?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={cn('font-serif text-[18px] text-ink leading-none', tabular && 'tabular-nums')}>{n}</span>
      <span className="text-[11.5px] text-ink-quiet">{label}{hint ? <span className="text-ink-ghost"> · {hint}</span> : null}</span>
    </span>
  );
}

function SourceRow({
  href,
  icon,
  name,
  connected,
  connectedLabel,
  desc,
  meta
}: {
  href: string;
  icon: React.ReactNode | null;
  name: string;
  connected: boolean;
  connectedLabel?: string;
  desc: string;
  meta?: string;
}) {
  return (
    <Link href={href} className="flex items-center gap-3 px-5 py-3.5 bg-paper-card hover:bg-paper-subtle transition-colors">
      {icon && <span className="shrink-0 w-4 flex justify-center">{icon}</span>}
      <span className="font-serif text-[15px] text-ink shrink-0 w-24 truncate">{name}</span>
      <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] shrink-0 w-[100px] justify-center whitespace-nowrap', connected ? 'bg-forest/10 text-forest' : 'bg-paper-subtle text-ink-quiet border border-rule')}>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', connected ? 'bg-forest' : 'bg-rule-strong')} />
        {connectedLabel ?? (connected ? 'Connected' : 'Not connected')}
      </span>
      <span className="text-[12.5px] text-ink-muted truncate flex-1 min-w-0">{desc}</span>
      {meta && <span className="text-[11px] text-ink-quiet shrink-0 hidden lg:block">{meta}</span>}
      <ChevronRight size={14} className="text-ink-quiet shrink-0" />
    </Link>
  );
}
