'use client';

import Link from 'next/link';
import { Activity, AlertTriangle, Cpu } from 'lucide-react';
import { Avatar } from './Avatar';
import { cn } from './utils';
import type { TeamMemberProfile, Energy } from '@/types';

const ENERGY_DOT: Record<Energy, string> = {
  high: 'bg-forest',
  normal: 'bg-ink-ghost',
  low: 'bg-amber',
  burnt: 'bg-rust',
  unknown: 'bg-ink-ghost'
};

const ENERGY_LABEL: Record<Energy, string> = {
  high: '空闲',
  normal: '平稳',
  low: '忙碌',
  burnt: '超载',
  unknown: '未知'
};

const CARD_PALETTE = {
  border: 'border-rule hover:border-rule-strong',
  tint: 'bg-paper-card'
};

// Dual-mode pair card.
//
// Mode A — narrative task signal present (workload.active or current_tasks):
//   ┌────────────────────────────────────────────────────┐
//   │ ⚡ 重构 auth middleware                [画像推断]   │
//   │   阻塞：等运维开权限                                 │
//   ├────────────────────────────────────────────────────┤
//   │ [sm] 张三 · 研发                  配额 47%*         │
//   └────────────────────────────────────────────────────┘
//
// Mode B — empty state fallback to identity-first card so 23 team members
// scanning for each other still get a strong human signal.
//   ┌────────────────────────────────────────────────────┐
//   │ [md] 张三                              ● 平稳       │
//   │      研发 · 后端负责人                              │
//   ├────────────────────────────────────────────────────┤
//   │ ⚡ Claude Code · 待派任务                           │
//   └────────────────────────────────────────────────────┘
export function PersonAgentCard({ profile }: { profile: TeamMemberProfile }) {
  const agent = profile.agents?.claude_code;
  const energy = profile.energy?.current ?? 'unknown';
  const usage =
    agent?.quota_used_cny !== undefined && agent?.quota_limit_cny !== undefined && agent.quota_limit_cny > 0
      ? Math.min(100, Math.round((agent.quota_used_cny / agent.quota_limit_cny) * 100))
      : null;
  const usageColor =
    usage !== null
      ? usage >= 80
        ? 'text-rust'
        : usage >= 50
          ? 'text-amber'
          : 'text-ink-quiet'
      : 'text-ink-quiet';
  const currentTask = agent?.current_tasks?.[0];
  const activeAssignments = profile.workload?.active ?? [];
  const blockedItems = profile.workload?.blocked_on ?? [];
  const hasNarrativeSignal = activeAssignments.length > 0 || (agent?.current_tasks?.length ?? 0) > 0;

  // Mode A primary line: prefer narrative task description (richer copy) and
  // fall back to the proj_id from workload.active when current_tasks is empty
  // but workload still has signal. Both come from LLM extraction — labelled
  // "画像推断" so the reader knows it isn't telemetry. proj_id is a bare
  // identifier so we prefix it to keep the line readable.
  const primaryTaskLine = currentTask?.description
    ?? (activeAssignments[0]?.proj_id ? `项目 ${activeAssignments[0].proj_id}` : null);
  const blockedHint = blockedItems[0]?.by ?? null;

  return (
    <Link
      href={`/agents/${encodeURIComponent(profile.name)}`}
      className={cn(
        'group flex flex-col rounded-xl border overflow-hidden hover:shadow-soft transition-all h-full',
        CARD_PALETTE.border,
        CARD_PALETTE.tint
      )}
    >
      {hasNarrativeSignal && primaryTaskLine ? (
        <ModeATaskFirst
          name={profile.name}
          dept={profile.dept}
          role={profile.role}
          taskLine={primaryTaskLine}
          blockedHint={blockedHint}
          blockedCount={blockedItems.length}
          usage={usage}
          usageColor={usageColor}
        />
      ) : (
        <ModeBIdentityFallback
          name={profile.name}
          dept={profile.dept}
          role={profile.role}
          energy={energy}
          usage={usage}
          usageColor={usageColor}
        />
      )}
    </Link>
  );
}

