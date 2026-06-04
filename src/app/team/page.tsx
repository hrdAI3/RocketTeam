'use client';

// Team · Org context panel
//
// Shows what the system has accumulated about the team: 12 active members
// (profile + behavior snapshot), curated project knowledge, identity-map
// coverage, event source counts. Read-only by design.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Users, FolderOpen, Trash2 } from 'lucide-react';
import { Avatar, AvatarStack } from '@/components/Avatar';
import type { Department } from '@/types';

interface AgentBrief {
  name: string;
  dept?: Department;
  bio?: string;
  tier?: string;
  energy?: string;
  active_days?: number;
  n_sessions?: number;
  tokens_per_hour_p50?: number;
  // Canonical project chips — same registry/source as /status (LLM
  // work_summary attribution, registry-constrained). is_curated = name
  // also appears in project_knowledge.json.
  active_projects: Array<{
    id: string;
    name: string;
    event_count: number;
    is_curated: boolean;
  }>;
  top_tools: Array<{ name: string; count: number }>;
  stuck_topics: Array<{ topic: string; count: number }>;
  capabilities: { domains: string[]; skills: string[] };
}

interface MergedProject {
  id: string;
  name: string;
  status: 'active' | 'archived';
  description: string;
  aliases: string[];
  observed_cwds_count: number;
  last_attributed_at: string;
  synopsis: string | null;
  owners: string[];
  contributors: string[];
  related_topics: string[];
  curated: boolean;
  top_contributors: Array<{ name: string; event_count: number }>;
}

interface ContextResp {
  agents: AgentBrief[];
  projects: MergedProject[];
  identity: {
    email: Array<[string, string]>;
    github: Array<[string, string]>;
    slack: Array<[string, string]>;
  };
  events: {
    total: number;
    by_source: Record<string, number>;
    latest_ts: string | null;
  };
}

export default function TeamPage() {
  const [data, setData] = useState<ContextResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    fetch('/api/team/context', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else setData(j);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    document.title = 'Team · Rocket Team';
    refresh();
  }, []);

  if (error) {
    return (
      <div className="px-12 py-10 max-w-[1040px] mx-auto">
        <div className="text-coral">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="px-12 py-10 max-w-[1040px] mx-auto">
      <header className="flex items-end justify-between gap-4 mb-9">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Team</div>
          <h1 className="display-title">Team</h1>
          <p className="text-[13px] text-ink-muted mt-2 max-w-2xl leading-relaxed">
            What the predictor knows about the team — profiles, current
            projects, project knowledge, identity coverage, event sources.
            This is the org context every <code className="font-mono text-[12px] px-1 py-0.5 mx-1 bg-paper-subtle rounded">/dispatch</code>{' '}
            reasons over.
          </p>
        </div>
        <button
          onClick={refresh}
          aria-label="Refresh"
          className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {/* KPI strip */}
      {data && <KpiStrip data={data} />}

      {/* Section: members */}
      {data && (
        <Section icon={<Users size={14} />} title="Members" caption={`${data.agents.length} active in the last 30 days`}>
          <div className="grid grid-cols-2 gap-4">
            {data.agents.map((a) => (
              <MemberCard key={a.name} a={a} />
            ))}
          </div>
        </Section>
      )}

      {/* Section: projects — canonical projects.json registry, merged with
          hand-curated project_knowledge.json overlay. Same source as /status. */}
      {data && (
        <Section
          icon={<FolderOpen size={14} />}
          title="Projects"
          caption={`${data.projects.length} active · ${data.projects.filter((p) => p.curated).length} with curated context`}
        >
          <div className="space-y-3">
            {data.projects.map((p) => (
              <ProjectCard key={p.id} p={p} agents={data.agents} onArchived={refresh} />
            ))}
          </div>
        </Section>
      )}

    </div>
  );
}

