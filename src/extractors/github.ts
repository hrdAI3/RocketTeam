// GitHub extractor.
// Pulls PR + commit activity for selected repos and emits normalized events.
// Starts with two repos by default: RocketTeam, TeamBrain (per user direction).
//
// Reuses src/lib/github.ts for token retrieval and HTTP plumbing.

import { appendEvents, readSyncState, writeSyncState } from '../lib/events';
import { resolveOrUnknown } from '../lib/identity';
import { getToken, readConfig, ghCall } from '../lib/github';
import type { NewEvent } from '../lib/events';

const SYNC_STATE_KEY = 'github';
const DEFAULT_REPOS = (process.env.GITHUB_DEFAULT_REPOS ?? 'RocketTeam,TeamBrain')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

interface SyncState {
  repos: Record<string, { lastSyncedAt?: string; lastEventId?: string }>;
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
  const targets = await resolveRepoTargets();
  if (targets.length === 0) {
    summary.errors.push({ error: 'no repo targets resolved' });
    return summary;
  }
  const state = (await readSyncState<SyncState>(SYNC_STATE_KEY)) ?? { repos: {} };
  const toEmit: NewEvent[] = [];

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
      state.repos[repoKey] = {
        lastSyncedAt: new Date().toISOString(),
        lastEventId: newestId
      };
    } catch (err) {
      summary.errors.push({ repo: repoKey, error: (err as Error).message });
    }
  }

  if (toEmit.length > 0) await appendEvents(toEmit);
  summary.eventsEmitted = toEmit.length;
  await writeSyncState(SYNC_STATE_KEY, state);
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
