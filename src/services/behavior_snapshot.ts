// Behavior snapshot builder — the single place that builds + persists the
// per-agent behavior index (`private/index/behavior_YYYY-MM-DD.json`).
//
// Why this exists as a service: the snapshot file backs /api/team/context.
// When the file is stale (>7d) the route's loadOrBuildSnapshots() falls back
// to an on-demand build that took ~22s cold (it streams the full window every
// request until the 90s memoTTL warms). Keeping a FRESH dated file means the
// route just reads it (~1.5s cold). The monitor loop calls
// buildAndWriteBehaviorSnapshot() once per Beijing day so the file never goes
// stale; the CLI (tools/build_behavior_index.ts) uses the same function.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readEventsWindow } from '../lib/events';
import { buildSnapshots } from '../index/behavior';
import { PATHS } from '../lib/paths';
import type { Event } from '../types/events';

async function listAgentNames(): Promise<string[]> {
  const entries = await fs.readdir(PATHS.agents);
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

async function loadAliases(agentNames: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const name of agentNames) {
    try {
      const raw = await fs.readFile(join(PATHS.agents, `${name}.json`), 'utf8');
      const p = JSON.parse(raw) as { transcript_misspellings?: string[] };
      const aliases = new Set<string>();
      if (name.length >= 2) aliases.add(name.slice(-2));
      if (name.length >= 3) aliases.add(name.slice(1));
      for (const m of p.transcript_misspellings ?? []) {
        if (m && m.length >= 2) aliases.add(m);
      }
      out[name] = Array.from(aliases);
    } catch {
      out[name] = [];
    }
  }
  return out;
}

async function loadEmailAliases(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(PATHS.identityMap, 'utf8');
    const j = JSON.parse(raw) as { email?: Record<string, string> };
    return j.email ?? {};
  } catch {
    return {};
  }
}

function remapEvents(events: Event[], emailMap: Record<string, string>): Event[] {
  return events.map((e) => {
    if (!e.actor || !e.actor.startsWith('unknown:email:')) return e;
    const email = e.actor.slice('unknown:email:'.length);
    const name = emailMap[email];
    return name ? { ...e, actor: name } : e;
  });
}

function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface BuildResult {
  outPath: string;
  nAgents: number;
  nEvents: number;
  windowDays: 30 | 90;
  builtMs: number;
}

export async function buildAndWriteBehaviorSnapshot(opts?: {
  windowDays?: 30 | 90;
  asOf?: Date;
}): Promise<BuildResult> {
  const windowDays = opts?.windowDays ?? 30;
  const asOf = opts?.asOf ?? new Date();
  const t0 = Date.now();

  // Stream only the needed window (+1d slack). events.jsonl ≈ Node's
  // max-string limit; a full load would OOM.
  const sinceIso = new Date(asOf.getTime() - (windowDays + 1) * 86400000).toISOString();
  const rawEvents = await readEventsWindow({ since: sinceIso });

  const emailMap = await loadEmailAliases();
  const events = remapEvents(rawEvents, emailMap);
  const agentNames = await listAgentNames();
  const aliases = await loadAliases(agentNames);

  const snapshots = buildSnapshots({ events, agentNames, asOf, windowDays, aliases });

  const outDir = join(PATHS.root, 'index');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `behavior_${dayStamp(asOf)}.json`);
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        as_of: asOf.toISOString(),
        window_days: windowDays,
        built_at: new Date().toISOString(),
        n_agents: agentNames.length,
        n_events: events.length,
        snapshots: Object.fromEntries(snapshots)
      },
      null,
      2
    ),
    'utf8'
  );

  return {
    outPath,
    nAgents: agentNames.length,
    nEvents: events.length,
    windowDays,
    builtMs: Date.now() - t0
  };
}
