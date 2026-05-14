'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Activity, Sparkles, Shield, Target, Zap, Pencil, X, Cpu, type LucideIcon } from 'lucide-react';
import { Avatar, MemberInline } from '../../../components/Avatar';
import { ago, deptLabel } from '../../../components/utils';
import { EvolutionDiff } from '../../../components/EvolutionDiff';
import { MeetingViewer } from '../../../components/MeetingViewer';
import { useToast } from '../../../components/Toast';
import type { TeamMemberProfile, Energy, Task, Department } from '@/types';

const ENERGY_LABEL: Record<Energy, string> = {
  high: 'Available',
  normal: 'Steady',
  low: 'Busy',
  burnt: 'Overloaded',
  unknown: 'Unknown'
};

const ENERGY_DOT: Record<Energy, string> = {
  high: 'bg-forest',
  normal: 'bg-ink-ghost',
  low: 'bg-amber',
  burnt: 'bg-rust',
  unknown: 'bg-ink-ghost'
};

export default function PersonDetailPage({ params }: { params: { name: string } }) {
  const decodedName = decodeURIComponent(params.name);
  const toast = useToast();
  const [profile, setProfile] = useState<TeamMemberProfile | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [deptMap, setDeptMap] = useState<Record<string, Department>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionText, setCorrectionText] = useState('');
  const [evolveContext, setEvolveContext] = useState<string | null>(null);
  const [openMeeting, setOpenMeeting] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${decodedName} · Team · Rocket Team`;
  }, [decodedName]);

  useEffect(() => {
    void (async () => {
      try {
        const [pRes, tRes, aRes] = await Promise.all([
          fetch(`/api/agents/${encodeURIComponent(decodedName)}`, { cache: 'no-store' }),
          fetch('/api/tasks', { cache: 'no-store' }),
          fetch('/api/agents', { cache: 'no-store' })
        ]);
        if (!pRes.ok) throw new Error(`Member profile not found (${pRes.status})`);
        const p = (await pRes.json()) as TeamMemberProfile;
        setProfile(p);
        if (tRes.ok) {
          const t = (await tRes.json()) as { tasks: Task[] };
          setTasks(t.tasks);
        }
        if (aRes.ok) {
          const a = (await aRes.json()) as { agents: Array<{ name: string; dept: Department }> };
          const m: Record<string, Department> = {};
          for (const x of a.agents) m[x.name] = x.dept;
          setDeptMap(m);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [decodedName]);

  const relatedTasks = useMemo(() => {
    return tasks.filter((t) => {
      // After override: only the new target sees the task. Original top1 / decomposition
      // assignees no longer have it on their plate.
      if (t.status === 'overridden') return t.override_to === decodedName;
      if (!t.decision) return false;
      const d = t.decision as { top1?: string | null; decomposition?: Array<{ assignee: string }> };
      if (d.top1 === decodedName) return true;
      if (d.decomposition?.some((s) => s.assignee === decodedName)) return true;
      return false;
    });
  }, [tasks, decodedName]);

  if (loading)
    return <div className="px-12 py-10 font-serif text-title text-ink-muted">Loading…</div>;

  if (error || !profile)
    return (
      <div className="px-12 py-10 max-w-[1100px] mx-auto">
        <Link href="/agents" className="text-caption text-ink-muted hover:text-ink inline-flex items-center gap-1 mb-3">
          <ArrowLeft size={12} /> Team
        </Link>
        <div className="card-surface border-rust p-6 max-w-md">
          <div className="font-serif text-title text-rust mb-2">Profile failed to load</div>
          <p className="text-body text-ink-muted">{error ?? 'Unknown error'}</p>
        </div>
      </div>
    );

  const energy = profile.energy?.current ?? 'unknown';

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <div className="flex items-center justify-between mb-3">
        <Link
          href="/agents"
          className="text-caption text-ink-muted hover:text-ink inline-flex items-center gap-1"
        >
          <ArrowLeft size={12} /> Team
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href={`/status/${encodeURIComponent(decodedName)}`}
            className="text-caption link-coral inline-flex items-center gap-1"
          >
            <Activity size={11} /> View status
          </Link>
          <button
            onClick={() => setCorrectionOpen(true)}
            className="btn-ghost text-caption inline-flex items-center gap-1.5"
            title="Align this profile with reality"
          >
            <Pencil size={11} /> Correct profile
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-rule bg-paper-subtle/60 px-4 py-2.5 mb-6 text-[12px] text-ink-muted">
        This is the PMA profile used to simulate who&apos;d own a task (personality, capabilities, collaboration preferences) — a debug reference. To see what{' '}
        <span className="text-ink">{decodedName}</span>&apos;s Claude Code is doing now, go to{' '}
        <Link href={`/status/${encodeURIComponent(decodedName)}`} className="link-coral">Status</Link>.
      </div>

      {/* Hero */}
      <header className="flex items-start gap-6 mb-8">
        <Avatar name={profile.name} dept={profile.dept} size="xl" ringed />
        <div className="flex-1 min-w-0">
          <div className="eyebrow mb-1.5">{deptLabel(profile.dept)} · {profile.role}</div>
          <h1 className="display-title">{profile.name}</h1>
        </div>
        <div className="grid grid-cols-3 gap-px bg-rule rounded-xl overflow-hidden border border-rule shrink-0">
          <Mini label="Status" value={ENERGY_LABEL[energy]} dotClass={ENERGY_DOT[energy]} />
          <Mini label="In progress" value={`${profile.workload?.active.length ?? 0}`} />
          <Mini
            label="Profile updates"
            value={`${profile._meta?.evolution_count ?? 0}`}
            sub={ago(profile._meta?.bootstrapped_at)}
          />
        </div>
      </header>

      {/* Agent + Person presented as a paired hero block. Agent slightly emphasized
          via coral accent + larger panel; person beneath with role / energy. */}
      {profile.agents?.claude_code && (
        <section className="mb-8">
          <div className="rounded-2xl bg-paper-card border border-rule shadow-soft overflow-hidden">
            <div className="relative px-5 py-4 bg-gradient-to-r from-paper-subtle/60 to-transparent">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-coral" aria-hidden />
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-full bg-coral-subtle border border-coral-mute flex items-center justify-center shrink-0">
                  <Cpu size={20} className="text-coral-deep" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-serif text-[17px] text-ink leading-tight">Claude Code</div>
                  <div className="text-[11.5px] font-mono text-ink-quiet leading-tight mt-0.5">
                    Anthropic · claude-code · execution owner
                  </div>
                </div>
                {(() => {
                  const a = profile.agents.claude_code;
                  if (a.quota_used_cny === undefined || a.quota_limit_cny === undefined) return null;
                  const usage = Math.min(100, Math.round((a.quota_used_cny / a.quota_limit_cny) * 100));
                  const usageColor = usage >= 80 ? 'bg-rust' : usage >= 50 ? 'bg-amber' : 'bg-forest';
                  return (
                    <div className="text-right shrink-0">
                      <div className={`text-[11.5px] font-mono ${usage >= 80 ? 'text-rust' : 'text-ink-quiet'}`}>
                        ¥{a.quota_used_cny}/{a.quota_limit_cny}
                      </div>
                      <div className="w-20 h-1 bg-paper-deep rounded-full overflow-hidden mt-1">
                        <div className={`h-full ${usageColor}`} style={{ width: `${usage}%` }} />
                      </div>
                      <div className="text-[10px] text-ink-quiet font-mono mt-0.5">monthly quota</div>
                    </div>
                  );
                })()}
              </div>
              {profile.agents.claude_code.current_tasks &&
                profile.agents.claude_code.current_tasks.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-rule-soft">
                    <div className="eyebrow text-coral mb-1">In flight</div>
                    <ul className="space-y-1">
                      {profile.agents.claude_code.current_tasks.map((t, i) => (
                        <li key={i} className="text-[13px] text-ink-soft leading-snug flex gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-coral mt-2 shrink-0 animate-pulse" />
                          <span>{t.description}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          </div>
        </section>
      )}

      <div className="grid grid-cols-3 gap-5">
        {/* Left: Capabilities + Active work */}
        <div className="col-span-2 space-y-5">
          <Card title="Capabilities" icon={Target}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div>
                <div className="eyebrow mb-2">Domains</div>
                {profile.capabilities?.domains?.length ? (
                  <ul className="space-y-1.5">
                    {profile.capabilities.domains.map((d) => (
                      <CapabilityRow key={d.name} name={d.name} level={d.level} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-caption text-ink-quiet">Insufficient evidence</p>
                )}
              </div>
              <div>
                <div className="eyebrow mb-2">Skills</div>
                {profile.capabilities?.skills?.length ? (
                  <ul className="space-y-1.5">
                    {profile.capabilities.skills.map((s) => (
                      <CapabilityRow key={s.name} name={s.name} level={s.level} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-caption text-ink-quiet">Insufficient evidence</p>
                )}
              </div>
            </div>
          </Card>

          <TasksCard
            title="Active tasks"
            tasks={relatedTasks.filter((t) => t.status === 'predicted' || t.status === 'accepted' || t.status === 'overridden')}
            decodedName={decodedName}
            emptyText="No active tasks"
          />

          {profile.workload?.blocked_on?.length ? (
            <Card title={`Blocked · ${profile.workload.blocked_on.length}`} icon={Shield}>
              <ul className="space-y-2.5">
                {profile.workload.blocked_on.map((b, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber mt-2 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[14.5px] text-ink leading-snug">
                        Blocked by <span className="text-amber">{b.by}</span>
                      </div>
                      {b.evidence?.[0]?.quote && (
                        <p className="text-[12.5px] text-ink-muted leading-relaxed quote-soft mt-1">
                          {b.evidence[0].quote}
                        </p>
                      )}
                      {b.evidence?.[0]?.source_id && (
                        <button
                          onClick={() => setOpenMeeting(b.evidence[0].source_id)}
                          className="text-[11px] text-ink-quiet hover:text-coral mt-1 inline-flex items-center gap-1"
                        >
                          Source · {b.evidence[0].source_id.replace(/\.txt$/, '').slice(0, 30)} <ArrowRight size={10} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <TasksCard
            title="Past completed tasks"
            tasks={relatedTasks.filter((t) => t.status === 'completed')}
            decodedName={decodedName}
            emptyText="No completed tasks yet"
            icon={Sparkles}
          />
        </div>

        {/* Right: agents + collab + trajectory + constraints */}
        <div className="space-y-5">
          <Card title="Frequent collaborators" icon={Sparkles}>
            {(() => {
              const collab = [
                ...(profile.collab?.pairs_well_with ?? []),
                ...(profile.collab?.pairs_poorly_with ?? [])
              ];
              const seen = new Set<string>();
              const unique = collab.filter((p) => {
                if (seen.has(p.name)) return false;
                seen.add(p.name);
                return true;
              });
              return unique.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {unique.map((p, i) => (
                    <MemberInline key={i} name={p.name} dept={deptMap[p.name]} size="xs" />
                  ))}
                </div>
              ) : (
                <p className="text-caption text-ink-quiet">Insufficient evidence</p>
              );
            })()}
          </Card>

          <Card title="Current focus" icon={Zap}>
            {profile.trajectory?.learning_focus?.length ? (
              <ul className="space-y-1">
                {profile.trajectory.learning_focus.map((f, i) => (
                  <li key={i} className="text-[13.5px] text-ink-soft leading-snug">
                    · {f}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-ink-quiet">No clear focus signal yet</p>
            )}
          </Card>

          <Card title="MBTI" icon={Target}>
            <div className="text-[18px] text-ink font-mono tracking-[0.2em]">
              {profile.mbti || 'Untested'}
            </div>
          </Card>

          {profile._meta?.source_files?.length ? (
            <SourceFilesCard
              files={profile._meta.source_files}
              onOpen={(f) => setOpenMeeting(f)}
            />
          ) : null}

          {profile.workload?.hard_constraints?.length ? (
            <Card title="Hard constraints" icon={Shield}>
              <ul className="space-y-1.5">
                {profile.workload.hard_constraints.map((c, i) => (
                  <li key={i} className="text-[13px] text-ink-soft leading-snug">
                    <span className="text-ink-quiet font-mono">{c.kind}</span> · {c.value}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>

      <MeetingViewer
        file={openMeeting}
        onClose={() => setOpenMeeting(null)}
      />

      {correctionOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
          role="dialog"
          aria-modal="true"
          onClick={() => setCorrectionOpen(false)}
        >
          <div
            className="card-warm shadow-modal w-[560px] p-5 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between mb-3">
              <div>
                <h2 className="font-serif text-[18px] text-ink leading-tight">
                  Correct {profile.name}&apos;s profile
                </h2>
                <p className="text-caption text-ink-quiet leading-tight mt-0.5">
                  Describe how reality differs. The system previews the field changes; nothing is written until you confirm.
                </p>
              </div>
              <button
                onClick={() => setCorrectionOpen(false)}
                className="text-ink-quiet hover:text-ink"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>
            <textarea
              value={correctionText}
              onChange={(e) => setCorrectionText(e.target.value)}
              rows={6}
              placeholder={`Examples: ${profile.name} took over project X on May 3 but the profile doesn't reflect it. / They're not strong in React; the profile is too optimistic. / They actually don't pair well with a teammate listed under pairs_well_with.`}
              className="w-full bg-paper-card border border-rule rounded-lg px-3 py-2.5 font-serif text-[14.5px] leading-relaxed text-ink outline-none resize-y placeholder:text-ink-quiet focus:border-coral-mute mb-3"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setCorrectionOpen(false)}
                className="btn-ghost text-caption"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!correctionText.trim()) {
                    toast.push('Describe the discrepancy first', 'error');
                    return;
                  }
                  setEvolveContext(correctionText);
                  setCorrectionOpen(false);
                }}
                className="btn-coral text-caption"
              >
                Preview changes
              </button>
            </div>
          </div>
        </div>
      )}

      {evolveContext && (
        <EvolutionDiff
          open
          agentName={profile.name}
          context={evolveContext}
          onClose={() => setEvolveContext(null)}
          onApplied={() => {
            setEvolveContext(null);
            setCorrectionText('');
            toast.push('Profile updated', 'success');
            void (async () => {
              const r = await fetch(`/api/agents/${encodeURIComponent(profile.name)}`, { cache: 'no-store' });
              if (r.ok) setProfile((await r.json()) as TeamMemberProfile);
            })();
          }}
        />
      )}
    </div>
  );
}

