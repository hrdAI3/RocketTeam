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
        toast.push(d.error ?? `验证失败 ${res.status}`, 'error');
        return;
      }
      toast.push(`已连接 GitHub @${d.login}`, 'success');
      const sRes = await fetch('/api/github/status', { cache: 'no-store' });
      setStatus((await sRes.json()) as Status);
      setPat('');
      await loadRepos();
    } finally {
      setVerifying(false);
    }
  };

  const disconnect = async () => {
    if (!confirm('确认断开 GitHub？已同步的 PR 文件不会删除。')) return;
    await fetch('/api/github/disconnect', { method: 'POST' });
    setStatus({ connected: false });
    setRepos(null);
    setSelected(new Set());
    toast.push('已断开', 'success');
  };

  const sync = async () => {
    if (selected.size === 0 || !repos) {
      toast.push('请先选择仓库', 'error');
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
      if (okN > 0 && errN === 0) toast.push(`同步完成 · ${okN} 仓库 · ${total} 个 PR`, 'success');
      else if (okN > 0) toast.push(`部分成功：${okN} 仓库完成，${errN} 失败`, 'default');
      else toast.push(`全部 ${errN} 仓库同步失败`, 'error');
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
        <ArrowLeft size={12} /> 数据接入
      </Link>

      <header className="flex items-start gap-4 mb-8">
        <div className="w-12 h-12 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center">
          <Github size={24} strokeWidth={1.8} className="text-ink" />
        </div>
        <div className="flex-1">
          <div className="eyebrow mb-1">Rocket Team / 数据接入 / GitHub</div>
          <h1 className="display-title">{status?.connected ? `已接入 @${status.login}` : '接入 GitHub'}</h1>
          <p className="prose-warm text-body text-ink-muted mt-2 max-w-2xl">
            {status?.connected
              ? '系统会拉取你选择的仓库的最近 PR + Issue + Code Review 作为画像证据。'
              : '在 GitHub 创建一个 PAT（Personal Access Token），粘进来即可。读取 PR / Issue / Code Review。'}
          </p>
        </div>
        {status?.connected && (
          <button onClick={disconnect} className="btn-ghost text-caption shrink-0">
            断开
          </button>
        )}
      </header>

      {!status?.connected ? (
        <section className="card-surface p-5">
          <header className="mb-3">
            <h2 className="font-serif text-[17px] text-ink leading-tight">粘贴 PAT</h2>
            <p className="text-caption text-ink-quiet mt-0.5">
              在 GitHub 设置 → Developer settings → Personal access tokens 创建。最小权限：
              <span className="font-mono mx-1">repo</span> (公私仓) +
              <span className="font-mono mx-1">read:org</span> (org 信息)。
              <a
                href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Rocket%20Team"
                target="_blank"
                rel="noopener noreferrer"
                className="link-coral inline-flex items-center gap-0.5 ml-1"
              >
                打开创建页 <ExternalLink size={10} />
              </a>
            </p>
          </header>
          <div className="flex gap-2">
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="ghp_... 或 github_pat_..."
              className="flex-1 font-mono text-[12.5px] bg-paper-card border border-rule rounded-md px-3 py-2 text-ink outline-none focus:border-coral-mute"
            />
            <button
              onClick={() => void connect()}
              disabled={verifying || !pat.trim()}
              className="btn-coral inline-flex items-center gap-1.5"
            >
              {verifying ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> 验证中…
                </>
              ) : (
                '连接'
              )}
            </button>
          </div>
        </section>
      ) : (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-serif text-title text-ink">仓库列表</h2>
            <div className="flex items-center gap-2">
              <span className="text-caption text-ink-quiet">
                已选 <span className="font-mono text-ink">{selected.size}</span> / {repos?.length ?? '?'}
              </span>
              <button
                onClick={() => void loadRepos()}
                disabled={reposLoading}
                className="btn-ghost text-caption inline-flex items-center gap-1"
              >
                <RefreshCw size={11} className={reposLoading ? 'animate-spin' : ''} /> 刷新
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
                placeholder="搜索仓库…"
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
                  {status.last_sync_at && `上次同步 ${status.last_sync_at.slice(0, 16).replace('T', ' ')}`}
                </span>
                <button
                  onClick={() => void sync()}
                  disabled={syncing || selected.size === 0}
                  className="btn-coral inline-flex items-center gap-1.5"
                >
                  {syncing ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> 同步中…
                    </>
                  ) : (
                    '同步过去 30 天 PR'
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
