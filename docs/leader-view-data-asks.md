# Leader CC Status — what's built, what needs data

> 2026-05-12. The dashboard now follows the attention-scarce-leader model:
> roster shows only "who needs you to step in", everything else is drill-down.

## The model (recap)

| Layer | Who looks | What |
|---|---|---|
| **Roster** (`/status`, `team:status`) | leader, daily glance | open anomalies on top, team aggregate (cost + activity counts), one line per agent: anomaly flag / last active / current repo. Anomaly agents first; clean agents below; no-data folded. |
| **Push** (Slack DM "RocketTeam") | leader, when something fires | act-now anomaly opens → one-time DM |
| **Person detail** (`/status/[name]`, `team:status <name>`) | leader, when concerned about someone | recent sessions, tools, tokens, stuck quotes |
| **Session detail** | leader, when looking at one session | NOT BUILT YET — needs transcript re-fetch + summary |
| **NOT in leader view** | — | per-person token-per-line, prompt style, compact frequency, hook health, version status, time-of-day distribution, idle rate. → routed to: coaching (the person's own self-view + 1:1), infra (maintainer alerts), or not built (vanity/surveillance). |

## Built now (from data available: CC transcripts, Slack events)

- `getRosterView()` — roster + aggregate + anomalies → `/api/cc-status`
- `getOneStatus(name)` — person detail → `/api/cc-status/[name]`
- Anomaly rules firing on real data: `blocked.cc_attested`, `dispatch.uncertain`, `override.spike`, `danger.command.*` (Bash command scan: rm -rf / force push / hard reset / prod / secret / DROP TABLE — whitelists `.codex/.claude/worktrees/` rm), `silence.dormant` (CC quiet 3d + has open workload), `blocked.review_pending` (GitHub PR review pending — needs GitHub connected)
- Web: `/status` (lean roster), `/status/[name]` (detail)
- CLI: `team:status` (roster), `team:status <name>` (detail), `team:ask <name> "..."` (LLM Q&A over CC events), `team:dispatch brief [context]`
- Slack DM push on act-now (needs slack workspace to have a user matching `LEADER_NAME` = 安子岩, or a slack id in `private/identity.json`)

## Needs data to build

| Feature | Needs | Where it goes |
|---|---|---|
| **Quota outliers** ("撞限额" — agents repeatedly hitting 5h/7d limit, can't work) | `quota.json` per agent (5h/7d usage + reset). Wire an extractor `src/extractors/quota.ts` → emit `quota.usage` events; add a `quota.threat` anomaly rule + populate `TeamAggregate.quotaNear` | roster aggregate + anomaly push |
| **Tool success/failure ratio** | PostToolUse event store (exit codes per tool call). Extractor → emit `cc.tool_result` events with exit_code; person detail shows success rate | person detail |
| **Repeated-failure / 卡点 detection** | PostToolUse failures + transcript pattern (same tool failing N times). Combine with existing `cc.stuck_signal` | anomaly rule `stuck.repeated_failure` |
| **重做率** (correction rate — same thing changed repeatedly) | TeamBrain correction-detector events | person detail; possibly an anomaly if high |
| **TeamBrain 拦截 / 规则命中** | TeamBrain block/warn events + rule injection log | person detail (coaching context) — NOT roster |
| **queue 积压** (data not uploading) | digital-twin queue status | roster anomaly (a person's data going stale = blind spot) |
| **hook 健康 / 版本状态** | OS process/hook status, version | **maintainer alert, NOT leader view.** If hooks break, page the maintainer. Don't show the boss a red dot for infra. |
| **PII / 密钥泄漏** | TeamBrain PII redactor logs + a transcript scanner | anomaly push (act-now) |
| **Session detail page** | re-fetch raw transcript per session id (collector already serves `/api/file?...`), parse Edit/Write diffs, LLM summary | new `/status/session/[sid]` |
| **G — session 主题摘要** ("在调认证 bug" / "在写 remotion 视频") | LLM over transcript (compute is easy). **Gated on a separate "content insight" opt-in** — `digital-twin` config has a `consent` field but consenting to data collection ≠ consenting to the boss reading conversation summaries. Need: per-feature opt-in, private-session flag, retention policy. | person detail (pull only, never pushed). Build the consent gate FIRST. |

Removed by decision: 录音转写 (audio transcription) — cancelled.

Not building: token-per-line cost, time-of-day distribution, idle rate. (Vanity metrics / surveillance-flavored / non-actionable.)

## To wire a new data source

1. Add `src/extractors/<source>.ts` — pull, normalize to `Event` shape, `appendEvents`, persist a cursor via `readSyncState`/`writeSyncState`.
2. Add it to `src/scripts/sync.ts`'s `should()` switch.
3. If it should produce anomalies, add a rule to `ALL_RULES` in `src/anomaly/rules.ts`.
4. If it feeds the roster aggregate, extend `getTeamAggregate` in `src/services/cc_status.ts`.
5. If it feeds person detail, extend `getOneStatus`.
6. **Stick to audited-truthy fields.** Don't promote LLM-narrative into anomaly triggers without explicit attestation. (See `UX-CC-FIRST.md` §0.)

## What to hand over (in priority order)

1. **`quota.json`** (per-agent 5h/7d usage + reset) — unlocks "撞限额", high leader value, low build cost.
2. **PostToolUse event store** — unlocks tool success rate + repeated-failure detection.
3. **digital-twin queue status** — unlocks "this person's data is going stale" blind-spot alert.
4. **TeamBrain block/correction events** — unlocks 重做率 + 踩坑监控 (person detail, coaching context).
5. **OS process/hook/version status** — but route this to the maintainer, not the leader view.
6. (eventually) the consent-gate design for G content insights.
