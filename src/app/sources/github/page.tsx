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

interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
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

  const filteredRepos =
    repos?.filter(
      (r) =>
        !filter.trim() ||
        r.full_name.toLowerCase().includes(filter.toLowerCase()) ||
        (r.description ?? '').toLowerCase().includes(filter.toLowerCase())
    ) ?? null;

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
        className="text-caption text-ink-muted hover:text-ink inline-flex items-center gap-1 mb-3"
      >
        <ArrowLeft size={12} /> Sources
      </Link>

      <header className="flex items-start gap-4 mb-8">
        <div className="w-12 h-12 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center">
          <Github size={24} strokeWidth={1.8} className="text-ink" />
        </div>
        <div className="flex-1">
          <div className="eyebrow mb-1">Rocket Team / Sources / GitHub</div>
          <h1 className="display-title">{status?.connected ? `Connected as @${status.login}` : 'Connect GitHub'}</h1>
          <p className="prose-warm text-body text-ink-muted mt-2 max-w-2xl">
            {status?.connected
              ? 'The system pulls recent PRs, issues, and code reviews from your selected repos as profile evidence.'
              : 'Create a PAT (Personal Access Token) on GitHub and paste it here. Reads PRs, issues, and code reviews.'}
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
          <header className="mb-3">
            <h2 className="font-serif text-[17px] text-ink leading-tight">Paste your PAT</h2>
            <p className="text-caption text-ink-quiet mt-0.5">
              On GitHub: Settings → Developer settings → Personal access tokens. Minimum scopes:
              <span className="font-mono mx-1">repo</span> (public + private) +
              <span className="font-mono mx-1">read:org</span> (org info).
              <a
                href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Rocket%20Team"
                target="_blank"
                rel="noopener noreferrer"
                className="link-coral inline-flex items-center gap-0.5 ml-1"
              >
                Open creation page <ExternalLink size={10} />
              </a>
            </p>
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
                        <div className="font-mono text-[13px] text-ink leading-tight">{r.full_name}</div>
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
                  {status.last_sync_at && `Last synced ${status.last_sync_at.slice(0, 16).replace('T', ' ')}`}
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