function Card({ title, icon: Icon, children }: { title: string; icon: typeof Sparkles; children: React.ReactNode }) {
  return (
    <section className="card-surface p-5">
      <header className="flex items-center gap-2 mb-3">
        <Icon size={13} className="text-coral" strokeWidth={2.4} />
        <h2 className="font-serif text-[16px] text-ink">{title}</h2>
      </header>
      {children}
    </section>
  );
}

function TasksCard({
  title,
  tasks,
  decodedName,
  emptyText,
  icon
}: {
  title: string;
  tasks: Task[];
  decodedName: string;
  emptyText: string;
  icon?: LucideIcon;
}) {
  const Icon = icon ?? Activity;
  return (
    <Card title={title} icon={Icon}>
      {tasks.length === 0 ? (
        <p className="text-body text-ink-muted">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {tasks.slice(0, 8).map((t) => {
            const d = t.decision as
              | {
                  top1?: string | null;
                  decomposition?: Array<{ assignee: string; subtask: string }>;
                  sim_replay_id?: string;
                }
              | null;
            const subtask = d?.decomposition?.find((s) => s.assignee === decodedName)?.subtask;
            const role =
              t.override_to === decodedName
                ? 'Took over after reassign'
                : subtask
                  ? `Subtask: ${subtask}`
                  : 'Primary owner';
            return (
              <li
                key={t.id}
                className="flex items-start gap-3 py-2 px-3 rounded-lg hover:bg-paper-subtle transition-colors"
              >
                <span className="font-mono text-[10.5px] text-ink-quiet mt-1 shrink-0">
                  {(t.created_at ?? '').slice(5, 10)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-serif text-[14.5px] text-ink leading-snug truncate">
                    {t.description}
                  </div>
                  <div className="text-[11.5px] text-ink-quiet mt-0.5">{role}</div>
                </div>
                {d?.sim_replay_id && (
                  <a
                    href={`/sim/${d.sim_replay_id}`}
                    className="text-[11px] text-coral hover:text-coral-deep self-center shrink-0"
                  >
                    <ArrowRight size={12} />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function SourceFilesCard({ files, onOpen }: { files: string[]; onOpen: (f: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const PREVIEW = 3;
  const cleanLabel = (f: string) =>
    f.replace(/^(meeting|slack)\//, '').replace(/\.txt$/, '');
  return (
    <Card title={`Profile sources · ${files.length}`} icon={Activity}>
      <ul className="space-y-1.5">
        {files.slice(0, PREVIEW).map((f) => (
          <li key={f}>
            <button
              onClick={() => onOpen(f)}
              className="w-full text-left text-[12.5px] text-ink-soft hover:text-coral hover:underline underline-offset-2 leading-snug truncate"
            >
              · {cleanLabel(f) || f}
            </button>
          </li>
        ))}
      </ul>
      {files.length > PREVIEW && (
        <button
          onClick={() => setShowAll(true)}
          className="text-[11px] text-coral hover:text-coral-deep mt-2 inline-flex items-center gap-1"
        >
          View all {files.length} <ArrowRight size={11} />
        </button>
      )}
      {showAll && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm"
          onClick={() => setShowAll(false)}
        >
          <div
            className="bg-paper-card border border-rule rounded-2xl shadow-modal max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="px-5 py-4 border-b border-rule flex items-center justify-between shrink-0">
              <h3 className="font-serif text-[16px] text-ink">Profile sources · all {files.length}</h3>
              <button onClick={() => setShowAll(false)} className="text-ink-quiet hover:text-ink p-1" aria-label="Close">
                <X size={16} />
              </button>
            </header>
            <ul className="overflow-y-auto px-5 py-3 space-y-1.5">
              {files.map((f) => (
                <li key={f}>
                  <button
                    onClick={() => {
                      onOpen(f);
                      setShowAll(false);
                    }}
                    className="w-full text-left text-[13px] text-ink-soft hover:text-coral hover:underline underline-offset-2 leading-snug truncate"
                  >
                    · {cleanLabel(f) || f}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

function Mini({ label, value, sub, dotClass }: { label: string; value: string; sub?: string; dotClass?: string }) {
  return (
    <div className="bg-paper-card px-4 py-3 min-w-[100px]">
      <div className="flex items-baseline gap-1.5">
        {dotClass && <span className={`w-1.5 h-1.5 rounded-full ${dotClass} mb-0.5`} />}
        <div className="font-serif text-[20px] leading-none text-ink">{value}</div>
      </div>
      <div className="eyebrow mt-1.5">{label}</div>
      {sub && <div className="text-[10px] text-ink-quiet mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}

function OwnedAgentRow({ agent }: { agent: NonNullable<TeamMemberProfile['agents']>['claude_code'] }) {
  if (!agent) return null;
  const usage =
    agent.quota_used_cny !== undefined && agent.quota_limit_cny !== undefined
      ? Math.min(100, Math.round((agent.quota_used_cny / agent.quota_limit_cny) * 100))
      : null;
  return (
    <div className="rounded-lg border border-rule-soft bg-paper-subtle/40 p-3">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <div>
          <div className="font-serif text-[14px] text-ink leading-tight">Claude Code</div>
          <div className="text-[10.5px] font-mono text-ink-quiet leading-tight">
            {agent.vendor} · {agent.model_handle}
          </div>
        </div>
        {usage !== null && (
          <span
            className={`text-[10.5px] font-mono ${usage >= 80 ? 'text-rust' : usage >= 50 ? 'text-amber' : 'text-ink-muted'}`}
            title={`Monthly quota ¥${agent.quota_used_cny}/${agent.quota_limit_cny}`}
          >
            {usage}%
          </span>
        )}
      </div>
      {agent.current_tasks.length > 0 && (
        <div className="text-[12px] text-ink-soft leading-snug mb-1">
          <span className="text-ink-quiet">Now: </span>
          {agent.current_tasks[0].description}
        </div>
      )}
    </div>
  );
}

function CapabilityRow({ name, level }: { name: string; level: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-[13.5px] text-ink truncate">{name}</span>
      <div className="flex items-center gap-0.5 shrink-0">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`w-1.5 h-3.5 rounded-sm ${i <= level ? 'bg-coral' : 'bg-paper-deep'}`}
          />
        ))}
      </div>
    </li>
  );
}
