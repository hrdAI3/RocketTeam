// POST /api/identity/map
// Body: { actor: string, name: string }
//   actor — the unmapped CC actor string, e.g. "unknown:email:xuyh@renlab.ai"
//           or "unknown:github:somelogin". The bare email/login also works.
//   name  — the roster member display name to map it to.
//
// Writes the mapping into private/identity.json (email or github map) so the
// 53k+ events tagged with that unknown actor attribute to the right person on
// the next rollup. Leader-confirmed (the /status Unmapped CC row → click).
// Validates `name` against the roster so a typo can't create a phantom person.

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { PATHS } from '@/lib/paths';
import { readRoster, writeRoster, clearRosterCache } from '@/lib/team_roster';
import { bustTTL } from '@/lib/ttl_cache';

export const dynamic = 'force-dynamic';

interface IdentityFile {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

export async function POST(req: Request): Promise<Response> {
  let body: { actor?: string; name?: string };
  try {
    body = (await req.json()) as { actor?: string; name?: string };
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const actor = (body.actor ?? '').trim();
  const name = (body.name ?? '').trim();
  if (!actor || !name) {
    return NextResponse.json({ error: 'actor and name required' }, { status: 400 });
  }

  // Validate the target name exists in the roster (any status).
  const roster = await readRoster();
  if (!roster.members.some((m) => m.name === name)) {
    return NextResponse.json(
      { error: `no roster member named "${name}"`, names: roster.members.map((m) => m.name) },
      { status: 422 }
    );
  }

  // Resolve which map + key. Accept the full `unknown:email:X` / `unknown:github:X`
  // actor string OR a bare email / login.
  let kind: 'email' | 'github';
  let key: string;
  if (actor.startsWith('unknown:email:')) {
    kind = 'email';
    key = actor.slice('unknown:email:'.length);
  } else if (actor.startsWith('unknown:github:')) {
    kind = 'github';
    key = actor.slice('unknown:github:'.length);
  } else if (actor.includes('@')) {
    kind = 'email';
    key = actor;
  } else {
    kind = 'github';
    key = actor;
  }
  key = key.trim();
  if (!key) {
    return NextResponse.json({ error: 'could not parse a key from actor' }, { status: 400 });
  }

  // (1) Write identity.json — the legacy/compat map some readers still use.
  let id: IdentityFile = {};
  try {
    id = JSON.parse(await fs.readFile(PATHS.identityMap, 'utf8')) as IdentityFile;
  } catch {
    id = {};
  }
  id[kind] = id[kind] ?? {};
  id[kind]![key] = name;
  await fs.writeFile(PATHS.identityMap, JSON.stringify(id, null, 2), 'utf8');

  // (2) Write the roster — this is what ACTUALLY resolves CC actors.
  // buildActorIndex() (the function the unmapped-CC detector + every rollup
  // uses) reads ONLY roster.cc.identifiers / github.login, NOT identity.json.
  // Writing identity.json alone left the actor unmapped — which is why the
  // 徐云昊 mapping "didn't work". For an email actor we add it as a cc
  // identifier; for github we set the login if absent.
  clearRosterCache();
  const fresh = await readRoster();
  const member = fresh.members.find((m) => m.name === name);
  if (!member) {
    return NextResponse.json({ error: 'member vanished mid-write' }, { status: 500 });
  }
  if (kind === 'email') {
    const exists = member.cc.identifiers.some((i) => i.value.toLowerCase() === key.toLowerCase());
    if (!exists) {
      member.cc.identifiers.push({ kind: 'email', value: key });
    }
  } else {
    // github login: only set if the member doesn't already have one (don't
    // clobber a real login with an actor guess).
    if (!member.github.login) member.github.login = key;
  }
  await writeRoster(fresh);

  // Bust every cache whose rollup keys off actor → name resolution.
  for (const k of ['roster-health', 'team-context', 'cc-status', 'cc-source', 'workboard', 'evaluation', 'identity-events', 'member-snapshots']) {
    bustTTL(k);
  }

  return NextResponse.json({ ok: true, mapped: { kind, key, name } });
}
