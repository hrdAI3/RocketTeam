// Server-side monitor loop. Owns two things:
//   1. Keeping every active/idle agent's `work_summary` cache warm — so the
//      `/status` roster always shows what each person is *currently* working on
//      without waiting on a page click to trigger an LLM call.
//   2. Watching live-derived concerns (quota near / pace projected to exceed /
//      context near full) and pushing the act-now ones to the leader via the
//      existing Slack push pipeline. Same idempotency guard as the engine
//      anomaly pushes so we don't spam.
//
// The loop is module-init: import this file anywhere in the server runtime
// (e.g. instrumentation.ts) and a single interval starts on server boot. A
// global flag guards against dev hot-reload stacking multiple intervals.

import { getAllStatus } from './cc_status';
import { refreshActiveWorkSummaries } from './work_summary';
import { getLiveStatusAll } from './live_cc';
import {
  notifyActNowIfNew,
  notifyAttentionIfNew,
  notifyBlockedProjectIfNew,
  notifyUnattributedDigest,
  notifyAgedUnattributed,
  notifyAgedProject,
  markNotifiedSilent
} from './leader_push';
import { workingDaysBetween } from '../lib/workdays';
import { refreshRoster } from './refresh_roster';
import { buildAndWriteBehaviorSnapshot } from './behavior_snapshot';
import { prewarmDashboards } from './prewarm';
import { readRoster, type Member } from '../lib/team_roster';
import { runComplianceTick } from './gh_compliance';
import { deliverDailyBriefIfDue, beijingDate, beijingDateTime } from './daily_brief';
import { notifyAtRiskGoals, driftNudge } from './goal_actuators';
import { startSlackSocket } from './slack_socket';
import { readSyncState, writeSyncState } from '../lib/events';
import { getWorkboardView } from './workboard';
import { attributeAnomalyToProject } from './anomaly_attribution';
import { readProjects } from '../lib/projects';
import { getRosterView } from './cc_status';
import { buildSuppressionMap, isSuppressed } from '../lib/leader_actions';
import { syncGithub } from '../extractors/github';
import { syncSlack } from '../extractors/slack';
import type { Anomaly, AnomalySeverityHint } from '../types/events';
import {
  PACE_RISK,
  PACE_MIN_PROGRESS,
  PACE_MIN_REMAINING,
  PACE_MIN_UTIL
} from '../lib/cc_thresholds';

const POLL_MS = Number(process.env.MONITOR_POLL_MS ?? 5 * 60_000); // 5 min default
const WINDOW_MS_7D = 7 * 24 * 60 * 60 * 1000;
// GitHub + Slack sync is heavier (per-repo / per-channel API calls) and the
// data evolves more slowly than CC sessions, so poll on a quieter cadence.
// 10 min keeps "synced X min ago" feeling alive without burning API quota.
const SOURCE_SYNC_MS = Number(process.env.MONITOR_SOURCE_SYNC_MS ?? 10 * 60_000);
// Roster health (Slack/CC/GH) refresh cadence — slower than source-sync
// because all three signals shift on the human-policy timescale (employee
// configures GH profile, joins/leaves Slack).
const ROSTER_REFRESH_MS = Number(process.env.MONITOR_ROSTER_MS ?? 30 * 60_000);

declare global {
  // Hot-reload guard. Cleared on full server restart.
  // eslint-disable-next-line no-var
  var __ccMonitorStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ccMonitorInterval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __ccSourceSyncInterval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __ccRosterInterval: NodeJS.Timeout | undefined;
}

// Bound an awaited promise so a HANG (not a throw) surfaces as a caught reject
// instead of silently freezing the whole rosterTick and starving the brief
// (the 6-04 wedge: buildAndWriteBehaviorSnapshot hung, the try never exited, and
// deliverDailyBriefIfDue downstream was never reached — both markers froze at
// 6-03). try/catch only catches throws; this converts a hang into a throw. The
// timeout is set safely ABOVE the legit ~22s snapshot build so a slow-but-fine
// build is never aborted+re-run forever.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
const ROSTER_STEP_TIMEOUT_MS = Number(process.env.MONITOR_ROSTER_STEP_TIMEOUT_MS ?? 90_000);

