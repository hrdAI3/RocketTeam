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
  ChevronDown,
  Hash,
  Lock,
  Loader2,
  RefreshCw,
  Plus,
  Search
} from 'lucide-react';
import { useToast } from '../../../components/Toast';
import { MeetingViewer } from '../../../components/MeetingViewer';

const BOT_MANIFEST = `display_information:
  name: Rocket Team
  description: Distill your team's Slack discussions into per-member profiles
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
      - team:read
      - chat:write
      - im:write`;

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

interface ChannelGroup {
  channel: string;
  days: TranscriptMeta[]; // newest first
  totalLines: number;
  lastDate?: string;
  firstDate?: string;
}

// Files are stored as `slack-<channel>-<YYYY-MM-DD>.txt`; the channel name can
// itself contain hyphens, so peel off the `slack-` prefix and the `-YYYY-MM-DD`
// suffix rather than splitting on `-`. The transcript metadata doesn't carry a
// `date` field, so we derive it from the filename too.
function channelOf(file: string): string {
  return file.replace(/^slack-/, '').replace(/-\d{4}-\d{2}-\d{2}\.(txt|md)$/i, '');
}
function dateOf(file: string): string | undefined {
  return /(\d{4}-\d{2}-\d{2})\.(txt|md)$/i.exec(file)?.[1];
}
function fmtDate(d?: string): string {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}
function weekday(d?: string): string {
  if (!d) return '';
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return '';
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()] ?? '';
}
// Transcript files carry a 2-line header (`# Slack #ch` + a metadata line),
// so the message count is the line count minus that.
function msgCount(lineCount: number): number {
  return Math.max(0, lineCount - 2);
}

function groupByChannel(transcripts: TranscriptMeta[]): ChannelGroup[] {
  const map = new Map<string, ChannelGroup>();
  for (const t of transcripts) {
    const ch = channelOf(t.file);
    let g = map.get(ch);
    if (!g) {
      g = { channel: ch, days: [], totalLines: 0 };
      map.set(ch, g);
    }
    g.days.push(t);
    g.totalLines += t.lineCount;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.days.sort((a, b) => (dateOf(b.file) ?? '').localeCompare(dateOf(a.file) ?? ''));
    g.lastDate = dateOf(g.days[0]?.file ?? '');
    g.firstDate = dateOf(g.days[g.days.length - 1]?.file ?? '');
  }
  // Channels with the most recent activity first.
  groups.sort((a, b) => (b.lastDate ?? '').localeCompare(a.lastDate ?? ''));
  return groups;
}

