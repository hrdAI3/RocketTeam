#!/usr/bin/env bun
// PMA v2 · Behavior Index CLI.
//
// Reads private/events.jsonl + private/agents/*.json, builds an
// AgentBehaviorSnapshot per known agent over a rolling window, writes:
//   private/index/behavior_YYYY-MM-DD.json
//
// Usage:
//   bun tools/build_behavior_index.ts                 # 30d window, asOf=now
//   bun tools/build_behavior_index.ts --window 90
//   bun tools/build_behavior_index.ts --as-of 2026-05-18
//   bun tools/build_behavior_index.ts --summary       # only print top-line stats

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEventsWindow } from '../src/lib/events';
import { buildSnapshots } from '../src/index/behavior';
import type { AgentBehaviorSnapshot } from '../src/index/behavior';
import { PATHS } from '../src/lib/paths';
import type { Event } from '../src/types/events';

interface CliArgs {
  windowDays: 30 | 90;
  asOf: Date;
  summary: boolean;
  outDir: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let windowDays: 30 | 90 = 30;
  let asOf = new Date();
  let summary = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window') {
      const v = parseInt(argv[++i] ?? '30', 10);
      if (v !== 30 && v !== 90) {
        console.error(`--window must be 30 or 90; got ${v}`);
        process.exit(2);
      }
      windowDays = v;
    } else if (a === '--as-of') {
      asOf = new Date(argv[++i]);
      if (Number.isNaN(asOf.getTime())) {
        console.error('--as-of must be ISO date');
        process.exit(2);
      }
    } else if (a === '--summary') {
      summary = true;
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return {
    windowDays,
    asOf,
    summary,
    outDir: resolve(join(PATHS.root, 'index'))
  };
}

async function listAgentNames(): Promise<string[]> {
  const entries = await fs.readdir(PATHS.agents);
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

// Pull per-agent name aliases from profile.transcript_misspellings + bio
// first-name guess. Used by behavior.ts to attribute meeting/slack mentions
// that don't use the canonical full name.
async function loadAliases(agentNames: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const name of agentNames) {
    try {
      const raw = await fs.readFile(join(PATHS.agents, `${name}.json`), 'utf8');
      const p = JSON.parse(raw) as { transcript_misspellings?: string[] };
      const aliases = new Set<string>();
      // Always include the last 2 chars as a first-name alias (Chinese names)
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

// Historical events tagged actor=`unknown:email:xxx` predate identity map
// updates. Apply the *current* identity map at snapshot time so newly mapped
// emails get their events back. Non-destructive: events.jsonl unchanged.
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
  let remapped = 0;
  const out: Event[] = events.map((e) => {
    if (!e.actor || !e.actor.startsWith('unknown:email:')) return e;
    const email = e.actor.slice('unknown:email:'.length);
    const name = emailMap[email];
    if (!name) return e;
    remapped += 1;
    return { ...e, actor: name };
  });
  if (remapped > 0) {
    console.error(`[behavior] remapped ${remapped} unknown-email events to canonical names`);
  }
  return out;
}

function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function summarize(snap: AgentBehaviorSnapshot): string {
  const top3Tools = Object.entries(snap.tool_usage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${t}×${n}`)
    .join(' ');
  const top3Stuck = snap.stuck_topics.slice(0, 3).map((t) => `${t.topic}×${t.count}`).join(' ');
  const m = snap.meeting_signals;
  const meetingHint =
    m.action_items_owned + m.decisions_authored + m.name_mention_received > 0
      ? ` mtg=[ai=${m.action_items_owned} dec=${m.decisions_authored} mention=${m.name_mention_received} attend=${m.attendance_rate.toFixed(1)}]`
      : '';
  return [
    snap.agent_name.padEnd(8, ' '),
    `[${snap.energy_inferred}]`.padEnd(8, ' '),
    `evts=${String(snap.n_events_used).padStart(5, ' ')}`,
    `sess=${String(snap.n_sessions).padStart(3, ' ')}`,
    `days=${String(snap.active_days_in_window).padStart(2, ' ')}`,
    `tok_p50=${String(Math.round(snap.cc_tokens_per_hour_p50)).padStart(7, ' ')}/h`,
    `tools=[${top3Tools}]`,
    `stuck=[${top3Stuck}]`,
    meetingHint
  ].join(' ');
}

async function main() {
  const args = parseArgs();
  const startMs = Date.now();

  console.error(`[behavior] streaming events from ${PATHS.events}`);
  // Stream only the window we need (+1d slack for as-of math). events.jsonl
  // is ≈ Node's max-string limit; a full readAllEvents() would OOM.
  const sinceIso = new Date(args.asOf.getTime() - (args.windowDays + 1) * 86400000).toISOString();
  const rawEvents = await readEventsWindow({ since: sinceIso });
  console.error(`[behavior] ${rawEvents.length} events (${args.windowDays}d window) in ${Date.now() - startMs}ms`);

  const emailMap = await loadEmailAliases();
  const events = remapEvents(rawEvents, emailMap);

  const agentNames = await listAgentNames();
  console.error(`[behavior] ${agentNames.length} agents: ${agentNames.join(', ')}`);

  const aliases = await loadAliases(agentNames);
  const aliasCount = Object.values(aliases).reduce((a, x) => a + x.length, 0);
  console.error(`[behavior] loaded ${aliasCount} aliases for meeting/slack attribution`);

  const t0 = Date.now();
  const snapshots = buildSnapshots({
    events,
    agentNames,
    asOf: args.asOf,
    windowDays: args.windowDays,
    aliases
  });
  console.error(`[behavior] snapshots built in ${Date.now() - t0}ms`);

  // Print summary table
  console.log(
    `\n# Behavior Snapshot — window ${args.windowDays}d, as_of ${args.asOf.toISOString()}\n`
  );
  for (const name of agentNames) {
    const s = snapshots.get(name)!;
    console.log(summarize(s));
  }

  if (args.summary) return;

  // Write to disk
  await fs.mkdir(args.outDir, { recursive: true });
  const outPath = join(args.outDir, `behavior_${dayStamp(args.asOf)}.json`);
  const payload = {
    as_of: args.asOf.toISOString(),
    window_days: args.windowDays,
    built_at: new Date().toISOString(),
    n_agents: agentNames.length,
    n_events: events.length,
    snapshots: Object.fromEntries(snapshots)
  };
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.error(`\n[behavior] written → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
