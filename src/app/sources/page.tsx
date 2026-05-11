'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  CheckCircle,
  FileText,
  Github,
  KeyRound,
  Plus,
  RefreshCw,
  Slack,
  ChevronRight,
  type LucideIcon
} from 'lucide-react';

interface GithubStatus {
  connected: boolean;
  org_or_user?: string;
  last_sync_at?: string;
  selected_repos?: Array<{ owner: string; name: string }>;
}
import { useToast } from '../../components/Toast';
import { cn } from '../../components/utils';
import type { TimelineEvent } from '@/types';

const EVENT_ICON: Record<TimelineEvent['type'], LucideIcon> = {
  task_predicted: Activity,
  task_overridden: RefreshCw,
  task_accepted: Activity,
  evolution_applied: Activity,
  bootstrap: Plus,
  override: RefreshCw,
  agent_action: Activity,
  sim_started: Activity,
  sim_completed: CheckCircle
};

const EVENT_LABEL: Record<TimelineEvent['type'], string> = {
  task_predicted: '任务推演',
  task_overridden: '任务改派',
  task_accepted: '任务采纳',
  evolution_applied: '画像更新',
  bootstrap: '画像生成',
  override: '改派',
  agent_action: 'Agent 动作',
  sim_started: '推演启动',
  sim_completed: '推演完成'
};

interface SlackStatus {
  connected: boolean;
  team?: string;
  bot_user_id?: string;
  connected_at?: string;
  last_sync_at?: string;
  selected_channels?: Array<{ id: string; name: string }>;
  auto_sync_enabled?: boolean;
  auto_sync_interval_min?: number;
}

