// Repo ownership audit.
// Surface every tracked GitHub repo whose owner account is NOT inside the
// renlab-ai umbrella (suffix `-renlab-ai`, or the explicit allowlist orgs
// `hrdAI3` / `renlab-ai`). These repos live on a team member's personal
// GitHub account and should be transferred to `anzy-renlab-ai` so the team's
// audit account retains access if the employee leaves or rotates handles.
//
// Output feeds two consumers:
//   1. /status workboard UI — surfaces transfer + handoff rows
//   2. monitor_loop Slack push — DMs the active responsible person; LEFT
//      members are never DM'd (they can't act on a transfer ask).

import { readConfig } from '../lib/github';
import { lookupGithub } from '../lib/identity';
import { lookupByGithub } from '../lib/team_roster';

const RENLAB_SUFFIX = /-renlab-ai$/i;
const ALLOWED_OWNERS = new Set(['hrdai3', 'renlab-ai', 'renlab']);

export interface ExternallyOwnedRepo {
  owner: string;
  name: string;
  fullName: string;        // "owner/name", canonical id
  responsible: string | null; // resolved name, e.g. "李博泽"; null if unknown
  // True when `responsible` has already left the team. Such a repo can't be
  // nagged to its owner — it's a LEADER handoff item: the repo sits on a
  // departed person's personal renlab account and must be transferred /
  // reassigned by the leader.
  responsibleLeft: boolean;
}

// Permissive check. Owner is "internal" if its login is in the allowlist OR
// matches the -renlab-ai suffix convention. Anything else is flagged.
export function isInternalOwner(login: string): boolean {
  const lc = login.toLowerCase();
  if (ALLOWED_OWNERS.has(lc)) return true;
  if (RENLAB_SUFFIX.test(lc)) return true;
  return false;
}

// Set of lowercased owner logins that hold ≥1 tracked repo. Used by the
// compliance engine to decide who actually needs a corporate public email.
export async function trackedRepoOwners(): Promise<Set<string>> {
  const cfg = await readConfig();
  const out = new Set<string>();
  for (const r of cfg?.selected_repos ?? []) out.add(r.owner.toLowerCase());
  return out;
}

export async function findExternallyOwnedRepos(): Promise<ExternallyOwnedRepo[]> {
  const cfg = await readConfig();
  const repos = cfg?.selected_repos ?? [];
  const out: ExternallyOwnedRepo[] = [];
  for (const r of repos) {
    const member = await lookupByGithub(r.owner).catch(() => null);

    // Departed-owner handoff — runs BEFORE the internal-owner skip and the
    // company-email skip. A repo on a LEFT member's account is a leader
    // handoff even when the login carries the `-renlab-ai` suffix:
    // `libz-renlab-ai` / `HisenseYin-renlab-ai` / `liusy-renlab-ai` are that
    // person's PERSONAL renlab account, not the shared org `anzy-renlab-ai`.
    // When they leave, that account (and the team's access) can leave with
    // them — so the repo must move to anzy-renlab-ai or be reassigned. The
    // only exception is true org accounts in ALLOWED_OWNERS, which no single
    // person controls.
    if (member?.status === 'left' && !ALLOWED_OWNERS.has(r.owner.toLowerCase())) {
      out.push({
        owner: r.owner,
        name: r.name,
        fullName: `${r.owner}/${r.name}`,
        responsible: member.name,
        responsibleLeft: true
      });
      continue;
    }

    if (isInternalOwner(r.owner)) continue;
    // Only PERSONAL accounts (no company email) need transfer. An owner who
    // set a company public email (e.g. 冯肖文 zmypyzd → fengxw@renlab.ai;
    // 刘师宇 LiuShiyuMath → liusy@nb-ai.com) is already compliant under
    // Policy A — transferring is the alternative path, not an extra demand —
    // so skip them. NOTE: this skip is overridden by the LEFT check above;
    // a departed company-email owner still surfaces as handoff because the
    // GitHub account itself is no longer under the team's control once the
    // person leaves the renlab email.
    if (member?.github.public_email_suffix_ok) continue;
    const responsible = member?.name ?? (await lookupGithub(r.owner).catch(() => null));
    out.push({
      owner: r.owner,
      name: r.name,
      fullName: `${r.owner}/${r.name}`,
      responsible: responsible ?? null,
      responsibleLeft: false
    });
  }
  return out;
}
