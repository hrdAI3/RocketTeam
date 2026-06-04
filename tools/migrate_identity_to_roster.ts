// One-shot migration: read identity.json (the legacy 3-map shape) and emit
// `private/team_roster.json` v2 with one entry per unique person. Run once
// after rollout; subsequent edits go through the roster directly.
//
// Run: `bun run tools/migrate_identity_to_roster.ts`
//
// Strategy:
//   - Collect every {name} mentioned across email/github/slack maps.
//   - For each name, gather CC identifiers (split into email vs machine by
//     suffix heuristic), slack user_id, github login. Set ok=false initially
//     so the next refreshRoster pass populates real health.
//   - Leader name pulled from env (LEADER_NAME) or default 戴昊然.

import { promises as fs } from 'fs';
import path from 'path';
import { writeRoster, type Member, type Roster, type CcIdentifier } from '../src/lib/team_roster';

const PRIVATE_DIR = path.join(process.cwd(), 'private');
const IDENTITY_PATH = path.join(PRIVATE_DIR, 'identity.json');

interface LegacyIdentity {
  email?: Record<string, string>;
  github?: Record<string, string>;
  slack?: Record<string, string>;
}

function isMachineLocal(s: string): boolean {
  return /\.local$/i.test(s) || /MacBook|iMac|Mac-mini/i.test(s);
}

async function main(): Promise<void> {
  const raw = await fs.readFile(IDENTITY_PATH, 'utf8');
  const id = JSON.parse(raw) as LegacyIdentity;
  const emailMap = id.email ?? {};
  const githubMap = id.github ?? {};
  const slackMap = id.slack ?? {};

  // Collect all names
  const names = new Set<string>();
  for (const n of Object.values(emailMap)) names.add(n);
  for (const n of Object.values(githubMap)) names.add(n);
  for (const n of Object.values(slackMap)) names.add(n);

  const members: Member[] = [];
  for (const name of [...names].sort()) {
    const identifiers: CcIdentifier[] = [];
    for (const [v, n] of Object.entries(emailMap)) {
      if (n !== name) continue;
      identifiers.push({
        kind: isMachineLocal(v) ? 'machine' : 'email',
        value: v
      });
    }
    const githubLogin =
      Object.entries(githubMap).find(([, n]) => n === name)?.[0] ?? null;
    const slackUserId =
      Object.entries(slackMap).find(([, n]) => n === name)?.[0] ?? null;

    members.push({
      name,
      status: 'active',
      joined_at: null,
      left_at: null,
      slack: {
        user_id: slackUserId,
        display_name: null,
        ok: false,
        checked_at: null
      },
      cc: {
        identifiers,
        last_seen_at: null,
        ok: false
      },
      github: {
        login: githubLogin,
        public_email: null,
        public_email_suffix_ok: false,
        ok: false,
        issues: githubLogin ? ['public-email-not-set'] : ['github-login-not-set'],
        checked_at: null
      }
    });
  }

  const roster: Roster = {
    version: 2,
    leader: process.env.LEADER_NAME ?? '戴昊然',
    members
  };
  await writeRoster(roster);
  console.log(`wrote ${members.length} members to private/team_roster.json`);
  for (const m of members) {
    console.log(
      `  ${m.name.padEnd(6)} slack=${m.slack.user_id ?? '∅'} gh=${m.github.login ?? '∅'} cc=${m.cc.identifiers.length}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