function KpiStrip({ data }: { data: ContextResp }) {
  const totalActive = data.agents.filter((a) => (a.active_days ?? 0) > 0).length;
  const totalSessions = data.agents.reduce((a, m) => a + (m.n_sessions ?? 0), 0);
  const totalProjects = data.projects.length;
  const identityCovered =
    data.identity.email.length + data.identity.github.length + data.identity.slack.length;
  return (
    <div className="grid grid-cols-4 gap-3 mb-10">
      <Kpi label="Active members" value={`${totalActive}/${data.agents.length}`} />
      <Kpi label="CC sessions (30d)" value={totalSessions.toLocaleString()} />
      <Kpi label="Curated projects" value={totalProjects} />
      <Kpi label="Identity links" value={identityCovered} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-rule bg-paper-card px-5 py-3.5">
      <div className="eyebrow mb-1.5">{label}</div>
      <div className="font-serif text-[22px] text-ink tabular-nums leading-none">{value}</div>
    </div>
  );
}

function Section({
  icon,
  title,
  caption,
  children
}: {
  icon: React.ReactNode;
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <div className="mb-4 pb-3 border-b border-rule">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-ink-quiet">{icon}</span>
            <h2 className="font-serif text-[20px] text-ink leading-snug">{title}</h2>
          </div>
          {caption && <span className="text-[12px] text-ink-muted shrink-0">{caption}</span>}
        </div>
      </div>
      {children}
    </section>
  );
}

const ENERGY_TONE: Record<string, { dot: string; label: string }> = {
  high: { dot: 'bg-forest', label: 'Productive' },
  normal: { dot: 'bg-ink-ghost', label: 'Steady' },
  low: { dot: 'bg-amber', label: 'Low' },
  burnt: { dot: 'bg-coral', label: 'Burnt' },
  unknown: { dot: 'bg-ink-ghost', label: 'Unknown' }
};