function quotaPace(
  util: number | undefined,
  resetAtSec: number | undefined,
  windowMs: number,
  nowMs: number
): { progress: number; projection: number } | null {
  if (typeof util !== 'number' || typeof resetAtSec !== 'number') return null;
  const elapsedMs = windowMs - (resetAtSec * 1000 - nowMs);
  const progress = Math.max(0, Math.min(1, elapsedMs / windowMs));
  if (progress <= 0) return { progress: 0, projection: util };
  return { progress, projection: util / progress };
}

// Same shape as live concerns in cc_status.ts but produced here so the loop can
// push them without depending on a request-scoped `getRosterView` call.
async function computeLiveConcerns(): Promise<Anomaly[]> {
  const live = await getLiveStatusAll();
  if (live.size === 0) return [];
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const out: Anomaly[] = [];
  const mk = (
    name: string,
    rule: string,
    severity: AnomalySeverityHint
  ): Anomaly => ({
    id: `live:${rule}:${name}`,
    rule,
    subject: { kind: 'agent', ref: name },
    status: 'open',
    severity_hint: severity,
    triggered_at: nowIso,
    last_seen_at: nowIso,
    evidence_event_seqs: [],
    suggested_actions: [{ id: 'ask', label: `问问 ${name} 在干嘛`, tool: 'team:ask', args: { name } }]
  });
  // Same as cc_status.ts :: liveConcerns — only the 7d pace projection rule
  // is wired. No act-now anywhere.
  for (const [name, lf] of live) {
    const c = lf.current;
    const util = c.seven_day_utilization;
    if (typeof util !== 'number') continue;
    const pace = quotaPace(util, c.seven_day_reset_at, WINDOW_MS_7D, nowMs);
    if (!pace) continue;
    const remaining = 1 - pace.progress;
    const onPace =
      pace.progress >= PACE_MIN_PROGRESS &&
      remaining >= PACE_MIN_REMAINING &&
      util >= PACE_MIN_UTIL &&
      pace.projection >= PACE_RISK;
    if (!onPace) continue;
    out.push(mk(name, 'quota.pace_7d', 'next-glance'));
  }
  return out;
}

