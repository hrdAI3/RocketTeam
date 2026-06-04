// GitHub extractor.
// Pulls PR + commit activity for selected repos and emits normalized events.
// Starts with two repos by default: RocketTeam, TeamBrain (per user direction).
//
// Reuses src/lib/github.ts for token retrieval and HTTP plumbing.

import { appendEvents, readSyncState, writeSyncState } from '../lib/events';
import { resolveOrUnknown, lookupEmail } from '../lib/identity';
import {
  getToken,
  readConfig,
  writeConfig,
  ghCall,
  reconcileTrackedRepoOwners,
  fetchRecentCommits
} from '../lib/github';
import type { NewEvent } from '../lib/events';
import type { GithubCommit } from '../lib/github';

const SYNC_STATE_KEY = 'github';
// Separate key for the rolling emitted-commit-sha set (see syncGithub). Kept
// apart from SYNC_STATE_KEY so the POST sync route can't wipe it. Capped to the
// most recent CAP shas so it can't grow unbounded.
const EMITTED_SHAS_KEY = 'github_emitted_shas';
const EMITTED_SHAS_CAP = 20000;
const DEFAULT_REPOS = (process.env.GITHUB_DEFAULT_REPOS ?? 'RocketTeam,TeamBrain')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

interface SyncState {
  repos: Record<
    string,
    { lastSyncedAt?: string; lastEventId?: string; lastCommitSha?: string }
  >;
}

interface PullRef {
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: { login: string };
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  body: string | null;
  html_url: string;
  requested_reviewers?: Array<{ login: string }>;
  draft: boolean;
  updated_at: string;
}

interface PushRef {
  type: string;
  actor: { login: string };
  repo: { name: string };
  payload: {
    ref?: string;
    commits?: Array<{ sha: string; message: string; author: { name: string; email: string } }>;
    pull_request?: PullRef;
    action?: string;
    requested_reviewer?: { login: string };
    review?: { state: string; user: { login: string } };
  };
  created_at: string;
  id: string;
}

interface RepoTarget {
  owner: string;
  name: string;
}

async function resolveRepoTargets(): Promise<RepoTarget[]> {
  const cfg = await readConfig();
  if (!cfg) return [];
  const owner = cfg.org_or_user ?? cfg.login;
  if (!owner) return [];
  const selected = cfg.selected_repos ?? [];
  // If user configured repos explicitly via the web UI, honor them. Otherwise
  // pick the defaults (RocketTeam, TeamBrain) scoped to the connected org.
  if (selected.length > 0) {
    return selected.map((r) => ({ owner: r.owner, name: r.name }));
  }
  return DEFAULT_REPOS.map((n) => ({ owner, name: n }));
}

export interface GhSyncSummary {
  reposTried: number;
  eventsEmitted: number;
  errors: Array<{ repo?: string; error: string }>;
}

