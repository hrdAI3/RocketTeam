'use client';

import Link from 'next/link';
import { Cpu, Activity, Zap } from 'lucide-react';
import { Avatar } from './Avatar';
import { ago } from './utils';
import type { TeamMemberProfile } from '@/types';

interface Props {
  profile: TeamMemberProfile;
  variant?: 'card' | 'row';
}

export function AgentInstanceCard({ profile, variant = 'card' }: Props) {
  const agent = profile.agents?.claude_code;
  if (!agent) return null;

  const usage =
    agent.quota_used_cny !== undefined && agent.quota_limit_cny !== undefined && agent.quota_limit_cny > 0
      ? Math.min(100, Math.round((agent.quota_used_cny / agent.quota_limit_cny) * 100))
      : null;
  const usageColor = usage !== null ? (usage >= 80 ? 'bg-rust' : usage >= 50 ? 'bg-amber' : 'bg-forest') : 'bg-paper-deep';
  const current = agent.current_tasks?.[0];

  if (variant === 'row') {
    return (
      <Link
        href={`/agents/${encodeURIComponent(profile.name)}`}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-ink/95 hover:bg-ink transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-coral/20 border border-coral/40 flex items-center justify-center shrink-0">
          <Cpu size={13} className="text-coral" strokeWidth={2.4} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-serif text-[14px] text-paper leading-tight truncate">Claude Code</div>
          {current ? (
            <div className="text-[11.5px] text-paper-subtle leading-tight mt-0.5 truncate">
              <Activity size={9} className="inline -mt-0.5 mr-1 text-coral" />
              {current.description}
            </div>
          ) : (
            <div className="text-[11.5px] text-paper-subtle/60 leading-tight mt-0.5">空闲</div>
          )}
        </div>
        {usage !== null && (
          <div className="flex flex-col items-end shrink-0">
            <span className="text-[10.5px] font-mono text-paper-subtle">{usage}%</span>
            <div className="w-12 h-0.5 bg-paper-subtle/20 rounded-full overflow-hidden mt-0.5">
              <div className={`h-full ${usageColor}`} style={{ width: `${usage}%` }} />
            </div>
          </div>
        )}
      </Link>
    );
  }

  return (
    <Link
      href={`/agents/${encodeURIComponent(profile.name)}`}
      className="block group rounded-xl bg-ink p-4 border border-ink/80 hover:border-coral/60 transition-all hover:shadow-modal"
    >
      <header className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-coral/15 border border-coral/40 flex items-center justify-center shrink-0">
          <Cpu size={18} className="text-coral" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-serif text-[15.5px] text-paper leading-tight">Claude Code</div>
          <div className="text-[11px] font-mono text-paper-subtle leading-tight mt-0.5">
            Anthropic · claude-code
          </div>
        </div>
      </header>

      {/* Quota */}
      {usage !== null && (
        <div className="mb-3">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10.5px] uppercase font-mono text-paper-subtle/70 tracking-wide">
              本月配额
            </span>
            <span className={`text-[11px] font-mono ${usage >= 80 ? 'text-rust' : 'text-paper-subtle'}`}>
              ¥{agent.quota_used_cny}/{agent.quota_limit_cny}
            </span>
          </div>
          <div className="h-1 bg-paper-subtle/20 rounded-full overflow-hidden">
            <div className={`h-full ${usageColor} transition-all`} style={{ width: `${usage}%` }} />
          </div>
        </div>
      )}

      {/* Current task / status */}
      <div className="rounded-lg bg-paper-subtle/10 border border-paper-subtle/15 p-2.5">
        {current ? (
          <>
            <div className="flex items-center gap-1.5 mb-1">
              <Activity size={10} className="text-coral animate-pulse" />
              <span className="text-[10.5px] uppercase font-mono text-coral tracking-wide">正在做</span>
            </div>
            <div className="text-[12.5px] text-paper-subtle leading-snug">{current.description}</div>
          </>
        ) : (
          <div className="text-[11.5px] text-paper-subtle/60 leading-snug">
            空闲 · 等待任务
          </div>
        )}
      </div>

      {/* Owner footer */}
      <footer className="flex items-center gap-2 mt-3 pt-3 border-t border-paper-subtle/15">
        <Avatar name={profile.name} dept={profile.dept} size="xs" />
        <span className="text-[11px] text-paper-subtle">
          归属 <span className="font-serif text-paper">{profile.name}</span> · {profile.dept}
        </span>
        {agent.last_active_at && (
          <span className="ml-auto text-[10px] font-mono text-paper-subtle/50">
            <Zap size={9} className="inline -mt-0.5 mr-0.5" />
            {ago(agent.last_active_at)}
          </span>
        )}
      </footer>
    </Link>
  );
}