export default function SourcesPage() {
  const toast = useToast();
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [meetingCount, setMeetingCount] = useState<number | null>(null);
  const [resourceCount, setResourceCount] = useState<number | null>(null);
  const [slackTranscriptCount, setSlackTranscriptCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [tlRes, slackRes, githubRes, mRes, rRes, stRes] = await Promise.all([
      fetch('/api/timeline?limit=80', { cache: 'no-store' }),
      fetch('/api/slack/status', { cache: 'no-store' }),
      fetch('/api/github/status', { cache: 'no-store' }).catch(() => null),
      fetch('/api/meetings', { cache: 'no-store' }),
      fetch('/api/resources', { cache: 'no-store' }),
      fetch('/api/slack/transcripts', { cache: 'no-store' }).catch(() => null)
    ]);
    if (tlRes.ok) {
      const d = (await tlRes.json()) as { events: TimelineEvent[] };
      setEvents(d.events);
    }
    if (slackRes.ok) setSlackStatus((await slackRes.json()) as SlackStatus);
    if (githubRes && githubRes.ok)
      setGithubStatus((await githubRes.json()) as GithubStatus);
    if (mRes.ok) {
      const d = (await mRes.json()) as { meetings: Array<unknown> };
      setMeetingCount(d.meetings.length);
    }
    if (rRes.ok) {
      const d = (await rRes.json()) as { resources: Array<unknown> };
      setResourceCount(d.resources.length);
    }
    if (stRes && stRes.ok) {
      const d = (await stRes.json()) as { transcripts: Array<unknown> };
      setSlackTranscriptCount(d.transcripts.length);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <header className="mb-8 max-w-3xl">
        <div className="eyebrow mb-2">Rocket Team / 数据接入</div>
        <h1 className="display-title">数据接入</h1>
        <p className="prose-warm text-body text-ink-muted mt-3">
          连接团队工具、查看会议记录、管理团队资源 —— 所有为画像供血的数据源都在这里。
        </p>
      </header>

      {/* All data sources — single grid */}
      <section className="mb-12">
        <div className="grid grid-cols-2 gap-4">
          <SlackCard status={slackStatus} transcriptCount={slackTranscriptCount} />
          <GithubCard />
          <Link href="/meetings" className="card-surface p-5 hover:shadow-soft transition-all block">
            <header className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center shrink-0">
                  <FileText size={20} strokeWidth={1.8} className="text-coral" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-serif text-[18px] text-ink leading-tight">会议记录</h3>
                  {meetingCount !== null ? (
                    <div className="text-[11px] text-ink-quiet mt-0.5">{meetingCount} 份</div>
                  ) : (
                    <div className="h-3 w-12 bg-paper-deep rounded animate-pulse mt-1" />
                  )}
                </div>
              </div>
              <ChevronRight size={16} className="text-ink-quiet shrink-0 mt-1" />
            </header>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              系统读取的会议纪要。点进去查看全部 + 手动追加 context。
            </p>
          </Link>

          <Link href="/resources" className="card-surface p-5 hover:shadow-soft transition-all block">
            <header className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center shrink-0">
                  <KeyRound size={20} strokeWidth={1.8} className="text-coral" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-serif text-[18px] text-ink leading-tight">团队资源</h3>
                  {resourceCount !== null ? (
                    <div className="text-[11px] text-ink-quiet mt-0.5">{resourceCount} 项</div>
                  ) : (
                    <div className="h-3 w-12 bg-paper-deep rounded animate-pulse mt-1" />
                  )}
                </div>
              </div>
              <ChevronRight size={16} className="text-ink-quiet shrink-0 mt-1" />
            </header>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              共享账号、API key、订阅、域名 —— 谁拥有、谁能用、何时续费。
            </p>
          </Link>
        </div>
      </section>

      {/* 3. Audit log — collapsed */}
      <section>
        <button
          onClick={() => setAuditExpanded((v) => !v)}
          className="w-full flex items-baseline justify-between mb-4 group"
        >
          <h2 className="font-serif text-title text-ink group-hover:text-coral transition-colors">
            审计日志
          </h2>
          <span className="text-caption text-ink-quiet">
            {events ? `${events.length} 条记录` : '—'} ·
            <span className="text-coral ml-1">{auditExpanded ? '收起' : '展开 →'}</span>
          </span>
        </button>
        {!events && (
          <div className="space-y-2">
            <div className="card-surface p-3 animate-pulse h-12" />
            <div className="card-surface p-3 animate-pulse h-12" />
          </div>
        )}
        {events && events.length === 0 && (
          <div className="rounded-xl border border-dashed border-rule p-8 text-center bg-paper-card">
            <p className="text-body text-ink-muted">尚无事件记录。</p>
          </div>
        )}
        {events && events.length > 0 && (
          <div className="card-surface overflow-hidden">
            <ul className="divide-y divide-rule-soft">
              {events.slice(0, auditExpanded ? 50 : 3).map((e, i) => {
                const Icon = EVENT_ICON[e.type] ?? Activity;
                const isOverride = e.type === 'task_overridden' || e.type === 'override';
                const isSim = e.type === 'sim_started' || e.type === 'sim_completed';
                return (
                  <li
                    key={i}
                    className="flex items-start gap-3 py-2.5 px-4 text-body hover:bg-paper-subtle transition-colors group"
                  >
                    <span className="text-[11px] font-mono text-ink-quiet shrink-0 w-[88px] mt-0.5">
                      {(e.ts ?? '').slice(5, 16).replace('T', ' ') || '—'}
                    </span>
                    <Icon
                      size={13}
                      strokeWidth={2.2}
                      className={cn(
                        'shrink-0 mt-1',
                        isOverride ? 'text-amber' : isSim ? 'text-coral' : 'text-ink-muted'
                      )}
                    />
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-paper-subtle text-ink-muted shrink-0 mt-0.5">
                      {EVENT_LABEL[e.type] ?? e.type}
                    </span>
                    <span className="text-ink leading-relaxed flex-1 min-w-0">{e.summary}</span>
                    {e.sim_id && (
                      <a
                        href={`/sim/${e.sim_id}`}
                        className="text-[11px] font-mono text-coral opacity-0 group-hover:opacity-100 transition-opacity shrink-0 self-center"
                      >
                        回放 →
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
            {!auditExpanded && events.length > 5 && (
              <button
                onClick={() => setAuditExpanded(true)}
                className="w-full px-4 py-2.5 border-t border-rule-soft text-[12px] text-coral hover:bg-paper-subtle transition-colors"
              >
                查看更多 {events.length - 5} 条 →
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function SlackCard({
  status,
  transcriptCount
}: {
  status: SlackStatus | null;
  transcriptCount: number | null;
}) {
  const connected = status?.connected;
  return (
    <Link
      href="/sources/slack"
      className="card-surface p-5 hover:shadow-soft transition-all block"
    >
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center shrink-0">
            <Slack size={20} strokeWidth={1.8} className="text-[#611F69]" />
          </div>
          <div className="min-w-0">
            <h3 className="font-serif text-[18px] text-ink leading-tight">Slack</h3>
            <div
              className={`inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-full text-[10.5px] ${
                connected
                  ? 'bg-forest/10 text-forest'
                  : 'bg-coral-subtle text-coral-deep'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-forest' : 'bg-coral'}`}
              />
              {connected ? '已接入' : '可接入'}
            </div>
          </div>
        </div>
        <ChevronRight size={16} className="text-ink-quiet shrink-0 mt-1" />
      </header>
      <p className="text-[13px] text-ink-muted leading-relaxed mb-2">
        {connected
          ? '点击查看接入情况、同步状态、频道列表。'
          : '监听公司 workspace 中的 channel 与 thread，提取每位成员的发言、决策、表态。'}
      </p>
      {connected && (
        <div className="flex flex-wrap gap-3 text-[11px] text-ink-quiet">
          {status?.team && (
            <span>
              workspace: <span className="font-mono text-ink">{status.team}</span>
            </span>
          )}
          {status?.selected_channels && status.selected_channels.length > 0 && (
            <span>
              已同步 <span className="font-mono text-ink">{status.selected_channels.length}</span>{' '}
              个频道
            </span>
          )}
          {transcriptCount !== null && transcriptCount > 0 && (
            <span>
              聊天记录 <span className="font-mono text-ink">{transcriptCount}</span> 份
            </span>
          )}
          {status?.last_sync_at && (
            <span>
              上次同步 {status.last_sync_at.slice(5, 16).replace('T', ' ')}
            </span>
          )}
          {status?.auto_sync_enabled && (
            <span className="text-coral">
              · 自动同步 · 每 {status.auto_sync_interval_min ?? 15} 分
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

function GithubCard() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  useEffect(() => {
    fetch('/api/github/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .then((d) => setStatus(d as GithubStatus))
      .catch(() => setStatus({ connected: false }));
  }, []);
  const connected = status?.connected;
  return (
    <Link
      href="/sources/github"
      className="card-surface p-5 hover:shadow-soft transition-all block"
    >
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center shrink-0">
            <Github size={20} strokeWidth={1.8} className="text-ink" />
          </div>
          <div className="min-w-0">
            <h3 className="font-serif text-[18px] text-ink leading-tight">GitHub</h3>
            <div
              className={`inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-full text-[10.5px] ${
                connected
                  ? 'bg-forest/10 text-forest'
                  : 'bg-coral-subtle text-coral-deep'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-forest' : 'bg-coral'}`}
              />
              {connected ? '已接入' : '可接入'}
            </div>
          </div>
        </div>
        <ChevronRight size={16} className="text-ink-quiet shrink-0 mt-1" />
      </header>
      <p className="text-[13px] text-ink-muted leading-relaxed mb-2">
        {connected
          ? '点击查看接入情况、仓库、PR 同步状态。'
          : '订阅 PR / Issue / Code Review，沉淀代码贡献、评审风格、技术倾向。'}
      </p>
      {connected && (
        <div className="flex flex-wrap gap-3 text-[11px] text-ink-quiet">
          {status?.org_or_user && (
            <span>
              org: <span className="font-mono text-ink">{status.org_or_user}</span>
            </span>
          )}
          {status?.selected_repos && status.selected_repos.length > 0 && (
            <span>
              已同步 <span className="font-mono text-ink">{status.selected_repos.length}</span> 个仓库
            </span>
          )}
          {status?.last_sync_at && (
            <span>上次同步 {status.last_sync_at.slice(5, 16).replace('T', ' ')}</span>
          )}
        </div>
      )}
    </Link>
  );
}

function SourceCard({
  id,
  name,
  description,
  icon: Icon,
  color,
  status,
  meta,
  href
}: {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  color: string;
  status: 'connected' | 'available' | 'coming_soon';
  meta?: string;
  href: string | null;
}) {
  const statusConfig =
    status === 'connected'
      ? { label: '已接入', cls: 'bg-forest/10 text-forest', dot: 'bg-forest' }
      : status === 'available'
        ? { label: '可接入', cls: 'bg-coral-subtle text-coral-deep', dot: 'bg-coral' }
        : { label: '即将上线', cls: 'bg-paper-subtle text-ink-muted', dot: 'bg-ink-ghost' };

  const inner = (
    <article className="card-surface p-5 hover:shadow-soft transition-shadow h-full">
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-paper-subtle border border-rule flex items-center justify-center shrink-0">
            <Icon size={20} strokeWidth={1.8} className={color} />
          </div>
          <div className="min-w-0">
            <h3 className="font-serif text-[18px] text-ink leading-tight">{name}</h3>
            <div
              className={`inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-full text-[10.5px] ${statusConfig.cls}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${statusConfig.dot}`} />
              {statusConfig.label}
            </div>
          </div>
        </div>
      </header>
      <p className="text-[13px] text-ink-muted leading-relaxed mb-2">{description}</p>
      {meta && <div className="text-[11px] text-ink-quiet">{meta}</div>}
    </article>
  );

  if (href) return <Link href={href}>{inner}</Link>;
  return inner;
}