export async function syncGithub(): Promise<GhSyncSummary> {
  const summary: GhSyncSummary = { reposTried: 0, eventsEmitted: 0, errors: [] };
  const token = await getToken();
  if (!token) {
    summary.errors.push({ error: 'no GitHub token configured' });
    return summary;
  }
  // Identity reconcile BEFORE pulling events: follow GitHub transfers/renames
  // so the config's selected_repos owner/name reflects live truth. Without
  // this, a transferred repo (Upp-Ljl/Pace → anzy-renlab-ai/Pace) keeps
  // ingesting events fine (GitHub 301-redirects the events call), but the
  // ownership snapshot rots and the external-owner rule lies. Sync now keeps
  // BOTH the event stream AND the identity snapshot fresh.
  try {
    const { moves, removed } = await reconcileTrackedRepoOwners(token);
    for (const mv of moves) console.warn(`[github] repo transfer/rename: ${mv.from} → ${mv.to}`);
    for (const r of removed) console.warn(`[github] tracked repo gone (404/451), untracked: ${r}`);
  } catch (err) {
    summary.errors.push({ error: `owner reconcile failed: ${(err as Error).message}` });
  }
  const targets = await resolveRepoTargets();
  if (targets.length === 0) {
    summary.errors.push({ error: 'no repo targets resolved' });
    return summary;
  }
  const state = (await readSyncState<SyncState>(SYNC_STATE_KEY)) ?? { repos: {} };
  const toEmit: NewEvent[] = [];

  // Persistent emitted-commit-sha set, in its OWN sync_state key so the heavy
  // /api/github/sync POST route (which rewrites SYNC_STATE_KEY without the
  // lastCommitSha cursor) can't clobber it. This is the robust dedup: a commit
  // is emitted at most once EVER, regardless of (a) the per-repo cursor getting
  // wiped, or (b) the same repo appearing under multiple owner keys after a
  // transfer (Upp-Ljl/d2p + anzy-renlab-ai/d2p + Hosico02/d2p all share shas).
  // Without it, every sync re-emitted ~50 commits/repo → 22x duplicate events.
  const emittedState =
    (await readSyncState<{ shas?: string[] }>(EMITTED_SHAS_KEY)) ?? { shas: [] };
  const emittedShas = new Set(emittedState.shas ?? []);

  for (const t of targets) {
    summary.reposTried++;
    const repoKey = `${t.owner}/${t.name}`;
    const repoState = state.repos[repoKey] ?? {};
    try {
      const events = await ghCall<PushRef[]>(
        `/repos/${t.owner}/${t.name}/events`,
        token,
        { per_page: 50 }
      );
      let newestId = repoState.lastEventId;
      for (const ev of events) {
        // Stop when we hit something we've already seen. GitHub event ids are
        // monotonically decreasing in this listing.
        if (repoState.lastEventId && ev.id === repoState.lastEventId) break;
        const emitted = await transformEvent(ev, t);
        toEmit.push(...emitted);
        if (!newestId || ev.id > newestId) newestId = ev.id;
      }

      // Commits: the /events listing rarely surfaces PushEvents (it's weighted
      // toward PRs/issues/releases), so pull the commits endpoint directly to
      // emit gh.commit_pushed — the ground-truth signal the commit_repo_join
      // attribution tier joins on. Walk newest-first and stop at the SHA cursor
      // we persisted last sync (the commits listing is newest-first).
      let newestSha = repoState.lastCommitSha;
      const commits = await fetchRecentCommits(token, t.owner, t.name);
      for (let i = 0; i < commits.length; i++) {
        const c = commits[i];
        if (i === 0) newestSha = c.sha; // keep cursor too (cheap secondary guard)
        // Global sha dedup — emit a commit at most once ever. Survives cursor
        // wipes + cross-owner repoKey churn (the real cause of the 22x bloat).
        if (emittedShas.has(c.sha)) continue;
        const emitted = await transformCommit(c, t);
        toEmit.push(...emitted);
        emittedShas.add(c.sha);
      }

      state.repos[repoKey] = {
        lastSyncedAt: new Date().toISOString(),
        lastEventId: newestId,
        lastCommitSha: newestSha
      };
    } catch (err) {
      summary.errors.push({ repo: repoKey, error: (err as Error).message });
    }
  }

  if (toEmit.length > 0) await appendEvents(toEmit);
  summary.eventsEmitted = toEmit.length;
  await writeSyncState(SYNC_STATE_KEY, state);
  // Persist the emitted-sha set, capped to the most recent EMITTED_SHAS_CAP
  // (newest kept — the set is iterated insertion-order, so slice the tail).
  const shaArr = [...emittedShas];
  await writeSyncState(EMITTED_SHAS_KEY, {
    shas: shaArr.length > EMITTED_SHAS_CAP ? shaArr.slice(-EMITTED_SHAS_CAP) : shaArr
  });
  // Bump config last_sync_at so /sources shows a fresh "synced X ago". The
  // POST /api/github/sync route also writes this, but the monitor loop calls
  // syncGithub() directly (the route is auth-gated and 401s for internal
  // calls), so the extractor must own this timestamp to stay honest.
  try {
    const cfg = await readConfig();
    if (cfg) {
      cfg.last_sync_at = new Date().toISOString();
      await writeConfig(cfg);
    }
  } catch {
    /* best-effort; sync itself already succeeded */
  }
  return summary;
}