export default function SlackOnboardPage() {
  const toast = useToast();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [transcripts, setTranscripts] = useState<TranscriptMeta[] | null>(null);
  const [openTranscript, setOpenTranscript] = useState<TranscriptMeta | null>(null);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [openChannels, setOpenChannels] = useState<Set<string>>(new Set());

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
          if (total > 0) toast.push(`Auto-sync · ${total} new message${total === 1 ? '' : 's'}`, 'success');
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
      toast.push('Copied', 'success');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.push('Copy failed', 'error');
    }
  };

  const connect = async () => {
    if (!botToken.startsWith('xoxb-')) {
      toast.push('Bot token must start with xoxb-', 'error');
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
        toast.push(data.error ?? `Verification failed ${res.status}`, 'error');
        return;
      }
      toast.push(`Connected to ${data.team}`, 'success');
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
    if (!confirm('Disconnect Slack? Already-synced message files will be kept.')) return;
    await fetch('/api/slack/disconnect', { method: 'POST' });
    setStatus({ connected: false });
    setChannels(null);
    setSelected(new Set());
    toast.push('Disconnected', 'success');
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
      toast.push(enabled ? 'Auto-sync enabled' : 'Auto-sync disabled', 'success');
    } catch (err) {
      toast.push((err as Error).message, 'error');
    }
  };

  const sync = async () => {
    if (selected.size === 0 || !channels) {
      toast.push('Select a channel first', 'error');
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
        toast.push(data.error ?? 'Sync failed', 'error');
        return;
      }
      const total = (data.written ?? []).reduce((a, w) => a + w.messages, 0);
      const okCount = data.written?.length ?? 0;
      const errCount = data.errors?.length ?? 0;
      if (okCount > 0 && errCount === 0) {
        toast.push(`Sync complete · ${okCount} channel${okCount === 1 ? '' : 's'} · ${total} message${total === 1 ? '' : 's'}`, 'success');
      } else if (okCount > 0 && errCount > 0) {
        toast.push(`Partial success: ${okCount} done, ${errCount} failed`, 'default');
      } else {
        toast.push(`All ${errCount} channel${errCount === 1 ? '' : 's'} failed to sync`, 'error');
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

  const q = transcriptQuery.trim().toLowerCase();
  const searching = q.length > 0;
  const channelGroups = transcripts ? groupByChannel(transcripts) : null;
  const filteredGroups: ChannelGroup[] | null = channelGroups
    ? channelGroups
        .map((g) => {
          if (!q) return g;
          if (g.channel.toLowerCase().includes(q)) return g;
          const days = g.days.filter(
            (d) => (dateOf(d.file) ?? '').includes(q) || d.title.toLowerCase().includes(q)
          );
          return days.length > 0 ? { ...g, days } : null;
        })
        .filter((g): g is ChannelGroup => g !== null)
    : null;
  const toggleChannel = (ch: string) => {
    setOpenChannels((s) => {
      const n = new Set(s);
      if (n.has(ch)) n.delete(ch);
      else n.add(ch);
      return n;
    });
  };

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
          <Slack size={24} className="text-[#611F69]" strokeWidth={1.8} />
        </div>
        <div className="flex-1">
          <div className="eyebrow mb-1">Rocket Team / Sources / Slack</div>
          <h1 className="display-title">
            {status?.connected ? `Connected to ${status.team}` : 'Connect Slack'}
          </h1>
          <p className="prose-warm text-body text-ink-muted mt-2 max-w-2xl">
            {status?.connected
              ? 'The system pulls messages from your selected channels as profile evidence. Sync status and fetched transcripts are below.'
              : 'Create a Slack App, install it into your workspace, and paste the Bot Token here. The system will pull channel messages as profile evidence.'}
          </p>
        </div>
        {status?.connected && (
          <button
            onClick={disconnect}
            className="btn-ghost text-caption shrink-0"
          >
            Disconnect
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

          {/* Transcripts — one row per channel; expand a channel to see its
              day-by-day messages (each day opens the transcript viewer). */}
          <section className="mt-10">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-serif text-title text-ink">Synced transcripts</h2>
              {channelGroups && transcripts && (
                <span className="text-caption text-ink-quiet tabular-nums">
                  <span className="font-mono text-ink">{channelGroups.length}</span> channel{channelGroups.length === 1 ? '' : 's'} ·{' '}
                  <span className="font-mono text-ink">{transcripts.length}</span> day{transcripts.length === 1 ? '' : 's'}
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
                    placeholder="Search channel or date…"
                    className="w-full pl-9 pr-3 py-2 bg-paper-card border border-rule rounded-lg text-[13.5px] outline-none focus:border-coral-mute placeholder:text-ink-quiet"
                  />
                </div>
                <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
                  {(filteredGroups ?? []).map((g) => {
                    const open = searching || openChannels.has(g.channel);
                    const totalMsgs = g.days.reduce((a, d) => a + msgCount(d.lineCount), 0);
                    return (
                      <div key={g.channel}>
                        <button
                          onClick={() => toggleChannel(g.channel)}
                          className={`w-full flex items-baseline gap-3 px-4 py-3.5 text-left transition-colors ${
                            open ? 'bg-paper-subtle' : 'bg-paper-card hover:bg-paper-subtle'
                          }`}
                        >
                          <Hash size={13} className="text-[#611F69]/60 shrink-0 self-center" strokeWidth={2.4} />
                          <span className="font-serif text-[15.5px] text-ink shrink-0">{g.channel}</span>
                          <span className="text-[12px] text-ink-quiet tabular-nums shrink-0">
                            {g.days.length} day{g.days.length === 1 ? '' : 's'} · {totalMsgs} msg{totalMsgs === 1 ? '' : 's'}
                          </span>
                          <span className="ml-auto text-[12px] text-ink-quiet tabular-nums shrink-0">
                            latest {fmtDate(g.lastDate)}
                          </span>
                          {open ? (
                            <ChevronDown size={14} className="text-ink-quiet shrink-0 self-center" />
                          ) : (
                            <ChevronRight size={14} className="text-ink-quiet shrink-0 self-center" />
                          )}
                        </button>
                        {open && (
                          <div className="bg-paper-subtle/30 border-t border-rule-soft divide-y divide-rule-soft">
                            {g.days.map((d) => {
                              const dt = dateOf(d.file);
                              return (
                                <button
                                  key={d.file}
                                  onClick={() => setOpenTranscript(d)}
                                  className="group w-full flex items-baseline gap-2.5 pl-12 pr-4 py-2 text-left hover:bg-paper-card transition-colors"
                                >
                                  <span className="font-serif text-[14px] text-ink shrink-0 w-[4.5rem] tabular-nums">{fmtDate(dt)}</span>
                                  <span className="text-[11.5px] text-ink-quiet shrink-0 w-8 whitespace-nowrap">{dt ? weekday(dt) : ''}</span>
                                  <span className="text-ink-ghost shrink-0">·</span>
                                  <span className="text-[12.5px] text-ink-quiet shrink-0 tabular-nums">{msgCount(d.lineCount)} msg{msgCount(d.lineCount) === 1 ? '' : 's'}</span>
                                  <ChevronRight size={13} className="text-ink-quiet shrink-0 self-center ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {searching && (filteredGroups?.length ?? 0) === 0 && (
                  <div className="rounded-xl border border-dashed border-rule p-6 text-center text-[13px] text-ink-muted mt-2">
                    No matching channel or date.
                  </div>
                )}
              </>
            )}
            {transcripts && transcripts.length === 0 && (
              <div className="rounded-xl border border-dashed border-rule p-10 text-center bg-paper-card">
                <p className="text-body text-ink-muted">No transcripts synced yet. Select channels above and click sync.</p>
              </div>
            )}
            {!transcripts && (
              <div className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-11 bg-paper-card animate-pulse" />
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
                <Plus size={11} /> Add another workspace
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
        title={openTranscript ? `#${channelOf(openTranscript.file)} · ${fmtDate(dateOf(openTranscript.file))}` : undefined}
        date={openTranscript ? dateOf(openTranscript.file) : undefined}
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
        <h2 className="font-serif text-title text-ink">Channels</h2>
        <div className="flex items-center gap-2">
          <span className="text-caption text-ink-quiet">
            <span className="font-mono text-ink">{selected.size}</span> /{' '}
            {channels?.length ?? '?'} selected
          </span>
          <button
            onClick={loadChannels}
            disabled={channelsLoading}
            className="btn-ghost text-caption inline-flex items-center gap-1"
          >
            <RefreshCw size={11} className={channelsLoading ? 'animate-spin' : ''} /> Refresh
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
          The bot hasn&apos;t joined any channels yet. In Slack, run{' '}
          <span className="font-mono">/invite @rocket-team</span> in each channel to add it.
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
                      {c.num_members} member{c.num_members === 1 ? '' : 's'}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="flex items-center justify-between mb-3">
            <span className="text-caption text-ink-quiet">
              {status.last_sync_at && (
                <span>Last synced {status.last_sync_at.slice(0, 16).replace('T', ' ')}</span>
              )}
            </span>
            <button
              onClick={sync}
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
            <div className="flex items-center justify-between pb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(status.auto_sync_enabled)}
                  onChange={(e) => toggleAutoSync(e.target.checked)}
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

          {syncErrors.length > 0 && (
            <div className="mt-3 rounded-lg border border-rust/40 bg-rust/5 p-3">
              <div className="text-caption text-rust font-medium mb-1.5">
                {syncErrors.length} channel{syncErrors.length === 1 ? '' : 's'} unreadable
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
      <Step n={1} title="Create a Slack App" subtitle="Generate from a manifest">
        <p className="text-body text-ink-soft mb-3">
          Open the Slack API console → <span className="font-mono text-ink">Create New App</span>
          <span className="font-mono text-ink"> → From a manifest</span>, pick a workspace, and paste the YAML below.
        </p>
        <div className="rounded-lg bg-ink/95 text-paper p-4 mb-3 relative group">
          <button
            onClick={() => copy(BOT_MANIFEST)}
            className="absolute top-2 right-2 text-paper-subtle hover:text-paper opacity-60 group-hover:opacity-100 transition-opacity bg-ink-soft rounded px-2 py-1 text-[11px] flex items-center gap-1"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
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
          Open the Slack API console <ExternalLink size={11} />
        </a>
      </Step>

      <Step n={2} title="Install to workspace and paste the Bot Token" subtitle="OAuth & Permissions → Install to Workspace">
        <ul className="text-body text-ink-soft mb-3 space-y-1.5 list-disc pl-5">
          <li>
            In the app sidebar, click <span className="font-mono text-ink">OAuth &amp; Permissions</span> →
            <span className="font-mono text-ink"> Install to Workspace</span>, then confirm the scopes.
          </li>
          <li>
            After install, the page shows a <span className="font-mono text-ink">Bot User OAuth Token</span>
            (starts with <span className="font-mono">xoxb-</span>). Copy it and paste below.
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
                <Loader2 size={12} className="animate-spin" /> Verifying…
              </>
            ) : (
              'Connect'
            )}
          </button>
          {onCancel && (
            <button onClick={onCancel} className="btn-ghost text-caption">
              Cancel
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
