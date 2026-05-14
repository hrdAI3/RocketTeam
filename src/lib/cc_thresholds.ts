// Shared "hot" thresholds for the live CC signals.
//
// Used both server-side (anomaly derivation + aggregate outliers in
// cc_status.ts) and client-side (roster chips + detail-page warning tints).
// Keeping them in ONE node-free module means the roster chip, the aggregate
// strip, and the "要你介入" anomaly never quietly disagree about what counts as
// "near full" — which is the kind of mismatch that erodes trust in the view.
//
// The ladder, for both quota windows and the context window:
//   ≥ WARN  → amber tint on the detail page · listed in the aggregate strip ·
//             roster gets a small chip · a `next-glance` anomaly
//   ≥ CRIT  → an `act-now` anomaly (only for the 5h quota window — that one
//             actually cuts the person off)

// Reactive ("near limit") — fire when current util is already high regardless
// of pace. 7d's bar is intentionally near the top (0.95): 7d util drifts toward
// 90% on busy users in the normal course; it only deserves a glance when truly
// near the wall.
export const QUOTA_WARN = 0.85; // 5h
export const QUOTA_5H_CRIT = 0.95; // 5h — imminent cutoff
export const QUOTA_7D_WARN = 0.95;

// Predictive ("at current pace, will exceed by window end").
//   projection = util / progress.
// Only fires when there's still enough window left to course-correct — a 7d
// window at 93% with 17% left can be intentional and resets imminently; firing
// then is noise. A 7d window at 30% with most of the week to go is the case
// worth flagging.
export const PACE_RISK = 1.1; // next-glance: projected at least 10% over
export const PACE_CRIT = 1.4; // act-now: clearly burning past the limit
export const PACE_MIN_PROGRESS = 0.05; // need some elapsed time so the rate is meaningful
export const PACE_MIN_REMAINING = 0.25; // need at least 25% of the window left to course-correct
export const PACE_MIN_UTIL = 0.2;
export const PACE_CRIT_MIN_UTIL = 0.35;

export const CONTEXT_WARN = 0.85; // session context window utilization
export const CONTEXT_CRIT = 0.92; // about to need /compact — next-glance anomaly

// Tool-failure ratio: shown as an amber tint on the per-agent detail tile when
// the failed/total ratio is this high (with at least MIN calls so a 1/1 fluke
// doesn't trip it). Deliberately NOT an anomaly — tool failures are noisy
// (permission prompts, transient FS) and not something a 24-person leader acts
// on; it stays pull-only on the detail page.
export const TOOL_FAIL_MIN = 10;
export const TOOL_FAIL_RATIO = 0.4;

// A live session that's paused (no events) for under this long still counts as
// "current" for the purpose of raising context-window concerns about it.
export const LIVE_STALE_FRESH_MS = 30 * 60_000;
