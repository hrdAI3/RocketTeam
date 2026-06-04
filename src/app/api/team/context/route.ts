// GET /api/team/context
//
// Aggregate "org context" for the Team panel:
//   - 12 agent profiles (role / dept / capabilities / energy)
//   - latest behavior snapshot per agent (current projects, top tools)
//   - curated project knowledge (synopsis / owners / contributors)
//   - identity map coverage (email/slack/github → name)
//   - event source counts
//
// Read-only aggregation. Nothing heavy.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { PATHS } from '@/lib/paths';
import { loadOrBuildSnapshots } from '@/predict/snapshot_loader';
import { loadProjectKnowledge } from '@/lib/project_knowledge';
import { readProjects } from '@/lib/projects';
import { readCachedSummaries } from '@/services/work_summary';
import { memoTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

interface IdentityFile {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

interface AgentBrief {
  name: string;
  dept?: string;
  bio?: string;
  tier?: string;
  energy?: string;
  active_days?: number;
  n_sessions?: number;
  tokens_per_hour_p50?: number;
  // Distinct registry projects this agent contributed to, sourced from
  // their cached LLM work-summary (same source `/status` chips use).
  // event_count = number of work_summary items attributed to that project.
  // is_curated = name appears in project_knowledge.json.
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

async function loadAgentBriefs(
  knowledge: Record<string, import('@/lib/project_knowledge').ProjectKnowledgeEntry>
): Promise<AgentBrief[]> {
  const bundle = await loadOrBuildSnapshots({ windowDays: 30 });
  const [registry, summaries] = await Promise.all([readProjects(), readCachedSummaries()]);

  // Registry id → canonical display name (drop archived — UI won't navigate)
  const idToName = new Map<string, string>();
  for (const p of registry.projects) {
    if (p.status === 'archived') continue;
    idToName.set(p.id, p.name);
  }
  // Curated set keyed by lowercased canonical name (and aliases) for "is curated?" check
  const curatedNames = new Set<string>();
  for (const [knownName, entry] of Object.entries(knowledge)) {
    curatedNames.add(knownName.toLowerCase());
    for (const a of entry.aliases ?? []) curatedNames.add(a.toLowerCase());
  }

  // Build email → canonical agent name from identity.json so we can fold
  // `unknown:email:<addr>` work_summary cache entries into the right agent.
  // The summary cache often holds duplicate identities (e.g. work done by
  // someone signed in via personal Gmail before identity was mapped).
  const emailToAgent = new Map<string, string>();
  try {
    const raw = await fs.readFile(PATHS.identityMap, 'utf8');
    const j = JSON.parse(raw) as IdentityFile;
    for (const [addr, agent] of Object.entries(j.email ?? {})) {
      emailToAgent.set(addr.toLowerCase(), agent);
    }
  } catch {
    /* identity missing — proceed without email aliasing */
  }
  // Resolve a per-agent merged items list (canonical key + all aliased emails).
  type WorkItemLite = { projectId?: string };
  const itemsForAgent = (name: string): WorkItemLite[] => {
    const own = (summaries.get(name)?.items ?? []) as WorkItemLite[];
    const aliased: WorkItemLite[] = [];
    for (const [key, val] of summaries) {
      if (!key.startsWith('unknown:email:')) continue;
      const email = key.slice('unknown:email:'.length).toLowerCase();
      if (emailToAgent.get(email) === name) aliased.push(...(val.items as WorkItemLite[]));
    }
    return [...own, ...aliased];
  };

  const files = await fs.readdir(PATHS.agents);
  const briefs: AgentBrief[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const name = f.replace(/\.json$/, '');
    try {
      const raw = await fs.readFile(join(PATHS.agents, f), 'utf8');
      const p = JSON.parse(raw) as {
        name: string;
        dept?: string;
        bio?: string;
        tier?: string;
        capabilities?: {
          domains?: Array<{ name: string }>;
          skills?: Array<{ name: string }>;
        };
      };
      const snap = bundle.snapshots.get(name);
      const topTools = snap
        ? Object.entries(snap.tool_usage)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([n, c]) => ({ name: n, count: c }))
        : [];
      // Active projects = registry-resolved projectIds from this agent's
      // cached work_summary items (same source `/status` chips use), plus
      // any `unknown:email:*` cache rows that identity.json links to them.
      // Each item is one LLM-attributed work entry; we count items per
      // project. "unclear" / "new:*" / archived ids are dropped — they're
      // not navigable. Empty list → UI shows "No mapped projects".
      const itemCounts = new Map<string, number>();
      for (const it of itemsForAgent(name)) {
        const pid = it.projectId;
        if (!pid || pid === 'unclear' || pid.startsWith('new:')) continue;
        const display = idToName.get(pid);
        if (!display) continue;
        itemCounts.set(pid, (itemCounts.get(pid) ?? 0) + 1);
      }
      const active_projects: AgentBrief['active_projects'] = Array.from(itemCounts.entries())
        .map(([pid, n]) => {
          const display = idToName.get(pid)!;
          return {
            id: pid,
            name: display,
            event_count: n,
            is_curated: curatedNames.has(display.toLowerCase())
          };
        })
        .sort((a, b) => b.event_count - a.event_count)
        .slice(0, 5);

      briefs.push({
        name,
        dept: p.dept,
        bio: p.bio,
        tier: p.tier,
        energy: snap?.energy_inferred,
        active_days: snap?.active_days_in_window,
        n_sessions: snap?.n_sessions,
        tokens_per_hour_p50: snap?.cc_tokens_per_hour_p50,
        active_projects,
        top_tools: topTools,
        stuck_topics:
          snap?.stuck_topics.slice(0, 4).map((t) => ({ topic: t.topic, count: t.count })) ?? [],
        capabilities: {
          domains: p.capabilities?.domains?.map((d) => d.name) ?? [],
          skills: p.capabilities?.skills?.map((s) => s.name) ?? []
        }
      });
    } catch {
      /* skip corrupt */
    }
  }
  // Sort by activity intensity (recent active days desc, sessions desc).
  briefs.sort((a, b) => {
    const ad = (b.active_days ?? 0) - (a.active_days ?? 0);
    if (ad !== 0) return ad;
    return (b.n_sessions ?? 0) - (a.n_sessions ?? 0);
  });
  return briefs;
}

async function loadIdentity(): Promise<{
  email: Array<[string, string]>;
  github: Array<[string, string]>;
  slack: Array<[string, string]>;
}> {
  try {
    const raw = await fs.readFile(PATHS.identityMap, 'utf8');
    const j = JSON.parse(raw) as IdentityFile;
    return {
      email: Object.entries(j.email ?? {}),
      github: Object.entries(j.github ?? {}),
      slack: Object.entries(j.slack ?? {})
    };
  } catch {
    return { email: [], github: [], slack: [] };
  }
}

async function loadEventCounts(): Promise<{
  total: number;
  by_source: Record<string, number>;
  latest_ts: string | null;
}> {
  try {
    const raw = await fs.readFile(PATHS.events, 'utf8');
    const lines = raw.split('\n');
    const by_source: Record<string, number> = {};
    let total = 0;
    let latest_ts: string | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { source?: string; ts?: string };
        total += 1;
        if (e.source) by_source[e.source] = (by_source[e.source] ?? 0) + 1;
        if (e.ts && (!latest_ts || e.ts > latest_ts)) latest_ts = e.ts;
      } catch {
        /* skip */
      }
    }
    return { total, by_source, latest_ts };
  } catch {
    return { total: 0, by_source: {}, latest_ts: null };
  }
}