async function transformEvent(ev: PushRef, t: RepoTarget): Promise<NewEvent[]> {
  const actorLogin = ev.actor?.login;
  const actorRes = actorLogin
    ? await resolveOrUnknown('github', actorLogin)
    : { name: 'unknown:github:none', unresolved: true };
  const repoRef = `${t.owner}/${t.name}`;
  const out: NewEvent[] = [];
  switch (ev.type) {
    case 'PushEvent': {
      const commits = ev.payload.commits ?? [];
      for (const c of commits) {
        out.push({
          ts: ev.created_at,
          source: 'github',
          type: 'gh.commit_pushed',
          subject: { kind: 'repo', ref: repoRef },
          actor: actorRes.name,
          evidence: {
            quote: c.message.slice(0, 200),
            fields: {
              sha: c.sha,
              ref: ev.payload.ref,
              author: c.author?.name
            }
          },
          raw_ref: `https://github.com/${repoRef}/commit/${c.sha}`
        });
      }
      break;
    }
    case 'PullRequestEvent': {
      const pr = ev.payload.pull_request;
      if (!pr) break;
      const action = ev.payload.action;
      const prSubject = { kind: 'pr' as const, ref: `${repoRef}#${pr.number}` };
      const baseEvidence = {
        quote: pr.title,
        fields: {
          number: pr.number,
          state: pr.state,
          merged: !!pr.merged_at,
          draft: pr.draft
        }
      };
      if (action === 'opened') {
        out.push({
          ts: ev.created_at,
          source: 'github',
          type: 'gh.pr_opened',
          subject: prSubject,
          actor: actorRes.name,
          evidence: baseEvidence,
          raw_ref: pr.html_url
        });
      } else if (action === 'closed') {
        out.push({
          ts: ev.created_at,
          source: 'github',
          type: pr.merged_at ? 'gh.pr_merged' : 'gh.pr_closed',
          subject: prSubject,
          actor: actorRes.name,
          evidence: baseEvidence,
          raw_ref: pr.html_url
        });
      }
      break;
    }
    case 'PullRequestReviewRequestedEvent': {
      const reviewer = ev.payload.requested_reviewer?.login;
      const pr = ev.payload.pull_request;
      if (!reviewer || !pr) break;
      const reviewerRes = await resolveOrUnknown('github', reviewer);
      out.push({
        ts: ev.created_at,
        source: 'github',
        type: 'gh.review_requested',
        subject: { kind: 'pr', ref: `${repoRef}#${pr.number}` },
        actor: actorRes.name,
        evidence: {
          quote: pr.title,
          fields: {
            reviewer: reviewerRes.name,
            reviewer_login: reviewer,
            number: pr.number
          }
        },
        raw_ref: pr.html_url
      });
      break;
    }
    case 'PullRequestReviewEvent': {
      const review = ev.payload.review;
      const pr = ev.payload.pull_request;
      if (!review || !pr) break;
      out.push({
        ts: ev.created_at,
        source: 'github',
        type: 'gh.review_submitted',
        subject: { kind: 'pr', ref: `${repoRef}#${pr.number}` },
        actor: actorRes.name,
        evidence: {
          quote: pr.title,
          fields: { state: review.state, reviewer_login: review.user?.login }
        },
        raw_ref: pr.html_url
      });
      break;
    }
    default:
      // Other event types (IssuesEvent, WatchEvent, etc) — ignored for now.
      break;
  }
  return out;
}

// Resolve a commit author to a canonical team name using the SAME resolver chain
// the PR path uses, so PR actors and commit actors land on identical names (the
// attribution tiers gate on actor === run.operator). Prefer the GitHub login
// (commit.author.login, mirrors the PR `resolveOrUnknown('github', login)` call);
// fall back to the author email (commits API carries it, logins can be null for
// web-UI / bot / unlinked commits); last resort, the raw author name as an
// unresolved sentinel.
async function resolveCommitAuthor(c: GithubCommit): Promise<string> {
  const login = c.author?.login;
  if (login) {
    const res = await resolveOrUnknown('github', login);
    return res.name;
  }
  const email = c.commit.author?.email;
  if (email) {
    const byEmail = await lookupEmail(email);
    if (byEmail) return byEmail;
    return `unknown:github:${email}`;
  }
  const name = c.commit.author?.name;
  return name ? `unknown:github:${name}` : 'unknown:github:none';
}

// Emit a gh.commit_pushed event in the shape resolveByCommitRepo expects:
// subject={kind:'repo', ref:'owner/name'}, actor=canonical name (same resolver
// as PRs), ts=commit author date, evidence.fields.sha=commit SHA. Mirrors the
// PushEvent emit branch in transformEvent.
async function transformCommit(c: GithubCommit, t: RepoTarget): Promise<NewEvent[]> {
  const repoRef = `${t.owner}/${t.name}`;
  const actor = await resolveCommitAuthor(c);
  // Author date drives the run-window join in resolveByCommitRepo; fall back to
  // committer date, then now if both are absent/invalid.
  const ts =
    c.commit.author?.date ?? c.commit.committer?.date ?? new Date().toISOString();
  return [
    {
      ts,
      source: 'github',
      type: 'gh.commit_pushed',
      subject: { kind: 'repo', ref: repoRef },
      actor,
      evidence: {
        quote: (c.commit.message ?? '').slice(0, 200),
        fields: {
          sha: c.sha,
          author: c.commit.author?.name ?? c.commit.author?.email
        }
      },
      raw_ref: `https://github.com/${repoRef}/commit/${c.sha}`
    }
  ];
}