function MemberCard({ a }: { a: AgentBrief }) {
  const energy = ENERGY_TONE[a.energy ?? 'unknown'] ?? ENERGY_TONE.unknown;
  const skills = [...a.capabilities.domains, ...a.capabilities.skills].slice(0, 4);
  return (
    <Link
      href={`/team/${encodeURIComponent(a.name)}`}
      className="rounded-xl border border-rule bg-paper-card px-5 py-4 hover:border-rule-strong transition-colors block"
    >
      <div className="flex items-start gap-3 mb-3">
        <Avatar name={a.name} dept={a.dept ?? '产品'} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="font-serif text-[18px] text-ink leading-tight">{a.name}</div>
          <div className="flex items-center gap-2 mt-1 text-[10.5px] text-ink-quiet">
            <span className="inline-flex items-center gap-1">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${energy.dot}`} />
              {energy.label}
            </span>
            {a.active_days != null && (
              <>
                <span>·</span>
                <span className="tabular-nums">{a.active_days}d / 30 active</span>
              </>
            )}
            {a.n_sessions != null && (
              <>
                <span>·</span>
                <span className="tabular-nums">{a.n_sessions} sessions</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Active projects — canonical (same registry as /status) */}
      {a.active_projects.length > 0 && (
        <div className="mb-2.5">
          <div className="text-[10px] uppercase tracking-wider text-ink-quiet mb-1">
            Active projects
          </div>
          <div className="flex flex-wrap gap-1.5">
            {a.active_projects.slice(0, 4).map((p) => (
              <Link
                key={p.id}
                href={`/status/project/${encodeURIComponent(p.id)}`}
                onClick={(e) => e.stopPropagation()}
                className="text-[11px] px-2 py-0.5 rounded-full border border-rule bg-paper-subtle text-ink-soft font-serif transition-colors hover:border-coral/40 hover:text-coral-deep"
              >
                {p.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Skills */}
      {skills.length > 0 && (
        <div className="mb-2.5">
          <div className="text-[10px] uppercase tracking-wider text-ink-quiet mb-1">
            Self-reported skills
          </div>
          <div className="text-[11.5px] text-ink-muted leading-relaxed">{skills.join(' · ')}</div>
        </div>
      )}
    </Link>
  );
}

function ProjectCard({
  p,
  agents,
  onArchived
}: {
  p: MergedProject;
  agents: AgentBrief[];
  onArchived: () => void;
}) {
  const agentByName = (n: string) => agents.find((a) => a.name === n);
  // Owners shown: curated owners first; fall back to inferred top contributor
  const ownersToShow = p.owners.length > 0 ? p.owners : p.top_contributors.slice(0, 1).map((c) => c.name);
  const contribsToShow = p.contributors.length > 0
    ? p.contributors
    : p.top_contributors.filter((c) => !ownersToShow.includes(c.name)).map((c) => c.name);
  // Curated projects (hand-written in project_knowledge.json) and virtual:*
  // synthesized rows are not archivable from the UI:
  //   - virtual:*  → no registry row to flip.
  //   - curated    → archiving the canonical row just makes Step 3 of
  //                  buildMergedProjects synthesize the same entry as
  //                  virtual:<name> on next render. Net effect: confusing
  //                  flip. Leader edits private/project_knowledge.json by
  //                  hand to retire a curated project.
  const archivable = !p.id.startsWith('virtual:') && !p.curated;
  const [archiving, setArchiving] = useState(false);
  const handleArchive = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Archive project "${p.name}"? It will stop appearing on /team and stop receiving auto-attributions. Data is preserved (status='archived' in projects.json).`)) return;
    setArchiving(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'leader archived from /team' })
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        alert(`Archive failed: ${data.error ?? res.status}`);
        return;
      }
      onArchived();
    } finally {
      setArchiving(false);
    }
  };
  return (
    <Link
      href={`/status/project/${encodeURIComponent(p.id)}`}
      className="block rounded-xl border border-rule bg-paper-card px-5 py-4 hover:border-rule-strong transition-colors"
    >
      <div className="flex items-baseline justify-between gap-4 mb-2">
        <div className="flex items-baseline gap-2">
          <h3 className="font-serif text-[18px] text-ink leading-tight">{p.name}</h3>
          {!p.curated && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-paper-subtle text-ink-quiet border border-rule">
              auto
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[10.5px] text-ink-quiet tabular-nums">
            {p.observed_cwds_count} cwds · last {p.last_attributed_at.slice(0, 10)}
          </span>
          {archivable && (
            <button
              onClick={handleArchive}
              disabled={archiving}
              aria-label={`Archive ${p.name}`}
              title="Archive project (soft delete)"
              className="p-1 rounded text-ink-quiet hover:text-coral hover:bg-coral/8 transition-colors disabled:opacity-40 disabled:cursor-wait"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {p.synopsis ? (
        <p className="text-[13px] text-ink-soft leading-relaxed mb-3">{p.synopsis}</p>
      ) : p.description ? (
        <p className="text-[12.5px] text-ink-muted leading-relaxed mb-3 italic">{p.description}</p>
      ) : null}

      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
        {ownersToShow.length > 0 && (
          <>
            <div className="text-ink-quiet">{p.owners.length > 0 ? 'Owners' : 'Top contributor'}</div>
            <div className="flex flex-wrap gap-1.5">
              {ownersToShow.map((n) => {
                const ag = agentByName(n);
                return (
                  <span
                    key={n}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-coral/8 border border-coral/30"
                  >
                    <Avatar name={n} dept={ag?.dept ?? '产品'} size="sm" />
                    <span className="font-serif text-[12.5px] text-coral-deep">{n}</span>
                  </span>
                );
              })}
            </div>
          </>
        )}

        {contribsToShow.length > 0 && (
          <>
            <div className="text-ink-quiet">Contributors</div>
            <div className="flex items-center gap-2">
              <AvatarStack
                names={contribsToShow}
                deptOf={(n) => agentByName(n)?.dept}
                size="sm"
                max={5}
              />
              <span className="text-[11px] text-ink-quiet tabular-nums">
                {contribsToShow.length} {contribsToShow.length === 1 ? 'person' : 'people'}
              </span>
            </div>
          </>
        )}

        {p.related_topics.length > 0 && (
          <>
            <div className="text-ink-quiet">Topics</div>
            <div className="flex flex-wrap gap-1">
              {p.related_topics.map((t) => (
                <span
                  key={t}
                  className="text-[10.5px] px-1.5 py-0.5 rounded bg-paper-subtle border border-rule text-ink-muted"
                >
                  {t}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </Link>
  );
}