export interface MergedProject {
  id: string;                 // canonical project id (from projects.json)
  name: string;
  status: 'active' | 'archived';
  description: string;        // auto-derived from GH About / cwd hint
  aliases: string[];
  observed_cwds_count: number;
  last_attributed_at: string;
  // Hand-curated overlay (project_knowledge.json) — null if no entry yet
  synopsis: string | null;
  owners: string[];
  contributors: string[];
  related_topics: string[];
  curated: boolean;           // true if a hand entry exists
  // Inferred from agent snapshots — top contributors by event count
  top_contributors: Array<{ name: string; event_count: number }>;
}

async function buildMergedProjects(
  knowledge: Record<string, import('@/lib/project_knowledge').ProjectKnowledgeEntry>
): Promise<MergedProject[]> {
  const file = await readProjects();
  const bundle = await loadOrBuildSnapshots({ windowDays: 30 });

  // Step 1: index curated by name + every alias (lowercase)
  const aliasToKnown = new Map<string, string>();
  for (const [knownName, entry] of Object.entries(knowledge)) {
    aliasToKnown.set(knownName.toLowerCase(), knownName);
    for (const a of entry.aliases ?? []) aliasToKnown.set(a.toLowerCase(), knownName);
  }

  // Helper: count contributors for an alias set, scanning snapshots directly.
  const contribsFor = (aliasSet: Set<string>): Array<{ name: string; event_count: number }> => {
    const contribs: Array<{ name: string; event_count: number }> = [];
    for (const [agentName, snap] of bundle.snapshots) {
      let total = 0;
      for (const cp of snap.current_projects) {
        if (aliasSet.has(cp.name.toLowerCase())) total += cp.event_count;
      }
      if (total > 0) contribs.push({ name: agentName, event_count: total });
    }
    contribs.sort((a, b) => b.event_count - a.event_count);
    return contribs;
  };

  // Step 2: walk canonical projects. Match against curated by name OR alias.
  // Also scan observed_cwds — auto-discovery sometimes buckets multiple
  // projects under one entry (e.g. Maya cwds bucketed under agent-game-platform).
  const merged: MergedProject[] = [];
  const usedKnownNames = new Set<string>();
  // Multiple canonical entries can map to the same curated knownName
  // (Matrix-Sharon + Matrix-Riven → "Matrix"). Track which curated name
  // already got a row; subsequent matches merge cwds_count + aliases in.
  const knownNameToIdx = new Map<string, number>();
  for (const p of file.projects) {
    if (p.status !== 'active') continue;
    const nm = p.name;
    if (/^[\d_-]+$/.test(nm)) continue;
    if (nm.length < 2) continue;
    if (nm === '[redacted]') continue;

    // Try direct match
    let knownName: string | undefined = aliasToKnown.get(nm.toLowerCase());
    if (!knownName) {
      for (const a of p.aliases ?? []) {
        const hit = aliasToKnown.get(a.toLowerCase());
        if (hit) {
          knownName = hit;
          break;
        }
      }
    }
    // Final scan: observed_cwds leaf → curated alias?
    if (!knownName) {
      for (const cwd of p.observed_cwds ?? []) {
        const leaf = cwd
          .replace(/\\/g, '/')
          .split('/')
          .filter(Boolean)
          .pop();
        if (leaf) {
          const hit = aliasToKnown.get(leaf.toLowerCase());
          if (hit) {
            knownName = hit;
            break;
          }
        }
      }
    }
    const entry = knownName ? knowledge[knownName] : undefined;
    if (knownName) usedKnownNames.add(knownName);

    const aliasSet = new Set<string>([nm.toLowerCase(), ...(p.aliases ?? []).map((a) => a.toLowerCase())]);
    if (entry) {
      for (const a of entry.aliases ?? []) aliasSet.add(a.toLowerCase());
      if (knownName) aliasSet.add(knownName.toLowerCase());
    }

    // Dedupe: if this canonical maps to a curated knownName already emitted,
    // merge into that existing row instead of adding a duplicate.
    if (knownName && knownNameToIdx.has(knownName)) {
      const existing = merged[knownNameToIdx.get(knownName)!];
      existing.observed_cwds_count += (p.observed_cwds ?? []).length;
      for (const a of p.aliases ?? []) {
        if (!existing.aliases.includes(a)) existing.aliases.push(a);
      }
      if (p.last_attributed_at > existing.last_attributed_at) {
        existing.last_attributed_at = p.last_attributed_at;
      }
      // Recompute contribs against the expanded alias set
      existing.top_contributors = contribsFor(aliasSet).slice(0, 4);
      continue;
    }

    merged.push({
      id: p.id,
      name: knownName ?? p.name,
      status: p.status,
      description: p.description ?? '',
      aliases: p.aliases ?? [],
      observed_cwds_count: (p.observed_cwds ?? []).length,
      last_attributed_at: p.last_attributed_at,
      synopsis: entry?.synopsis ?? null,
      owners: entry?.owners ?? [],
      contributors: entry?.contributors ?? [],
      related_topics: entry?.related_topics ?? [],
      curated: !!entry,
      top_contributors: contribsFor(aliasSet).slice(0, 4)
    });
    if (knownName) knownNameToIdx.set(knownName, merged.length - 1);
  }

  // Step 3: synthesize virtual entries for curated knowledge that didn't
  // match any canonical project (e.g. Maya whose cwds got auto-bucketed
  // wrong). These are real projects from the team's perspective; the auto
  // registry just hasn't caught up.
  for (const [knownName, entry] of Object.entries(knowledge)) {
    if (usedKnownNames.has(knownName)) continue;
    const aliasSet = new Set<string>([knownName.toLowerCase(), ...(entry.aliases ?? []).map((a) => a.toLowerCase())]);
    const contribs = contribsFor(aliasSet);
    // Pull a "last_attributed_at" proxy from the top contributor's snapshot
    // (would need cross-reference; fall back to today)
    const lastAt = new Date().toISOString();
    merged.push({
      id: `virtual:${knownName}`,
      name: knownName,
      status: 'active',
      description: '',
      aliases: entry.aliases ?? [],
      observed_cwds_count: 0,
      last_attributed_at: lastAt,
      synopsis: entry.synopsis,
      owners: entry.owners,
      contributors: entry.contributors,
      related_topics: entry.related_topics,
      curated: true,
      top_contributors: contribs.slice(0, 4)
    });
  }

  // Sort: curated first, then by total contributor event count
  merged.sort((a, b) => {
    if (a.curated !== b.curated) return a.curated ? -1 : 1;
    const ae = a.top_contributors.reduce((s, c) => s + c.event_count, 0);
    const be = b.top_contributors.reduce((s, c) => s + c.event_count, 0);
    if (ae !== be) return be - ae;
    return b.last_attributed_at.localeCompare(a.last_attributed_at);
  });
  return merged;
}

export async function GET(): Promise<Response> {
  try {
    const data = await memoTTL('team-context', 90_000, async () => {
      const knowledge = await loadProjectKnowledge();
      const [agents, identity, events] = await Promise.all([
        loadAgentBriefs(knowledge),
        loadIdentity(),
        loadEventCounts()
      ]);
      const projects = await buildMergedProjects(knowledge);
      return {
        agents,
        projects,
        identity,
        events
      };
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