async function tick(): Promise<void> {
  // 1. Keep work summaries fresh for everyone in an active/idle window. Real
  //    work happens in `refreshActiveWorkSummaries` (cache-marker check → LLM
  //    call only when data changed).
  try {
    const all = await getAllStatus({ onlyWithActivity: true });
    const names = all
      .filter((s) => s.activityFlag === 'active' || s.activityFlag === 'idle')
      .map((s) => s.name);
    if (names.length > 0) await refreshActiveWorkSummaries(names);
  } catch (err) {
    console.warn('[monitor] summary refresh failed:', (err as Error).message);
  }
  // 2. Push act-now live concerns. `notifyActNowIfNew` is idempotent (keyed by
  //    the synthetic anomaly id), so the same quota.near_5h crit fires once,
  //    not every 5 minutes.
  try {
    const [concerns, suppression] = await Promise.all([computeLiveConcerns(), buildSuppressionMap()]);
    const nowIso = new Date().toISOString();
    for (const a of concerns) {
      if (a.severity_hint !== 'act-now') continue;
      if (isSuppressed(suppression.get(a.id), nowIso)) continue;
      await notifyActNowIfNew(a);
    }
  } catch (err) {
    console.warn('[monitor] live concerns push failed:', (err as Error).message);
  }

  // 3. Push everything else on the workboard's attention list (next-glance
  //    anomalies + blocked projects). Idempotent per item id — leader gets
  //    one DM the first time each fires, not on every tick. Skips fyi.
  //
  //    First-tick seeding: when the boot marker has never been written, we
  //    pre-mark every currently-open attention item as already-notified so
  //    the leader doesn't get a 20+ DM blast right after dev restart. Real
  //    new fires (anything that opens after seeding) DM normally.
  try {
    const view = await getWorkboardView();
    const suppression = await buildSuppressionMap();
    const nowIso = new Date().toISOString();

    const allAttentionIds: string[] = [
      ...view.anomalies
        .filter((a) => a.severity_hint !== 'fyi')
        .map((a) => a.id),
      ...view.projects.filter((p) => p.status === 'blocked').map((p) => `blocked:${p.key}`)
    ];
    const bootKey = 'leader_push_boot';
    const booted = (await readSyncState<{ seededAt?: string }>(bootKey)) ?? {};
    if (!booted.seededAt) {
      const seeded = await markNotifiedSilent(allAttentionIds);
      console.log(`[monitor] first-boot seed: ${seeded} attention id(s) marked silently`);
      await writeSyncState(bootKey, { seededAt: nowIso });
    } else {
      // Build the agent → cwd map once per tick so per-anomaly attribution
      // doesn't refetch the roster. Cheap join; getRosterView is already
      // memoized at the request scope upstream.
      const roster = await getRosterView();
      const cwdByAgent = new Map<string, string | null | undefined>();
      for (const r of roster.roster) cwdByAgent.set(r.name, r.currentRepo ?? null);
      const projects = await readProjects();
      const nameById = new Map(projects.projects.map((p) => [p.id, p.name]));

      // Per-thread `project.unattributed` DMs are deliberately suppressed —
      // they collapsed into the digest below. Everything else flows as before.
      let unattributedCount = 0;
      for (const a of view.anomalies) {
        if (a.severity_hint === 'fyi') continue;
        if (a.severity_hint === 'act-now') continue; // covered above
        if (a.rule === 'project.unattributed') {
          unattributedCount++;
          continue;
        }
        if (isSuppressed(suppression.get(a.id), nowIso)) continue;
        const attr = await attributeAnomalyToProject(a, { cwdByAgent });
        const projectName = attr.projectId ? (nameById.get(attr.projectId) ?? null) : null;
        await notifyAttentionIfNew(a, { projectName });
      }
      if (unattributedCount > 0) {
        await notifyUnattributedDigest(unattributedCount);
      }

      // §aging — track each unattributed thread's first-seen ts. After 1d
      // unresolved, fire stage-1 to operator; +24h → stage 2; +24h → stage 3;
      // +24h → stage 4 (operator + leader cc'd). State file is keyed by
      // stableId(title). Idempotency lives in leader_push (one DM per
      // (thread, operator, stage) tuple).
      await trackAndNotifyAged(view.untrackedProjects ?? [], view.unclustered);

      // §external-owner — DISABLED as a DM channel. The gh-compliance engine
      // (runComplianceTick) already nags the owner of a personal-account
      // tracked repo with the exact same "transfer to anzy-renlab-ai or set a
      // company email" ask, and it's the one that escalates to the leader.
      // Sending an external-owner DM too meant the same person got two
      // redundant reminders for the same repo. The repos are still SURFACED on
      // /status (the FYI "Repo on personal account" rows from
      // /api/repo-ownership) — we just don't double-DM about them.
      // (notifyExternalOwnerRepoIfNew kept exported for manual/leader use.)
      // Blocked projects DM only on real status transitions (active→blocked).
      // notifyBlockedProjectIfNew is idempotent by key, so a project that
      // *stays* blocked won't re-fire. Spec §2.3 debouncing applies upstream
      // in `projectStatus()`.
      for (const p of view.projects) {
        if (p.status !== 'blocked') continue;
        await notifyBlockedProjectIfNew({
          key: p.key,
          name: p.name,
          threadCount: p.workItems.length,
          ccCount: p.ccCount,
          lastActivityAt: p.lastActivityAt
        });
      }
    }
  } catch (err) {
    console.warn('[monitor] attention push failed:', (err as Error).message);
  }

}

// GitHub + Slack auto-sync. Calls the heavy POST routes (not the lightweight
// extractors) so transcripts / PR context files in `team/private/context/`
// get refreshed, not just `events.jsonl`. Without this the on-disk artifacts
// stay frozen at whatever the leader last manually triggered from the browser.
//
// Routes need the selected channels / repos in the request body — read from
// the same persisted configs the UI uses.
// §aging tracker. Reads / writes `sync_state/unattributed_aging.json`:
//   { entries: { [stableId]: { title, operator, first_seen, notify_count,
//                              last_notified_at } } }
// Escalation cadence (working days only — weekends + private/holidays.json
// skipped). Per GH_COMPLIANCE.md §0/§3 the OPERATOR is DM'd at every stage
// (it's their work to archive); the leader is cc'd only at stage 4.
//   first_seen + 3 wd → stage 1 (operator DM)   ← sustained-work grace
//   stage 1   + 1 wd  → stage 2 (operator DM)
//   stage 2   + 1 wd  → stage 3 (operator DM)
//   stage 3   + 1 wd  → stage 4 (operator + leader DM)
//   beyond stage 4    → no further DMs
// On each call: refresh entries from the current unclustered set, drop those
// that disappeared (thread got attributed / abandoned → clock resets), and
// fire any DM whose stage window has elapsed.
const STAGE_GAP_WORKDAYS = 1; // one working day between escalations (stage 2→3→4)
// First nag waits longer: work that's still unattributed after 3 working days
// IS sustained work worth a repo. One-off exploration (read a repo, try a
// skill, a thesis side-quest) gets attributed or abandoned within 3 days —
// its entry drops out of unclustered before the grace elapses, so no nag.
// This is why a single grace knob suffices: "persisted 3 wd" == "sustained".
const FIRST_NAG_GRACE_WORKDAYS = 3;
const AGING_STATE_KEY = 'unattributed_aging';

