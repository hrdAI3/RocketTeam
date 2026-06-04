// Hand-curated project knowledge loader.
//
// `private/project_knowledge.json` maps a project name (and its aliases) to a
// human-written synopsis + canonical owners. The auto-discovery in
// `projects.json` records that a project exists; this file tells the LLM
// *what the project is* and *who owns it*. Without this layer, the LLM treats
// "Maya" as just a directory name and can't reason that "AI 运营 Agent demo"
// task IS Maya work.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './paths';

export interface ProjectKnowledgeEntry {
  aliases: string[];
  synopsis: string;
  owners: string[];
  contributors: string[];
  related_topics: string[];
  notes?: string;
}

interface KnowledgeFile {
  projects?: Record<string, ProjectKnowledgeEntry>;
}

const PATH = join(PATHS.root, 'project_knowledge.json');

let cache: { mtimeMs: number; data: Record<string, ProjectKnowledgeEntry> } | null = null;

export async function loadProjectKnowledge(): Promise<Record<string, ProjectKnowledgeEntry>> {
  try {
    const stat = await fs.stat(PATH);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
    const raw = await fs.readFile(PATH, 'utf8');
    const j = JSON.parse(raw) as KnowledgeFile;
    cache = { mtimeMs: stat.mtimeMs, data: j.projects ?? {} };
    return cache.data;
  } catch {
    return {};
  }
}

// Match a project name (typically a cwd leaf) to the canonical knowledge
// entry. Lookups are case-insensitive and check aliases.
export function lookupProject(
  knowledge: Record<string, ProjectKnowledgeEntry>,
  name: string
): { canonicalName: string; entry: ProjectKnowledgeEntry } | null {
  const low = name.toLowerCase();
  for (const [canonical, entry] of Object.entries(knowledge)) {
    if (canonical.toLowerCase() === low) return { canonicalName: canonical, entry };
    if (entry.aliases?.some((a) => a.toLowerCase() === low)) {
      return { canonicalName: canonical, entry };
    }
  }
  return null;
}

// Given an agent's current_projects list, return enriched info — synopsis
// + ownership claim if knowledge file has it.
export interface EnrichedProject {
  raw_name: string;
  event_count: number;
  active_days: number;
  canonical_name?: string;
  synopsis?: string;
  is_owner?: boolean; // is the agent the canonical owner?
  related_topics?: string[];
}

export function enrichAgentProjects(
  agentName: string,
  rawProjects: Array<{ name: string; event_count: number; active_days: number }>,
  knowledge: Record<string, ProjectKnowledgeEntry>
): EnrichedProject[] {
  const seen = new Set<string>();
  const out: EnrichedProject[] = [];
  for (const p of rawProjects) {
    const hit = lookupProject(knowledge, p.name);
    if (hit) {
      // Dedupe by canonical name — Maya / maya内容生产 / maya热点预测 collapse.
      if (seen.has(hit.canonicalName)) {
        // Add events to the existing bucket.
        const ex = out.find((x) => x.canonical_name === hit.canonicalName);
        if (ex) {
          ex.event_count += p.event_count;
          ex.active_days = Math.max(ex.active_days, p.active_days);
        }
        continue;
      }
      seen.add(hit.canonicalName);
      out.push({
        raw_name: p.name,
        event_count: p.event_count,
        active_days: p.active_days,
        canonical_name: hit.canonicalName,
        synopsis: hit.entry.synopsis,
        is_owner: hit.entry.owners.includes(agentName),
        related_topics: hit.entry.related_topics
      });
    } else {
      out.push({
        raw_name: p.name,
        event_count: p.event_count,
        active_days: p.active_days
      });
    }
  }
  return out;
}
