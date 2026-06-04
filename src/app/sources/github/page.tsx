'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Github,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  GitPullRequest,
  Lock
} from 'lucide-react';
import { useToast } from '../../../components/Toast';
import { fmtBeijing } from '../../../components/utils';

interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  pushed_at: string;
  open_issues_count: number;
}

interface Status {
  connected: boolean;
  org_or_user?: string;
  login?: string;
  connected_at?: string;
  last_sync_at?: string;
  selected_repos?: Array<{ owner: string; name: string }>;
  auto_sync_enabled?: boolean;
  auto_sync_interval_min?: number;
}

export default function GithubOnboardPage() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [pat, setPat] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState('');
  const [hideForks, setHideForks] = useState(true);
  const [nextSyncIn, setNextSyncIn] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/github/status', { cache: 'no-store' });
        const s = (await res.json()) as Status;
        setStatus(s);
        if (s.connected) {
          if (s.selected_repos) setSelected(new Set(s.selected_repos.map((r) => `${r.owner}/${r.name}`)));
          await loadRepos();
        }
      } finally {
        setStatusLoading(false);
      }
    })();
    // Light polling so "Last synced …" stays current with the server-side
    // monitor loop (status only — don't re-pull the repo list every 30s).
    const id = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch('/api/github/status', { cache: 'no-store' });
          if (res.ok) setStatus((await res.json()) as Status);
        } catch {
          /* transient */
        }
      })();
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const loadRepos = async () => {
    setReposLoading(true);
    try {
      const res = await fetch('/api/github/repos', { cache: 'no-store' });
      const d = (await res.json()) as { repos?: Repo[]; error?: string };
      if (d.error) {
        toast.push(d.error, 'error');
        return;
      }
      setRepos(d.repos ?? []);
    } catch (err) {
      toast.push((err as Error).message, 'error');
    } finally {
      setReposLoading(false);
    }
  };

  const connect = async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/github/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pat })
      });
      const d = (await res.json()) as { ok?: boolean; login?: string; error?: string };
      if (!res.ok || !d.ok) {
        toast.push(d.error ?? `Verification failed ${res.status}`, 'error');
        return;
      }
      toast.push(`Connected to GitHub @${d.login}`, 'success');
      const sRes = await fetch('/api/github/status', { cache: 'no-store' });
      setStatus((await sRes.json()) as Status);
      setPat('');
      await loadRepos();
    } finally {
      setVerifying(false);
    }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect GitHub? Already-synced PR files will be kept.')) return;
    await fetch('/api/github/disconnect', { method: 'POST' });
    setStatus({ connected: false });
    setRepos(null);
    setSelected(new Set());
    toast.push('Disconnected', 'success');
  };

  const sync = async () => {
    if (selected.size === 0 || !repos) {
      toast.push('Select a repo first', 'error');
      return;
    }
    setSyncing(true);
    try {
      const picks = repos.filter((r) => selected.has(`${r.owner}/${r.name}`)).map((r) => ({ owner: r.owner, name: r.name }));
      const res = await fetch('/api/github/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: picks, days_back: 30 })
      });
      const d = (await res.json()) as {
        ok?: boolean;
        written?: Array<{ repo: string; prs: number }>;
        errors?: Array<{ repo: string; error: string }>;
      };
      const total = (d.written ?? []).reduce((a, w) => a + w.prs, 0);
      const okN = d.written?.length ?? 0;
      const errN = d.errors?.length ?? 0;
      if (okN > 0 && errN === 0) toast.push(`Sync complete · ${okN} repo${okN === 1 ? '' : 's'} · ${total} PR${total === 1 ? '' : 's'}`, 'success');
      else if (okN > 0) toast.push(`Partial success: ${okN} done, ${errN} failed`, 'default');
      else toast.push(`All ${errN} repo${errN === 1 ? '' : 's'} failed to sync`, 'error');
      const sRes = await fetch('/api/github/status', { cache: 'no-store' });
      setStatus((await sRes.json()) as Status);
    } finally {
      setSyncing(false);
    }
  };

  // Auto-sync — browser-driven polling. Only runs while this page is open
  // (the server-side monitor loop in src/services/monitor_loop.ts is the
  // always-on path; this is the "stops when page closes" toggle the leader
  // sees here, identical to Slack's pattern).
  const toggleAutoSync = async (enabled: boolean): Promise<void> => {
    if (!status?.connected) return;
    try {
      const res = await fetch('/api/github/auto-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, interval_min: status.auto_sync_interval_min ?? 15 })
      });
      if (!res.ok) {
        toast.push('Failed to update auto-sync', 'error');
        return;
      }
      toast.push(enabled ? 'Auto-sync enabled' : 'Auto-sync disabled', 'success');
      const sRes = await fetch('/api/github/status', { cache: 'no-store' });
      setStatus((await sRes.json()) as Status);
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  useEffect(() => {
    if (!status?.auto_sync_enabled || !status.connected) {
      setNextSyncIn(null);
      return;
    }
    const intervalMin = status.auto_sync_interval_min ?? 15;
    const intervalMs = intervalMin * 60 * 1000;
    let cancelled = false;
    let nextTickAt = Date.now() + intervalMs;
    setNextSyncIn(Math.ceil(intervalMs / 1000));
    const countdown = setInterval(() => {
      if (cancelled) return;
      setNextSyncIn(Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000)));
    }, 1000);
    const tick = setInterval(async () => {
      if (cancelled) return;
      try {
        const picks =
          repos?.filter((r) => selected.has(`${r.owner}/${r.name}`)).map((r) => ({
            owner: r.owner,
            name: r.name
          })) ?? [];
        if (picks.length === 0) {
          nextTickAt = Date.now() + intervalMs;
          return;
        }
        const res = await fetch('/api/github/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repos: picks, days_back: 2 })
        });
        if (res.ok) {
          const d = (await res.json()) as { written?: Array<{ prs: number }> };
          const total = (d.written ?? []).reduce((a, w) => a + w.prs, 0);
          if (total > 0) toast.push(`Auto-sync · ${total} new PR${total === 1 ? '' : 's'}`, 'success');
          const sRes = await fetch('/api/github/status', { cache: 'no-store' });
          setStatus((await sRes.json()) as Status);
        }
      } catch {
        /* transient failure — next tick will retry */
      }
      nextTickAt = Date.now() + intervalMs;
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(countdown);
      clearInterval(tick);
    };
  }, [
    status?.auto_sync_enabled,
    status?.auto_sync_interval_min,
    status?.connected,
    repos,
    selected,
    toast
  ]);

  const filteredRepos =
    repos?.filter((r) => {
      if (hideForks && r.fork) return false;
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return (
        r.full_name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q)
      );
    }) ?? null;

  // Selects every repo currently visible (respects "Hide forks" + search).
  const selectAllVisible = (): void => {
    if (!filteredRepos) return;
    const next = new Set<string>();
    for (const r of filteredRepos) next.add(`${r.owner}/${r.name}`);
    setSelected(next);
  };
  const clearAll = (): void => setSelected(new Set());

  if (statusLoading) {
    return (
      <div className="px-12 py-10 max-w-[1100px] mx-auto">
        <SkeletonHero />
      </div>
    );
  }

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <Link
        href="/sources"
        className="inline-flex items-center gap-1.5 text-[12px] text-ink-quiet hover:text-ink-muted mb-3 transition-colors"
      >
        <ArrowLeft size={13} /> Back to Sources
      </Link>

      <header className="flex items-start gap-4 mb-8">
        <div className="w-12 h-12 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center">
          <Github size={24} strokeWidth={1.8} className="text-ink" />
        </div>
        <div className="flex-1">
          <div className="eyebrow mb-1">
            Rocket Team / <Link href="/sources" className="hover:text-ink-muted transition-colors">Sources</Link> / GitHub
          </div>
          <h1 className="display-title">{status?.connected ? `Connected as @${status.login}` : 'Connect GitHub'}</h1>
          <p className="text-body text-ink-muted mt-2">
            {status?.connected
              ? 'Maps projects to repos. Flags missing collaborators.'
              : 'Read-only access. Maps projects to repos. Flags missing collaborators.'}
          </p>
        </div>
        {status?.connected && (
          <button onClick={disconnect} className="btn-ghost text-caption shrink-0">
            Disconnect
          </button>
        )}
      </header>

      {!status?.connected ? (
        <section className="card-surface p-5">
          <header className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="font-serif text-[17px] text-ink leading-tight">Paste your PAT</h2>
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              className="link-coral text-caption inline-flex items-center gap-0.5 shrink-0"
            >
              Generate on GitHub <ExternalLink size={10} />
            </a>
          </header>
          <div className="flex gap-2">
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="ghp_... or github_pat_..."
              className="flex-1 font-mono text-[12.5px] bg-paper-card border border-rule rounded-md px-3 py-2 text-ink outline-none focus:border-coral-mute"
            />
            <button
              onClick={() => void connect()}
              disabled={verifying || !pat.trim()}
              className="btn-coral inline-flex items-center gap-1.5"
            >
              {verifying ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Verifying…
                </>
              ) : (
                'Connect'
              )}
            </button>
          </div>
          <p className="text-[11.5px] text-ink-quiet mt-3">
            Use the leader account · <span className="font-mono">Metadata: Read</span> · revokable anytime
          </p>
        </section>
      ) : (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-serif text-title text-ink">Repos</h2>
            <div className="flex items-center gap-2">
              <span className="text-caption text-ink-quiet">
                <span className="font-mono text-ink">{selected.size}</span> / {repos?.length ?? '?'} selected
              </span>
              <button
                onClick={() => void loadRepos()}
                disabled={reposLoading}
                className="btn-ghost text-caption inline-flex items-center gap-1"
              >
                <RefreshCw size={11} className={reposLoading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>

          {reposLoading && !repos && (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          )}

          {repos && repos.length > 0 && (
            <>
              {/* Quick selection + visibility toggles. "Select real projects"
                  is the one-click setup for the common case: skip forks &
                  archived, keep everything else. Filter toggles let the
                  leader hide noise without losing the option to see it. */}
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAllVisible}
                    className="btn-ghost text-caption inline-flex items-center gap-1"
                  >
                    Select all projects
                  </button>
                  <button
                    onClick={clearAll}
                    className="text-caption text-ink-quiet hover:text-ink transition-colors px-2"
                  >
                    Clear
                  </button>
                </div>
                <div className="flex items-center gap-3 text-[11.5px] text-ink-quiet">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hideForks}
                      onChange={(e) => setHideForks(e.target.checked)}
                      className="accent-coral"
                    />
                    Hide forks
                  </label>
                </div>
              </div>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search repos…"
                className="w-full mb-3 px-3 py-2 bg-paper-card border border-rule rounded-md text-[13.5px] outline-none focus:border-coral-mute"
              />
              <div className="rounded-lg border border-rule bg-paper-subtle/30 p-2 max-h-[420px] overflow-y-auto">
                {(filteredRepos ?? []).slice(0, 100).map((r) => {
                  const key = `${r.owner}/${r.name}`;
                  const checked = selected.has(key);
                  return (
                    <label
                      key={r.id}
                      className={`flex items-start gap-3 py-2 px-2 rounded-md cursor-pointer hover:bg-paper-card transition-colors ${
                        checked ? 'bg-coral-subtle/40' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(key)) n.delete(key);
                            else n.add(key);
                            return n;
                          });
                        }}
                        className="accent-coral mt-1"
                      />
                      {r.private ? (
                        <Lock size={13} className="text-ink-quiet mt-1" />
                      ) : (
                        <Github size={13} className="text-ink-quiet mt-1" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-[13px] text-ink leading-tight">{r.full_name}</span>
                          {r.fork && (
                            <span
                              title="This repo is a fork — typically a collected reference, not a real project"
                              className="text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded font-mono bg-paper-subtle text-ink-quiet border border-rule"
                            >
                              fork
                            </span>
                          )}
                          {r.private && (
                            <span
                              title="Private repo"
                              className="text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded font-mono bg-paper-subtle text-ink-quiet border border-rule"
                            >
                              private
                            </span>
                          )}
                        </div>
                        {r.description && (
                          <div className="text-[11.5px] text-ink-quiet leading-tight mt-0.5 truncate">
                            {r.description}
                          </div>
                        )}
                      </div>
                      <span className="text-[11px] text-ink-quiet font-mono shrink-0 mt-1 inline-flex items-center gap-1">
                        <GitPullRequest size={10} /> {r.open_issues_count}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-3">
                <span className="text-caption text-ink-quiet">
                  {status.last_sync_at && `Last synced ${fmtBeijing(status.last_sync_at)}`}
                </span>
                <button
                  onClick={() => void sync()}
                  disabled={syncing || selected.size === 0}
                  className="btn-coral inline-flex items-center gap-1.5"
                >
                  {syncing ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> Syncing…
                    </>
                  ) : (
                    'Sync the last 30 days'
                  )}
                </button>
              </div>

              {status.last_sync_at && (
                <div className="flex items-center justify-between pb-2 pt-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(status.auto_sync_enabled)}
                      onChange={(e) => void toggleAutoSync(e.target.checked)}
                      className="accent-coral"
                    />
                    <span className="text-[13px] text-ink">
                      Auto-sync every {status.auto_sync_interval_min ?? 15} min
                    </span>
                  </label>
                  <span className="text-[11px] text-ink-quiet">
                    {status.auto_sync_enabled
                      ? nextSyncIn !== null
                        ? `next in ${Math.ceil(nextSyncIn / 60)}m`
                        : 'preparing…'
                      : 'stops when page closes'}
                  </span>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function SkeletonHero() {
  return (
    <div>
      <div className="h-3 w-24 bg-paper-deep rounded animate-pulse mb-3" />
      <div className="flex items-start gap-4 mb-8">
        <div className="w-12 h-12 rounded-xl bg-paper-deep animate-pulse" />
        <div className="flex-1">
          <div className="h-3 w-32 bg-paper-deep rounded animate-pulse mb-2" />
          <div className="h-7 w-48 bg-paper-deep rounded animate-pulse mb-2" />
          <div className="h-4 w-full max-w-md bg-paper-deep rounded animate-pulse" />
        </div>
      </div>
      <div className="card-surface p-5">
        <div className="h-4 w-32 bg-paper-deep rounded animate-pulse mb-2" />
        <div className="h-3 w-72 bg-paper-deep rounded animate-pulse mb-4" />
        <div className="h-9 w-full bg-paper-deep rounded animate-pulse" />
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="card-surface p-3 animate-pulse flex items-center gap-3">
      <div className="w-3 h-3 bg-paper-deep rounded" />
      <div className="flex-1">
        <div className="h-3 w-40 bg-paper-deep rounded mb-1.5" />
        <div className="h-2.5 w-64 bg-paper-deep rounded" />
      </div>
    </div>
  );
}
