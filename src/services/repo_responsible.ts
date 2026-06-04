// Auto-resolve a GitHub repo's "responsible" (负责人) using:
//   1. repo collaborators (excluding the leader's audit account anzy-renlab-ai)
//   2. fallback: recent commits author email
// against `identity.json`'s email / github maps.
//
// Used at registry-seed time so every GH-tracked project entity has a
// canonical owner name in its `description`, without the leader manually
// typing it for 20 repos.

import {
  fetchRecentCommits,
  fetchUserEmail,
  getToken,
  listCollaborators
} from '../lib/github';
import { lookupEmail, lookupGithub } from '../lib/identity';

const LEADER_AUDIT_LOGIN = 'anzy-renlab-ai';

export interface ResolvedResponsible {
  name: string | null;
  via: 'collaborator-github' | 'collaborator-email' | 'commit-email' | null;
  raw?: string; // login or email that produced the match (for audit)
}

const cache = new Map<string, ResolvedResponsible>();

export async function resolveRepoResponsible(
  owner: string,
  name: string
): Promise<ResolvedResponsible> {
  const key = `${owner}/${name}`.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const empty: ResolvedResponsible = { name: null, via: null };
  const token = await getToken();
  if (!token) return cacheAndReturn(key, empty);

  // 1. Collaborators. If the repo owner itself isn't anzy-renlab-ai (i.e., a
  //    team member's personal account), the owner is the most likely
  //    responsible. Otherwise scan other collaborators.
  const collaborators = await listCollaborators(token, owner, name);
  const ownerLogin = owner.toLowerCase();
  if (ownerLogin !== LEADER_AUDIT_LOGIN.toLowerCase()) {
    // Owner-as-responsible: try github login map first, then look up email.
    const byLogin = await lookupGithub(owner);
    if (byLogin) {
      return cacheAndReturn(key, { name: byLogin, via: 'collaborator-github', raw: owner });
    }
    // Some GH accounts expose `email` in /users/<login>.
    const email = await fetchUserEmail(token, owner);
    if (email) {
      const byEmail = await lookupEmail(email);
      if (byEmail) {
        return cacheAndReturn(key, {
          name: byEmail,
          via: 'collaborator-email',
          raw: email
        });
      }
    }
  }

  // 2. Walk collaborators (excluding anzy-renlab-ai). First match wins.
  for (const c of collaborators) {
    if (c.login.toLowerCase() === LEADER_AUDIT_LOGIN.toLowerCase()) continue;
    if (c.type !== 'User') continue;
    const byLogin = await lookupGithub(c.login);
    if (byLogin) {
      return cacheAndReturn(key, {
        name: byLogin,
        via: 'collaborator-github',
        raw: c.login
      });
    }
    if (c.email) {
      const byEmail = await lookupEmail(c.email);
      if (byEmail) {
        return cacheAndReturn(key, {
          name: byEmail,
          via: 'collaborator-email',
          raw: c.email
        });
      }
    }
    // Public email lookup (best-effort; most users don't set this).
    const email = await fetchUserEmail(token, c.login);
    if (email) {
      const byEmail = await lookupEmail(email);
      if (byEmail) {
        return cacheAndReturn(key, {
          name: byEmail,
          via: 'collaborator-email',
          raw: email
        });
      }
    }
  }

  // 3. Recent commit authors — most reliable for matching because commit
  //    metadata carries author.email even when the user's public profile
  //    doesn't.
  const commits = await fetchRecentCommits(token, owner, name, 30);
  for (const c of commits) {
    const a = c.commit?.author;
    if (!a?.email) continue;
    // Skip noreply / anzy emails.
    if (/@users\.noreply\.github\.com$/i.test(a.email)) {
      // Try the embedded login form: `12345+username@users.noreply.github.com`
      const m = a.email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
      if (m) {
        const byLogin = await lookupGithub(m[1]);
        if (byLogin) {
          return cacheAndReturn(key, {
            name: byLogin,
            via: 'commit-email',
            raw: a.email
          });
        }
      }
      continue;
    }
    if (/anzy.*renlab/i.test(a.email)) continue;
    const byEmail = await lookupEmail(a.email);
    if (byEmail) {
      return cacheAndReturn(key, {
        name: byEmail,
        via: 'commit-email',
        raw: a.email
      });
    }
  }

  return cacheAndReturn(key, empty);
}

function cacheAndReturn(key: string, v: ResolvedResponsible): ResolvedResponsible {
  cache.set(key, v);
  return v;
}

export function clearRepoResponsibleCache(): void {
  cache.clear();
}