function NarrativeBadge() {
  // Inline, low-key marker. Distinguishes inferred copy from telemetry without
  // adding a bright color the leader's eye locks onto. Tooltip is mirrored
  // into aria-label so screen readers + mobile (no hover) get the explanation.
  const explainer = '基于会议记录由模型推断，不是 Claude Code 实时上报';
  return (
    <span
      title={explainer}
      aria-label={`画像推断 — ${explainer}`}
      className="shrink-0 text-[10px] font-mono text-ink-quiet border border-rule-soft rounded px-1.5 py-0.5 leading-none"
    >
      画像推断
    </span>
  );
}

function ModeATaskFirst({
  name,
  dept,
  role,
  taskLine,
  blockedHint,
  blockedCount,
  usage,
  usageColor
}: {
  name: string;
  dept: string;
  role: string;
  taskLine: string;
  blockedHint: string | null;
  blockedCount: number;
  usage: number | null;
  usageColor: string;
}) {
  return (
    <>
      <div className="px-4 pt-3.5 pb-3 flex-1">
        <div className="flex items-start gap-2">
          <Activity size={12} className="text-coral mt-1 shrink-0" strokeWidth={2.4} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div
                title={taskLine}
                className="text-[13.5px] text-ink leading-snug line-clamp-2"
              >
                {taskLine}
              </div>
              <NarrativeBadge />
            </div>
            {blockedCount > 0 && (
              <div className="mt-1.5 flex items-center gap-1 text-[11.5px] text-amber">
                <AlertTriangle size={11} strokeWidth={2.2} className="shrink-0" aria-hidden="true" />
                <span className="truncate">阻塞{blockedHint ? `：${blockedHint}` : ''}</span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="px-4 py-2 border-t border-rule-soft flex items-center gap-2.5">
        <Avatar name={name} dept={dept} size="sm" />
        <div className="min-w-0 flex-1 text-[12px] text-ink-quiet leading-tight truncate">
          <span className="text-ink-soft">{name}</span>
          <span className="mx-1 text-ink-ghost">·</span>
          {dept}
          {role ? <span className="text-ink-ghost"> · {role}</span> : null}
        </div>
        {usage !== null && (
          <span
            title="配额示例值，未接 billing"
            aria-label={`配额 ${usage}%，示例值，未接 billing`}
            className={cn('shrink-0 font-mono text-[11px]', usageColor)}
          >
            配额 {usage}%*
          </span>
        )}
      </div>
    </>
  );
}

function ModeBIdentityFallback({
  name,
  dept,
  role,
  energy,
  usage,
  usageColor
}: {
  name: string;
  dept: string;
  role: string;
  energy: Energy;
  usage: number | null;
  usageColor: string;
}) {
  return (
    <>
      <div className="px-4 py-3 flex items-center gap-3 flex-1">
        <Avatar name={name} dept={dept} size="md" />
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[15px] text-ink leading-tight truncate">{name}</div>
          <div className="text-[11px] text-ink-quiet leading-tight mt-0.5 truncate">
            {dept}
            {role ? ` · ${role}` : ''}
          </div>
        </div>
        <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-quiet shrink-0">
          <span className={cn('w-1.5 h-1.5 rounded-full', ENERGY_DOT[energy])} aria-hidden="true" />
          {ENERGY_LABEL[energy]}
        </span>
      </div>
      <div className="px-4 py-2 border-t border-rule-soft flex items-center gap-2 text-[11.5px] text-ink-quiet">
        <Cpu size={11} strokeWidth={2.2} className="text-coral-deep shrink-0" aria-hidden="true" />
        <span>Claude Code</span>
        <span className="text-ink-ghost">·</span>
        <span>待派任务</span>
        {usage !== null && (
          <span
            title="配额示例值，未接 billing"
            aria-label={`配额 ${usage}%，示例值，未接 billing`}
            className={cn('ml-auto shrink-0 font-mono text-[11px]', usageColor)}
          >
            配额 {usage}%*
          </span>
        )}
      </div>
    </>
  );
}