interface AgingEntry {
  title: string;
  operator: string;
  first_seen: string;
  notify_count?: number;        // 0 = grace period; 4 = leader cc'd, done
  last_notified_at?: string;
  absent_ticks?: number;        // monitor ticks the project hasn't appeared; eviction grace
}
interface AgingState {
  entries?: Record<string, AgingEntry>;
}

function stableTitleId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface UntrackedProjectInput {
  key: string;
  name: string;
  owner: string | null;
  workItems: Array<{ title: string; status: string }>;
}

async function trackAndNotifyAged(
  untracked: UntrackedProjectInput[],
  // unclustered kept for the misc:* catch-all case where an unowned/misc
  // bucket needs to age separately — we don't nag on those by default but
  // the signature retains them so future per-item escalation can re-enable.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _unclustered: Array<{ title: string; status: string; ownerName?: string }>
): Promise<void> {
  const stateRaw = (await readSyncState<AgingState>(AGING_STATE_KEY)) ?? {};
  const entries = stateRaw.entries ?? {};
  const seen = new Set<string>();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  // Skip departed members — they can't act on a transfer/archive nag.
  const roster = await readRoster();
  const leftNames = new Set(roster.members.filter((m: Member) => m.status === 'left').map((m: Member) => m.name));

  for (const p of untracked) {
    if (!p.owner) continue;             // misc:* without an owner → never nag
    if (leftNames.has(p.owner)) continue; // departed → never nag
    // Skip the per-person catch-all key (`misc:<owner>`). Those are unclear
    // items that don't cluster into a real project — nagging "go register a
    // repo for `misc:X`" is meaningless; the per-item escalation path used to
    // handle them, but the user explicitly asked for per-project DMs only.
    if (p.key.startsWith('misc:')) continue;
    // Skip if all items are done.
    const liveTitles = p.workItems
      .filter((w) => w.status !== '已完成')
      .map((w) => w.title);
    if (liveTitles.length === 0) continue;

    const id = `${p.owner}:${p.key}`; // stable per (owner, project)
    seen.add(id);
    if (!entries[id]) {
      entries[id] = {
        title: p.name,                    // store project NAME (not item title)
        operator: p.owner,
        first_seen: nowIso,
        notify_count: 0,
        absent_ticks: 0
      };
      continue; // grace period starts now
    }
    // Project still seen this tick → reset absence counter so the grace clock
    // keeps running off the original first_seen.
    entries[id].absent_ticks = 0;
    const e = entries[id];
    const ageMs = nowMs - Date.parse(e.first_seen);
    if (!Number.isFinite(ageMs)) continue;

    const count = e.notify_count ?? 0;
    if (count >= 4) continue;

    const anchorIso = e.last_notified_at ?? e.first_seen;
    const workdaysPassed = await workingDaysBetween(anchorIso, new Date(nowMs));
    const requiredGap = count === 0 ? FIRST_NAG_GRACE_WORKDAYS : STAGE_GAP_WORKDAYS;
    if (workdaysPassed < requiredGap) continue;

    const nextStage = (count + 1) as 1 | 2 | 3 | 4;
    const daysOld = Math.max(1, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
    const result = await notifyAgedProject({
      stableId: id,
      operator: e.operator,
      projectName: p.name,
      itemTitles: liveTitles,
      daysOld,
      stage: nextStage
    });
    const opOK =
      result.operator.pushed ||
      result.operator.reason === 'already-notified' ||
      result.operator.reason === 'op-skipped-by-policy';
    const leaderOK =
      nextStage !== 4 ||
      result.leader.pushed ||
      result.leader.reason === 'already-notified';
    if (opOK && leaderOK) {
      e.notify_count = nextStage;
      e.last_notified_at = nowIso;
    }
  }

  // Drop entries whose project has been ABSENT for N consecutive ticks.
  // Previously a single missing tick wiped the entry and reset first_seen on
  // its return — which never happened in practice because attribution-version
  // bumps and cache evicts caused the untracked list to flicker, so projects
  // bounced in/out and the 3-wd grace timer never accumulated. Anything that
  // truly resolves (operator archived it, LLM re-attributed it stably) will
  // stay absent for many ticks and still get evicted. Monitor ticks run on
  // a ~5min cadence, so this is roughly ~50min of grace.
  const ABSENT_TICKS_BEFORE_EVICT = 10;
  for (const id of Object.keys(entries)) {
    if (seen.has(id)) continue;
    const e = entries[id];
    e.absent_ticks = (e.absent_ticks ?? 0) + 1;
    if (e.absent_ticks >= ABSENT_TICKS_BEFORE_EVICT) {
      delete entries[id];
    }
  }
  await writeSyncState(AGING_STATE_KEY, { entries });
}

// kept for historic call paths; references silenced
void notifyAgedUnattributed;
void stableTitleId;

async function sourceSyncTick(): Promise<void> {
  // GitHub + Slack source sync. We call the EXTRACTORS directly — they own
  // the full sync now: pull events/messages, write transcripts + PR-derived
  // events into events.jsonl, and bump their own `last_sync_at`. We do NOT
  // POST the /api/{github,slack}/sync routes: those are auth-gated (the
  // middleware 401s an internal server-side fetch that carries no session
  // cookie), the route's extra work (PR snapshot files) has no readers, and
  // the failing fetch only spammed `[monitor] … sync route 401`.
  try {
    await syncGithub();
  } catch (err) {
    console.warn('[monitor] github extractor failed:', (err as Error).message);
  }
  try {
    await syncSlack();
  } catch (err) {
    console.warn('[monitor] slack extractor failed:', (err as Error).message);
  }
}

async function rosterTick(): Promise<void> {
  try {
    // Bounded: a hung roster refresh must not wedge the whole tick (and starve
    // the brief downstream). Surfaces as a caught error; the tick continues.
    await withTimeout(refreshRoster(), ROSTER_STEP_TIMEOUT_MS, 'refreshRoster');
  } catch (err) {
    console.warn('[monitor] roster refresh failed:', (err as Error).message);
  }
  // GitHub compliance: self-gated to one DM per person per working day, so
  // running it every roster tick is safe — it no-ops until a working day has
  // elapsed since the last reminder.
  try {
    const res = await withTimeout(runComplianceTick(), ROSTER_STEP_TIMEOUT_MS, 'runComplianceTick');
    if (res.dmed.length > 0 || res.leaderNotified.length > 0) {
      console.log(
        `[monitor] gh-compliance: dmed=${res.dmed.join(',')} leader=${res.leaderNotified.join(',')}`
      );
    }
  } catch (err) {
    console.warn('[monitor] gh-compliance failed:', (err as Error).message);
  }

  // Daily behavior-snapshot rebuild. The /api/team/context route reads the
  // dated snapshot file; if it's >7d old the route falls back to a ~22s
  // on-demand build on every cold request. Rebuilding once per Beijing day
  // keeps the file fresh so cold reads stay ~1.5s. Guarded by date so the
  // 30-min roster cadence only triggers it once a day.
  try {
    const SNAP_KEY = 'behavior_snapshot_last_build';
    const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    const st = (await readSyncState<{ date?: string }>(SNAP_KEY)) ?? {};
    if (st.date !== today) {
      // PRIME WEDGE fix: this ~22s build hung on 6-04 and never settled, so the
      // awaited try never exited and the brief step below was never reached.
      // Bound it (timeout > the legit build cost) so a hang becomes a caught
      // error and the tick proceeds to the brief instead of freezing forever.
      const r = await withTimeout(
        buildAndWriteBehaviorSnapshot(),
        ROSTER_STEP_TIMEOUT_MS,
        'buildAndWriteBehaviorSnapshot'
      );
      await writeSyncState(SNAP_KEY, { date: today });
      console.log(`[monitor] behavior snapshot rebuilt: ${r.nAgents} agents, ${r.nEvents} events, ${r.builtMs}ms → ${r.outPath}`);
    }
  } catch (err) {
    console.warn('[monitor] behavior snapshot rebuild failed:', (err as Error).message);
  }

  // Daily leader brief. Self-gated: working-day + after BRIEF_MIN_HOUR Beijing
  // + once-per-day + not-paused. No-op on every other tick. DMs the leader the
  // morning "yesterday + today" digest.
  try {
    const r = await deliverDailyBriefIfDue();
    if (r.delivered) console.log('[monitor] daily brief delivered to leader');
  } catch (err) {
    console.warn('[monitor] daily brief failed:', (err as Error).message);
  }

  // Goal actuators — daily-cadence strategy nudges, send:true (real send on the
  // tick, mirroring the brief). Each is self-gated INSIDE (not-paused +
  // working-day + per-item once-per-day marker), so calling them every ~30min
  // roster tick is a no-op until due — same contract as deliverDailyBriefIfDue
  // and runComplianceTick. In their own try/catch so a failure can't wedge the
  // heartbeat below.
  try {
    const r = await notifyAtRiskGoals({ send: true });
    if (r.sent.length > 0) console.log(`[monitor] at-risk goal nudge sent: ${r.sent.join(',')}`);
  } catch (err) {
    console.warn('[monitor] at-risk goal nudge failed:', (err as Error).message);
  }
  try {
    const r = await driftNudge({ send: true });
    if (r.sent.length > 0) console.log(`[monitor] drift nudge sent: ${r.sent.join(',')}`);
  } catch (err) {
    console.warn('[monitor] drift nudge failed:', (err as Error).message);
  }

  // HEARTBEAT — LAST statement of rosterTick. Records that the tick completed
  // THROUGH the brief + actuator steps at T. If the 6-04 wedge recurs, this
  // marker frozen at the last good day pinpoints the wedge without SSH. Best-
  // effort: never throws out of the tick.
  try {
    const now = new Date();
    await writeSyncState('monitor_roster_heartbeat', {
      at: now.toISOString(),
      at_beijing: beijingDateTime(now),
      reached: 'brief'
    });
  } catch (err) {
    console.warn('[monitor] roster heartbeat write failed:', (err as Error).message);
  }
}

export function startMonitorLoop(): void {
  if (globalThis.__ccMonitorStarted) return;
  globalThis.__ccMonitorStarted = true;
  // Fire one immediately so the cache populates on first request.
  void tick();
  globalThis.__ccMonitorInterval = setInterval(() => void tick(), POLL_MS);
  // GitHub + Slack on their own slower interval. Fire once shortly after boot
  // (delayed so it doesn't compete with the CC warm-up call).
  setTimeout(() => void sourceSyncTick(), 8_000);
  globalThis.__ccSourceSyncInterval = setInterval(
    () => void sourceSyncTick(),
    SOURCE_SYNC_MS
  );
  // Roster refresh on its own slower cadence. Delayed first run so it
  // doesn't pile onto the boot warm-up.
  setTimeout(() => void rosterTick(), 15_000);
  globalThis.__ccRosterInterval = setInterval(() => void rosterTick(), ROSTER_REFRESH_MS);
  // Inbound Slack DM channel (Socket Mode). No-op if SLACK_APP_TOKEN unset.
  startSlackSocket();
  // One-shot dashboard prewarm ~25s after boot (after the first cc tick +
  // source sync have settled, so the 8 heavy streams don't fight the boot
  // warm-up). This seeds every memoTTL entry ONCE. After that the SWR cache
  // serves stale-instantly and revalidates in the background on each visit —
  // no periodic prewarm needed (running it every tick just created a 5-min
  // load spike from 8× 500MB streams). True cold only recurs after >1h of
  // zero traffic.
  setTimeout(() => {
    void prewarmDashboards().then((r) => {
      console.log(`[monitor] boot prewarm: ${r.warmed} warmed, ${r.failed} failed`);
    });
  }, 25_000);
  console.log(
    `[monitor] loop started; cc=${Math.round(POLL_MS / 1000)}s · sources=${Math.round(SOURCE_SYNC_MS / 1000)}s · roster=${Math.round(ROSTER_REFRESH_MS / 1000)}s`
  );
}
