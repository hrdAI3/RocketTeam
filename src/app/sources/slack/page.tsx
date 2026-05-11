'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Slack,
  Check,
  Copy,
  ExternalLink,
  ChevronRight,
  Hash,
  Lock,
  Loader2,
  RefreshCw,
  Plus,
  Calendar,
  FileText,
  Search
} from 'lucide-react';
import { useToast } from '../../../components/Toast';
import { MeetingViewer } from '../../../components/MeetingViewer';

const BOT_MANIFEST = `display_information:
  name: Rocket Team
  description: 把团队的 Slack 讨论沉淀成每位成员的内部画像
  background_color: "#D97757"
features:
  bot_user:
    display_name: rocket-team
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - channels:join
      - groups:history
      - groups:read
      - users:read
      - team:read`;

interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  num_members?: number;
  topic?: string;
}

interface ConnectionStatus {
  connected: boolean;
  team?: string;
  bot_user_id?: string;
  connected_at?: string;
  last_sync_at?: string;
  selected_channels?: Array<{ id: string; name: string }>;
  auto_sync_enabled?: boolean;
  auto_sync_interval_min?: number;
}

interface TranscriptMeta {
  file: string;
  title: string;
  date?: string;
  sizeKb: number;
  lineCount: number;
}

export default function SlackOnboardPage() {
  const toast = useToast();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [transcripts, setTranscripts] = useState<TranscriptMeta[] | null>(null);
  const [openTranscript, setOpenTranscript] = useState<TranscriptMeta | null>(null);
  const [transcriptQuery, setTranscriptQuery] = useState('');

  const [showAddWorkspace, setShowAddWorkspace] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncErrors, setSyncErrors] = useState<Array<{ channel: string; error: string }>>([]);
  const [nextSyncIn, setNextSyncIn] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [sRes, tRes] = await Promise.all([
          fetch('/api/slack/status', { cache: 'no-store' }),
          fetch('/api/slack/transcripts', { cache: 'no-store' })
        ]);
        const s = (await sRes.json()) as ConnectionStatus;
        setStatus(s);
        if (tRes.ok) {
          const td = (await tRes.json()) as { transcripts: TranscriptMeta[] };
          setTranscripts(td.transcripts);
        }
        if (s.connected) {
          if (s.selected_channels) setSelected(new Set(s.selected_channels.map((c) => c.id)));
          await loadChannels();
        }
      } finally {
        setStatusLoading(false);
      }
    })();
  }, []);

  // Auto-sync polling
  useEffect(() => {
    if (!status?.connected || !status.auto_sync_enabled) {
      setNextSyncIn(null);
      return;
    }
    const intervalMin = status.auto_sync_interval_min ?? 15;
    const intervalMs = intervalMin * 60 * 1000;
    const picks = (status.selected_channels ?? []).map((c) => ({ id: c.id, name: c.name }));
    if (picks.length === 0) {
      setNextSyncIn(null);
      return;
    }
    let nextTickAt = Date.now() + intervalMs;
    setNextSyncIn(Math.ceil(intervalMs / 1000));
    const ticker = setInterval(() => {
      const remain = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
      setNextSyncIn(remain);
    }, 1000);
    const poller = setInterval(async () => {
      try {
        const res = await fetch('/api/slack/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels: picks, days_back: 1 })
        });
        const data = (await res.json()) as {
          ok?: boolean;
          written?: Array<{ channel: string; messages: number }>;
        };
        if (data.ok && data.written) {
          const total = data.written.reduce((a, w) => a + w.messages, 0);
          if (total > 0) toast.push(`自动同步 · ${total} 条新消息`, 'success');
        }
        const sRes = await fetch('/api/slack/status', { cache: 'no-store' });
        setStatus((await sRes.json()) as ConnectionStatus);
        const tRes = await fetch('/api/slack/transcripts', { cache: 'no-store' });
        if (tRes.ok) {
          const td = (await tRes.json()) as { transcripts: TranscriptMeta[] };
          setTranscripts(td.transcripts);
        }
      } catch {
        /* swallow */
      }
      nextTickAt = Date.now() + intervalMs;
    }, intervalMs);
    return () => {
      clearInterval(ticker);
      clearInterval(poller);
    };
  }, [
    status?.connected,
    status?.auto_sync_enabled,
    status?.auto_sync_interval_min,
    status?.selected_channels
  ]);

  const loadChannels = async () => {
    setChannelsLoading(true);
    try {
      const res = await fetch('/api/slack/channels', { cache: 'no-store' });
      const d = (await res.json()) as { channels?: SlackChannel[]; error?: string };
      if (d.error) {
        toast.push(d.error, 'error');
        return;
      }
      setChannels(d.channels ?? []);
    } catch (err) {
      toast.push((err as Error).message, 'error');
    } finally {
      setChannelsLoading(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.push('已复制', 'success');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.push('复制失败', 'error');
    }
  };

  const connect = async () => {
    if (!botToken.startsWith('xoxb-')) {
      toast.push('Bot token 必须以 xoxb- 开头', 'error');
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch('/api/slack/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token: botToken })
      });
      const data = (await res.json()) as { ok?: boolean; team?: string; error?: string };
      if (!res.ok || !data.ok) {
        toast.push(data.error ?? `验证失败 ${res.status}`, 'error');
        return;
      }
      toast.push(`已连接 ${data.team}`, 'success');
      const sRes = await fetch('/api/slack/status', { cache: 'no-store' });
      setStatus((await sRes.json()) as ConnectionStatus);
      setBotToken('');
      setShowAddWorkspace(false);
      await loadChannels();
    } finally {
      setVerifying(false);
    }
  };

  const disconnect = async () => {
    if (!confirm('确认断开 Slack？已同步的消息文件不会删除。')) return;
    await fetch('/api/slack/disconnect', { method: 'POST' });
    setStatus({ connected: false });
    setChannels(null);
    setSelected(new Set());
    toast.push('已断开', 'success');
  };

  const toggleAutoSync = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/slack/auto-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, interval_min: status?.auto_sync_interval_min ?? 15 })
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const sRes = await fetch('/api/slack/status', { cache: 'no-store' });
      setStatus((await sRes.json()) as ConnectionStatus);
      toast.push(enabled ? '自动同步已开启' : '自动同步已关闭', 'success');
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  const sync = async () => {
    if (selected.size === 0 || !channels) {
      toast.push('请先选择频道', 'error');
      return;
    }
    setSyncing(true);
    setSyncErrors([]);
    try {
      const picks = channels
        .filter((c) => selected.has(c.id))
        .map((c) => ({ id: c.id, name: c.name }));
      const res = await fetch('/api/slack/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: picks, days_back: 30 })
      });
      const data = (await res.json()) as {
        ok?: boolean;
        written?: Array<{ channel: string; messages: number }>;
        errors?: Array<{ channel: string; error: string }>;
        error?: string;
      };
      if (!res.ok) {
        toast.push(data.error ?? '同步失败', 'error');
        return;
      }
      const total = (data.written ?? []).reduce((a, w) => a + w.messages, 0);
      const okCount = data.written?.length ?? 0;
      const errCount = data.errors?.length ?? 0;
      if (okCount > 0 && errCount === 0) {
        toast.push(`同步完成 · ${okCount} 频道 · ${total} 条消息`, 'success');
      } else if (okCount > 0 && errCount > 0) {
        toast.push(`部分成功：${okCount} 完成，${errCount} 失败`, 'default');
      } else {
        toast.push(`全部 ${errCount} 频道同步失败`, 'error');
      }
      setSyncErrors(data.errors ?? []);
      const sRes = await fetch('/api/slack/status', { cache: 'no-store' });
      setStatus((await sRes.json()) as ConnectionStatus);
      const tRes = await fetch('/api/slack/transcripts', { cache: 'no-store' });
      if (tRes.ok) {
        const td = (await tRes.json()) as { transcripts: TranscriptMeta[] };
        setTranscripts(td.transcripts);
      }
    } finally {
      setSyncing(false);
    }
  };

  const filteredTranscripts =
    transcripts?.filter(
      (t) =>
        !transcriptQuery.trim() ||
        t.title.toLowerCase().includes(transcriptQuery.toLowerCase()) ||
        t.file.toLowerCase().includes(transcriptQuery.toLowerCase())
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
          <Slack size={24} className="text-[#611F69]" strokeWidth={1.8} />
        </div>
        <div className="flex-1">
          <div className="eyebrow mb-1">Rocket Team / 数据接入 / Slack</div>
          <h1 className="display-title">
            {status?.connected ? `已接入 ${status.team}` : '接入 Slack'}
          </h1>
          <p className="prose-warm text-body text-ink-muted mt-2 max-w-2xl">
            {status?.connected
              ? '系统会拉取你选择的频道消息作为画像证据。下方是同步状态 + 已抓取的聊天记录。'
              : '创建一个 Slack App，把它装进 workspace，把 Bot Token 粘进来 —— 系统会拉取频道消息作为画像证据。'}
          </p>
        </div>
        {status?.connected && (
          <button
            onClick={disconnect}
            className="btn-ghost text-caption shrink-0"
          >
            断开
          </button>
        )}
      </header>

      {/* Connected: show channels + transcripts */}
      {status?.connected && (
        <>
          <ConnectedPanel
            channels={channels}
            channelsLoading={channelsLoading}
            selected={selected}
            setSelected={setSelected}
            sync={sync}
            syncing={syncing}
            syncErrors={syncErrors}
            loadChannels={loadChannels}
            status={status}
            toggleAutoSync={toggleAutoSync}
            nextSyncIn={nextSyncIn}
          />

          {/* Transcripts list — like meetings */}
          <section className="mt-10">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-serif text-title text-ink">已同步的聊天记录</h2>
              {transcripts && (
                <span className="text-caption text-ink-quiet">
                  <span className="font-mono text-ink">{transcripts.length}</span> 份
                </span>
              )}
            </div>
            {transcripts && transcripts.length > 0 && (
              <>
                <div className="relative mb-3">
                  <Search
                    size={13}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-quiet"
                  />
                  <input
                    value={transcriptQuery}
                    onChange={(e) => setTranscriptQuery(e.target.value)}
                    placeholder="搜索频道或日期…"
                    className="w-full pl-9 pr-3 py-2 bg-paper-card border border-rule rounded-lg text-[13.5px] outline-none focus:border-coral-mute placeholder:text-ink-quiet"
                  />
                </div>
                <ul className="space-y-1.5">
                  {(filteredTranscripts ?? []).map((t) => (
                    <li key={t.file}>
                      <button
                        onClick={() => setOpenTranscript(t)}
                        className="w-full text-left card-surface p-3 hover:shadow-soft hover:border-rule-strong transition-all flex items-center gap-3"
                      >
                        <div className="w-8 h-8 rounded-md bg-paper-subtle border border-rule-soft flex items-center justify-center shrink-0">
                          <FileText size={13} className="text-coral" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-serif text-[14.5px] text-ink leading-tight truncate">
                            {t.title}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-ink-quiet">
                            {t.date && (
                              <>
                                <Calendar size={10} />
                                <span className="font-mono">{t.date}</span>
                                <span className="text-ink-ghost">·</span>
                              </>
                            )}
                            <span className="font-mono">{t.sizeKb} KB</span>
                            <span className="text-ink-ghost">·</span>
                            <span className="font-mono">{t.lineCount} 行</span>
                          </div>
                        </div>
                        <span className="text-[11px] text-coral self-center shrink-0">查看 →</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {transcripts && transcripts.length === 0 && (
              <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card">
                <p className="text-body text-ink-muted">还没同步过聊天记录。选择上方频道点同步。</p>
              </div>
            )}
            {!transcripts && (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="card-surface p-3 animate-pulse h-14" />
                ))}
              </div>
            )}
          </section>

          {/* Add another workspace */}
          <section className="mt-10 pt-6 border-t border-rule-soft">
            {!showAddWorkspace ? (
              <button
                onClick={() => setShowAddWorkspace(true)}
                className="btn-ghost text-caption inline-flex items-center gap-1.5"
              >
                <Plus size={11} /> 添加另一个 workspace
              </button>
            ) : (
              <SetupWizard
                botToken={botToken}
                setBotToken={setBotToken}
                copy={copy}
                copied={copied}
                connect={connect}
                verifying={verifying}
                onCancel={() => setShowAddWorkspace(false)}
              />
            )}
          </section>
        </>
      )}

      {/* Not connected: full setup wizard */}
      {!status?.connected && (
        <SetupWizard
          botToken={botToken}
          setBotToken={setBotToken}
          copy={copy}
          copied={copied}
          connect={connect}
          verifying={verifying}
        />
      )}

      <MeetingViewer
        file={openTranscript?.file ?? null}
        title={openTranscript?.title}
        date={openTranscript?.date}
        onClose={() => setOpenTranscript(null)}
      />
    </div>
  );
}

function ConnectedPanel({
  channels,
  channelsLoading,
  selected,
  setSelected,
  sync,
  syncing,
  syncErrors,
  loadChannels,
  status,
  toggleAutoSync,
  nextSyncIn
}: {
  channels: SlackChannel[] | null;
  channelsLoading: boolean;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  sync: () => void;
  syncing: boolean;
  syncErrors: Array<{ channel: string; error: string }>;
  loadChannels: () => void;
  status: ConnectionStatus;
  toggleAutoSync: (enabled: boolean) => void;
  nextSyncIn: number | null;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-serif text-title text-ink">频道</h2>
        <div className="flex items-center gap-2">
          <span className="text-caption text-ink-quiet">
            已选 <span className="font-mono text-ink">{selected.size}</span> /{' '}
            {channels?.length ?? '?'}
          </span>
          <button
            onClick={loadChannels}
            disabled={channelsLoading}
            className="btn-ghost text-caption inline-flex items-center gap-1"
          >
            <RefreshCw size={11} className={channelsLoading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
      </div>

      {channelsLoading && !channels && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card-surface p-3 animate-pulse h-10" />
          ))}
        </div>
      )}

      {channels && channels.length === 0 && (
        <div className="rounded-lg border border-dashed border-rule p-6 text-center text-body text-ink-muted">
          Bot 还没加入任何频道。在 Slack 里 <span className="font-mono">/invite @rocket-team</span>{' '}
          邀请它进相关频道。
        </div>
      )}

      {channels && channels.length > 0 && (
        <>
          <div className="rounded-lg border border-rule bg-paper-subtle/50 p-2 mb-3 max-h-[280px] overflow-y-auto">
            {channels.map((c) => {
              const Icon = c.is_private ? Lock : Hash;
              const checked = selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className={`flex items-center gap-3 py-1.5 px-2 rounded-md cursor-pointer hover:bg-paper-card transition-colors ${
                    checked ? 'bg-coral-subtle/40' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const n = new Set(selected);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      setSelected(n);
                    }}
                    className="accent-coral"
                  />
                  <Icon size={13} className="text-ink-quiet" />
                  <span className="font-serif text-[14px] text-ink">{c.name}</span>
                  {c.topic && (
                    <span className="text-[11px] text-ink-quiet truncate flex-1">{c.topic}</span>
                  )}
                  {typeof c.num_members === 'number' && (
                    <span className="ml-auto text-[11px] font-mono text-ink-quiet shrink-0">
                      {c.num_members} 人
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="flex items-center justify-between mb-3">
            <span className="text-caption text-ink-quiet">
              {status.last_sync_at && (
                <span>上次同步 {status.last_sync_at.slice(0, 16).replace('T', ' ')}</span>
              )}
            </span>
            <button
              onClick={sync}
              disabled={syncing || selected.size === 0}
              className="btn-coral inline-flex items-center gap-1.5"
            >
              {syncing ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> 同步中…
                </>
              ) : (
                '同步过去 30 天消息'
              )}
            </button>
          </div>

          {status.last_sync_at && (
            <div className="flex items-center justify-between pb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(status.auto_sync_enabled)}
                  onChange={(e) => toggleAutoSync(e.target.checked)}
                  className="accent-coral"
                />
                <span className="text-[13px] text-ink">
                  每 {status.auto_sync_interval_min ?? 15} 分钟自动同步
                </span>
              </label>
              <span className="text-[11px] text-ink-quiet">
                {status.auto_sync_enabled
                  ? nextSyncIn !== null
                    ? `下次 ${Math.ceil(nextSyncIn / 60)} 分后`
                    : '准备中…'
                  : '关闭页面后停止'}
              </span>
            </div>
          )}

          {syncErrors.length > 0 && (
            <div className="mt-3 rounded-lg border border-rust/40 bg-rust/5 p-3">
              <div className="text-caption text-rust font-medium mb-1.5">
                {syncErrors.length} 个频道无法读取
              </div>
              <ul className="space-y-1">
                {syncErrors.map((e) => (
                  <li
                    key={e.channel}
                    className="text-[12.5px] text-ink-soft leading-snug"
                  >
                    <span className="font-mono text-ink">#{e.channel}</span> · {e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SetupWizard({
  botToken,
  setBotToken,
  copy,
  copied,
  connect,
  verifying,
  onCancel
}: {
  botToken: string;
  setBotToken: (s: string) => void;
  copy: (s: string) => void;
  copied: boolean;
  connect: () => void;
  verifying: boolean;
  onCancel?: () => void;
}) {
  return (
    <ol className="space-y-4">
      <Step n={1} title="创建 Slack App" subtitle="使用 manifest 一键生成">
        <p className="text-body text-ink-soft mb-3">
          打开 Slack API 控制台 → <span className="font-mono text-ink">Create New App</span>
          <span className="font-mono text-ink"> → From a manifest</span>，选 workspace，把下面 YAML 粘进去。
        </p>
        <div className="rounded-lg bg-ink/95 text-paper p-4 mb-3 relative group">
          <button
            onClick={() => copy(BOT_MANIFEST)}
            className="absolute top-2 right-2 text-paper-subtle hover:text-paper opacity-60 group-hover:opacity-100 transition-opacity bg-ink-soft rounded px-2 py-1 text-[11px] flex items-center gap-1"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
          <pre className="text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap overflow-x-auto">
            {BOT_MANIFEST}
          </pre>
        </div>
        <a
          href="https://api.slack.com/apps?new_app=1"
          target="_blank"
          rel="noopener noreferrer"
          className="link-coral inline-flex items-center gap-1 text-caption"
        >
          打开 Slack API 控制台 <ExternalLink size={11} />
        </a>
      </Step>

      <Step n={2} title="安装到 workspace 并粘贴 Bot Token" subtitle="OAuth & Permissions → Install to Workspace">
        <ul className="text-body text-ink-soft mb-3 space-y-1.5 list-disc pl-5">
          <li>
            App 页左栏 <span className="font-mono text-ink">OAuth &amp; Permissions</span> → 顶部
            <span className="font-mono text-ink"> Install to Workspace</span>，确认权限。
          </li>
          <li>
            安装完成后页面顶部显示 <span className="font-mono text-ink">Bot User OAuth Token</span>（以
            <span className="font-mono"> xoxb- </span>开头），复制粘到这里。
          </li>
        </ul>
        <div className="flex gap-2">
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="xoxb-..."
            className="flex-1 font-mono text-[12.5px] bg-paper-card border border-rule rounded-md px-3 py-2 text-ink outline-none focus:border-coral-mute"
          />
          <button
            onClick={connect}
            disabled={verifying || !botToken.trim()}
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
          {onCancel && (
            <button onClick={onCancel} className="btn-ghost text-caption">
              取消
            </button>
          )}
        </div>
      </Step>
    </ol>
  );
}

function Step({
  n,
  title,
  subtitle,
  children
}: {
  n: number;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <li className="card-surface p-5">
      <header className="flex items-start gap-3 mb-4">
        <div className="w-7 h-7 rounded-full flex items-center justify-center font-mono text-[12px] shrink-0 bg-coral text-paper">
          {n}
        </div>
        <div>
          <h2 className="font-serif text-[18px] text-ink leading-tight">{title}</h2>
          <p className="text-caption text-ink-quiet leading-tight mt-0.5">{subtitle}</p>
        </div>
      </header>
      <div className="pl-10">{children}</div>
    </li>
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
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card-surface p-5 animate-pulse h-24" />
        ))}
      </div>
    </div>
  );
}
