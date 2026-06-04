#!/usr/bin/env bun
// Sync team roster from the Matrix-Riven CC collector (default :8933).
//
// Treats collector /api/users as the source of truth. Reports:
//   - emails on collector but NOT in identity.json → must claim or exclude
//   - identity.json entries with NO matching collector email → stale, suggest drop
//   - agent profiles whose name is not in current identity map → orphan
//
// Read-only by default. Pass --apply to actually:
//   - drop stale identity.json entries
//   - mark orphan profiles for removal (does not delete; prints rm cmds)

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../src/lib/paths';

const COLLECTOR = process.env.CC_COLLECTOR_BASE ?? 'http://192.168.22.88:8933';

interface IdentityMap {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

interface DateResp {
  dates?: string[];
}

async function fetchCollectorUsers(): Promise<string[]> {
  const r = await fetch(`${COLLECTOR}/api/users`);
  if (!r.ok) throw new Error(`collector ${r.status}`);
  const j = (await r.json()) as { users?: string[] };
  return j.users ?? [];
}

async function fetchUserDates(email: string): Promise<string[]> {
  const r = await fetch(`${COLLECTOR}/api/dates?user=${encodeURIComponent(email)}`);
  if (!r.ok) return [];
  const j = (await r.json()) as DateResp;
  return j.dates ?? [];
}

async function loadIdentity(): Promise<IdentityMap> {
  try {
    return JSON.parse(await fs.readFile(PATHS.identityMap, 'utf8')) as IdentityMap;
  } catch {
    return {};
  }
}

async function listAgentProfiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PATHS.agents);
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');

  const [users, identity, profiles] = await Promise.all([
    fetchCollectorUsers(),
    loadIdentity(),
    listAgentProfiles()
  ]);

  const emailMap = identity.email ?? {};
  const knownEmails = new Set(Object.keys(emailMap));
  const mappedNames = new Set(Object.values(emailMap));
  const profileSet = new Set(profiles);

  // 1. Collector users with date info
  const userRows: Array<{ email: string; name: string | 'UNCLAIMED'; days: string[] }> = [];
  for (const u of users) {
    const dates = await fetchUserDates(u);
    userRows.push({ email: u, name: emailMap[u] ?? 'UNCLAIMED', days: dates });
  }

  console.log('\n=== 8933 collector roster ===');
  console.log('email'.padEnd(48) + 'claim'.padEnd(12) + 'recent_dates');
  for (const r of userRows) {
    console.log(r.email.padEnd(48) + r.name.padEnd(12) + r.days.slice(0, 6).join(','));
  }

  // 2. Identity entries not on collector
  const onCollector = new Set(users);
  const stale = Object.entries(emailMap).filter(([email]) => !onCollector.has(email));
  console.log('\n=== identity.json entries NOT on collector (stale) ===');
  if (stale.length === 0) console.log('(none)');
  for (const [email, name] of stale) console.log(`  ${email} → ${name}`);

  // 3. Profiles with no identity mapping
  const orphans = profiles.filter((p) => !mappedNames.has(p));
  console.log('\n=== profiles in agents/ NOT mapped to any collector email ===');
  if (orphans.length === 0) console.log('(none)');
  for (const o of orphans) console.log(`  ${o}.json`);

  // 4. Mapped emails missing a profile file
  const missingProfiles = Object.values(emailMap).filter((n) => !profileSet.has(n));
  console.log('\n=== mapped names with NO profile file ===');
  if (missingProfiles.length === 0) console.log('(none)');
  for (const n of missingProfiles) console.log(`  ${n}`);

  // 5. Summary
  const unclaimed = userRows.filter((r) => r.name === 'UNCLAIMED');
  console.log('\n=== summary ===');
  console.log(`collector users:           ${users.length}`);
  console.log(`identity.json entries:     ${Object.keys(emailMap).length}`);
  console.log(`agent profiles on disk:    ${profiles.length}`);
  console.log(`UNCLAIMED collector users: ${unclaimed.length}`);
  console.log(`stale identity entries:    ${stale.length}`);
  console.log(`orphan profiles:           ${orphans.length}`);
  console.log(`missing profiles:          ${missingProfiles.length}`);

  if (!apply) {
    console.log('\n(read-only run — pass --apply to drop stale identity entries and print profile-remove commands)');
    return;
  }

  // === Apply ===
  let changed = false;
  if (stale.length > 0) {
    for (const [email] of stale) delete emailMap[email];
    identity.email = emailMap;
    await fs.writeFile(PATHS.identityMap, JSON.stringify(identity, null, 2) + '\n', 'utf8');
    console.log(`\n[apply] removed ${stale.length} stale identity entries`);
    changed = true;
  }
  if (orphans.length > 0) {
    console.log(`\n[apply] suggested commands to remove orphan profiles (NOT run automatically):`);
    for (const o of orphans) console.log(`  rm "${join(PATHS.agents, o + '.json')}"`);
  }
  if (!changed && orphans.length === 0) console.log('\n[apply] no changes needed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
