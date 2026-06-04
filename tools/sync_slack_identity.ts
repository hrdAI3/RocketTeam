#!/usr/bin/env bun
// Pull the Slack workspace member list via users.list (already implemented
// in src/lib/slack.ts:listUsers), match real_name / display_name to our
// canonical 12 team names, and write proposed mappings into identity.json
// under the `slack` channel.
//
// Read-only by default. Pass --apply to persist.

import { promises as fs } from 'node:fs';
import { getToken, listUsers, type SlackUser } from '../src/lib/slack';
import { PATHS } from '../src/lib/paths';

interface IdentityMap {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

async function loadIdentity(): Promise<IdentityMap> {
  try {
    return JSON.parse(await fs.readFile(PATHS.identityMap, 'utf8')) as IdentityMap;
  } catch {
    return {};
  }
}

async function listAgentNames(): Promise<string[]> {
  const entries = await fs.readdir(PATHS.agents);
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

async function loadAliases(names: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const name of names) {
    try {
      const raw = await fs.readFile(`${PATHS.agents}/${name}.json`, 'utf8');
      const p = JSON.parse(raw) as { transcript_misspellings?: string[]; bio?: string };
      const aliases = new Set<string>();
      aliases.add(name);
      if (name.length >= 2) aliases.add(name.slice(-2));
      for (const m of p.transcript_misspellings ?? []) if (m && m.length >= 2) aliases.add(m);
      out[name] = Array.from(aliases);
    } catch {
      out[name] = [name];
    }
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[._-]/g, '');
}

function matchUserToAgent(
  user: SlackUser,
  aliasMap: Record<string, string[]>
): { name: string; reason: string } | null {
  const candidates: string[] = [];
  if (user.real_name) candidates.push(user.real_name);
  if (user.profile?.display_name) candidates.push(user.profile.display_name);
  if (user.profile?.real_name) candidates.push(user.profile.real_name);
  if (user.name) candidates.push(user.name);

  for (const cand of candidates) {
    if (!cand) continue;
    const normCand = normalize(cand);
    for (const [agentName, aliases] of Object.entries(aliasMap)) {
      for (const a of aliases) {
        if (!a) continue;
        const normAlias = normalize(a);
        if (normAlias.length < 2) continue;
        // Either side fully contained in the other
        if (normCand === normAlias) {
          return { name: agentName, reason: `exact "${cand}"≈"${a}"` };
        }
        if (normCand.includes(normAlias) || normAlias.includes(normCand)) {
          return { name: agentName, reason: `substring "${cand}"~"${a}"` };
        }
      }
    }
  }
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const token = await getToken();
  if (!token) {
    console.error('no slack token (slack.config.json missing or vault key wrong)');
    process.exit(1);
  }
  console.error('[slack] fetching workspace users...');
  const users = await listUsers(token);
  console.error(`[slack] ${users.length} users in workspace`);

  const agentNames = await listAgentNames();
  const aliasMap = await loadAliases(agentNames);
  console.error(`[slack] matching against ${agentNames.length} team agents`);

  const identity = await loadIdentity();
  const existing = identity.slack ?? {};

  const matches: Array<{ slack_id: string; slack_name: string; agent: string; reason: string }> = [];
  const unmatched: Array<{ slack_id: string; slack_name: string; real_name: string }> = [];
  for (const u of users) {
    if (existing[u.id]) continue; // already mapped
    const hit = matchUserToAgent(u, aliasMap);
    if (hit) {
      matches.push({
        slack_id: u.id,
        slack_name: u.name,
        agent: hit.name,
        reason: hit.reason
      });
    } else {
      unmatched.push({
        slack_id: u.id,
        slack_name: u.name,
        real_name: u.real_name ?? u.profile?.display_name ?? u.profile?.real_name ?? '(none)'
      });
    }
  }

  console.log('\n=== proposed new mappings ===');
  for (const m of matches) {
    console.log(`  ${m.slack_id.padEnd(15)} ${m.slack_name.padEnd(20)} → ${m.agent}  [${m.reason}]`);
  }
  console.log(`\n=== unmatched (${unmatched.length}) ===`);
  for (const u of unmatched.slice(0, 30)) {
    console.log(`  ${u.slack_id.padEnd(15)} ${u.slack_name.padEnd(20)} real="${u.real_name}"`);
  }
  if (unmatched.length > 30) console.log(`  ...and ${unmatched.length - 30} more`);

  console.log('\n=== summary ===');
  console.log(`workspace users:     ${users.length}`);
  console.log(`already mapped:      ${Object.keys(existing).length}`);
  console.log(`would add:           ${matches.length}`);
  console.log(`unmatched:           ${unmatched.length}`);

  if (!apply) {
    console.log('\n(dry-run — pass --apply to write to identity.json)');
    return;
  }
  if (matches.length === 0) {
    console.log('\nno new mappings to apply');
    return;
  }
  identity.slack = { ...existing };
  for (const m of matches) identity.slack[m.slack_id] = m.agent;
  await fs.writeFile(PATHS.identityMap, JSON.stringify(identity, null, 2) + '\n', 'utf8');
  console.log(`\n[apply] wrote ${matches.length} new slack mappings to identity.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
