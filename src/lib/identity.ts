// Identity resolution: external account → canonical agent name.
// Reads a JSON map from PATHS.identityMap. Unknown identifiers return null,
// callers should still emit events but mark subject.ref as the raw id and
// surface them in a maintenance pane later.
//
// File shape (private/identity.json):
//   {
//     "email":  { "alice@example.com": "李博泽", ... },
//     "github": { "zhouzy90":         "周子焱", ... },
//     "slack":  { "U01ABC":           "安子岩", ... }
//   }
// Plus an optional reverse cache regenerated on each load.

import { promises as fs } from 'node:fs';
import { PATHS } from './paths';

type Channel = 'email' | 'github' | 'slack';

interface IdentityMap {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

let cache: { mtimeMs: number; data: IdentityMap } | null = null;

async function load(): Promise<IdentityMap> {
  try {
    const stat = await fs.stat(PATHS.identityMap);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
    const raw = await fs.readFile(PATHS.identityMap, 'utf8');
    const data = JSON.parse(raw) as IdentityMap;
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { mtimeMs: 0, data: {} };
      return {};
    }
    throw err;
  }
}

export async function resolveIdentity(
  channel: Channel,
  externalId: string
): Promise<string | null> {
  const map = await load();
  const table = map[channel];
  if (!table) return null;
  return table[externalId] ?? null;
}

export async function lookupEmail(email: string): Promise<string | null> {
  return resolveIdentity('email', email.toLowerCase().trim());
}

export async function lookupGithub(login: string): Promise<string | null> {
  return resolveIdentity('github', login);
}

export async function lookupSlack(userId: string): Promise<string | null> {
  return resolveIdentity('slack', userId);
}

export async function reverseLookup(
  name: string
): Promise<{ email?: string; github?: string; slack?: string }> {
  const map = await load();
  const out: { email?: string; github?: string; slack?: string } = {};
  for (const [k, v] of Object.entries(map.email ?? {})) if (v === name) out.email = k;
  for (const [k, v] of Object.entries(map.github ?? {})) if (v === name) out.github = k;
  for (const [k, v] of Object.entries(map.slack ?? {})) if (v === name) out.slack = k;
  return out;
}

export async function listKnownEmails(): Promise<Array<{ email: string; name: string }>> {
  const map = await load();
  return Object.entries(map.email ?? {}).map(([email, name]) => ({ email, name }));
}

// Resolve OR return a sentinel ref so events still land. Subject.ref is set to
// the original external id under an `unknown:` prefix so callers can detect it.
export async function resolveOrUnknown(
  channel: Channel,
  externalId: string
): Promise<{ name: string; unresolved: boolean }> {
  const hit = await resolveIdentity(channel, externalId);
  if (hit) return { name: hit, unresolved: false };
  return { name: `unknown:${channel}:${externalId}`, unresolved: true };
}
