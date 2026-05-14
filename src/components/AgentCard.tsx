'use client';

import Link from 'next/link';
import { Activity, Cpu } from 'lucide-react';
import { cn, ago } from './utils';
import { Avatar } from './Avatar';
import type { TeamMemberProfile, Energy } from '@/types';

interface AgentCardProps {
  profile: TeamMemberProfile;
}

const ENERGY_DOT: Record<Energy, string> = {
  high: 'bg-forest',
  normal: 'bg-ink-ghost',
  low: 'bg-amber',
  burnt: 'bg-rust',
  unknown: 'bg-ink-ghost'
};

const ENERGY_LABEL: Record<Energy, string> = {
  high: 'Available',
  normal: 'Steady',
  low: 'Busy',
  burnt: 'Overloaded',
  unknown: 'Unknown'
};

export function AgentCard({ profile }: AgentCardProps) {
  const tier = profile.tier ?? 'lite';
  const isStub = tier === 'stub';
  const activeTasks = profile.workload?.active ?? [];
  const domains = profile.capabilities?.domains ?? [];
  const focus = profile.trajectory?.learning_focus ?? [];

  return (
    <article
      className={cn(
        'rounded-xl border transition-all duration-200 animate-fade-in',
        isStub
          ? 'bg-paper border-rule border-dashed p-4'
          : tier === 'deep'
            ? 'bg-paper-card border-rule p-5 hover:border-rule-strong hover:shadow-soft'
            : 'bg-paper-card border-rule p-5 hover:shadow-card'
      )}
    >
      <header className="flex items-start gap-3 mb-3">
        <Avatar name={profile.name} dept={profile.dept} size={isStub ? 'sm' : 'lg'} ringed={tier === 'deep'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
            <h3 className="font-serif text-[18px] leading-snug text-ink whitespace-nowrap" title={profile.name}>
              {profile.name}
            </h3>
            {!isStub && (
              <span
                className="inline-flex items-center gap-1 text-[10.5px] text-ink-muted"
                title={`Status · ${ENERGY_LABEL[profile.energy?.current ?? 'unknown']}`}
              >
                <span
                  className={cn('w-1.5 h-1.5 rounded-full', ENERGY_DOT[profile.energy?.current ?? 'unknown'])}
                  aria-hidden
                />
                {ENERGY_LABEL[profile.energy?.current ?? 'unknown']}
              </span>
            )}
            {profile.agents?.claude_code && (
              <span
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-ink/90 text-paper"
                title="Has their own Claude Code agent"
              >
                <Cpu size={9} strokeWidth={2.4} />
                Claude Code
              </span>
            )}
          </div>
          <p className="text-[12px] text-ink-quiet leading-snug">
            {profile.role}
            <span className="text-ink-ghost"> · {profile.dept}</span>
          </p>
        </div>
      </header>

      {profile.bio && !isStub && (
        <p className="quote-soft text-[14px] mb-4">{profile.bio}</p>
      )}

      {!isStub && activeTasks.length > 0 && (
        <div className="mb-3">
          <div className="eyebrow mb-1.5">In progress</div>
          <ul className="space-y-1">
            {activeTasks.slice(0, 3).map((t, i) => (
              <li key={i} className="text-[13.5px] text-ink-soft leading-snug flex gap-2">
                <Activity size={12} className="text-coral mt-1 shrink-0" strokeWidth={2.4} />
                <span>{t.role}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isStub && domains.length > 0 && (
        <div className="mb-3">
          <div className="eyebrow mb-1.5">Domains</div>
          <div className="flex flex-wrap gap-1.5">
            {domains.slice(0, 5).map((d, i) => (
              <span
                key={i}
                className="text-[12px] px-2 py-0.5 rounded-md bg-paper-subtle text-ink-muted font-medium"
              >
                {d.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {!isStub && focus.length > 0 && (
        <div className="mb-3">
          <div className="eyebrow mb-1.5">Focus</div>
          <div className="text-[12.5px] text-ink-muted leading-relaxed">
            {focus.slice(0, 4).map((t, i) => (
              <span key={i}>
                {t}
                {i < Math.min(focus.length, 4) - 1 && <span className="text-ink-ghost mx-1.5">·</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {!isStub && (
        <footer className="pt-3 mt-3 border-t border-rule-soft flex items-center justify-between">
          <span className="text-[11px] font-mono text-ink-quiet">
            {profile._meta?.evolution_count ?? 0} profile update{(profile._meta?.evolution_count ?? 0) === 1 ? '' : 's'} · {ago(profile._meta?.bootstrapped_at)}
          </span>
          <Link
            href={`/agents/${encodeURIComponent(profile.name)}`}
            className="text-[11px] font-medium text-coral hover:text-coral-deep transition-colors"
          >
            View details →
          </Link>
        </footer>
      )}
    </article>
  );
}

