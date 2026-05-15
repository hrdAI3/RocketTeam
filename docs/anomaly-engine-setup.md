# Anomaly Engine + CC-Native Briefing — Setup

Built per `docs/superpowers/specs/2026-05-11-anomaly-engine-cc-native-design.md`.
This guide gets the leader's daily briefing flowing in his own Claude Code session.

## What it does

- Pulls activity from four sources (CC SESSIONS, GitHub, Slack, Meeting transcripts)
- Detects anomalies via a small rule set (override spike, PR review backlog, CC-attested stuck signals, low-confidence dispatch pending)
- Generates a three-tier markdown briefing (act-now / next-glance / fyi)
- Exposes everything via an MCP server so the leader works from his own CC laptop

## 1. Environment

Required env vars (load via `.env`):

```bash
# LLM for team:today briefing + meeting extraction
LLM_PROVIDER=minimax|anthropic|openai_compat
MINIMAX_API_KEY=...                  # if using MiniMax
ANTHROPIC_API_KEY=...                # always recommended as fallback

# Source credentials (already in use by /api/slack and /api/github)
SLACK_VAULT_KEY=<long random>        # required even if Slack not connected
GITHUB_VAULT_KEY=<long random>       # optional, falls back to SLACK_VAULT_KEY

# CC SESSIONS collector
CC_COLLECTOR_BASE=http://192.168.22.88:8933   # default

# GitHub repos to watch (comma-separated, scoped to the connected org)
GITHUB_DEFAULT_REPOS=RocketTeam,TeamBrain

# Optional: where MCP server reaches the Next.js app (for team:dispatch / team:ask)
TEAM_API_BASE=http://127.0.0.1:3000
```

## 2. Identity map

Edit `private/identity.json` to map external accounts to canonical agent names:

```json
{
  "email": {
    "liboze2026@163.com": "李博泽",
    "duck@libz.ai":       "戴昊然",
    "thomas@libz.ai":     "孙润峰"
  },
  "github": {
    "github-login":       "对应中文名"
  },
  "slack": {
    "U01ABC":             "安子岩"
  }
}
```

Unresolved identifiers still emit events but with a `unknown:channel:id` subject ref.

## 3. One-shot sync

```bash
bun run sync                                        # all sources + anomaly engine
bun run sync --only=cc                              # just CC SESSIONS
bun run sync --only=cc --user=liboze2026@163.com    # single user
bun run sync --skip=meeting                         # exclude meeting extractor
bun run sync --only=anomaly                         # re-evaluate without re-syncing
```

Output is a JSON summary. Per-source state lives in `private/sync_state/<source>.json`.

## 4. Generate the briefing

```bash
bun run today
```

Prints markdown to stdout, meta to stderr. Leader can pipe to a file or read inline.

## 5. Schedule

Run sync + briefing on a cron. Minimal setup using `node-cron` is out of scope of
this MVP; for now use the OS scheduler:

**Linux/macOS** (`crontab -e`):
```cron
*/5 * * * * cd /path/to/team && bun run sync >> private/sync.log 2>&1
```

**Windows Task Scheduler**: create a task running `bun run sync` every 5 minutes
from the team directory.

## 6. Leader's Claude Code wiring

Add to leader's `claude_desktop_config.json` (Claude Desktop) or per-machine MCP config:

```json
{
  "mcpServers": {
    "team": {
      "command": "bun",
      "args": ["run", "C:/path/to/team/src/mcp/server.ts"],
      "env": {
        "TEAM_API_BASE": "http://127.0.0.1:3000",
        "MINIMAX_API_KEY": "...",
        "SLACK_VAULT_KEY": "...",
        "CC_COLLECTOR_BASE": "http://192.168.22.88:8933"
      }
    }
  }
}
```

Restart Claude Code. Tools available (4):
- `team:status`    — team CC roster: open anomalies + aggregate (weekly token cost, activity counts, who needs you) + one line per agent. `team:status <name>` for that agent's detail.
- `team:today`     — three-tier anomaly briefing (act-now / next-glance / fyi)
- `team:dispatch`  — task dispatch via simulation prediction. Pass conversation `context` so the sim has the full picture.
- `team:ask`       — natural-language Q&A about one agent's recent CC work (LLM over their CC events)

Web: `/status` is the dashboard (root redirects here) — anomalies on top, aggregate
strip, lean roster. Click a row → `/status/<name>` for detail. Persona/task/org pages
moved under "深入" in the sidebar (debug only).

Anomalies do not need a "resolve" command: the engine auto-resolves when the rule
stops firing, and an act-now anomaly fires a one-time Slack DM to the leader (sender
label "RocketTeam"). What's built vs what needs more data: see
`docs/leader-view-data-asks.md`.

## 7. Loop for periodic briefings

In the leader's CC session:

```
/loop 30m team:today
```

Every 30 minutes CC will pull `team:today` and surface the latest briefing.
Set the cadence to whatever the leader wants — only `act-now` items are worth
interrupting his current work.

## 8. What to verify after first run

```bash
bun run sync --only=cc
cat private/events.jsonl | wc -l          # event count
bun run sync --only=anomaly
cat private/anomalies.current.json        # open anomalies
bun run today                             # briefing
```

End-to-end smoke confirmed on 2026-05-11 against `liboze2026@163.com`:
17 sessions → 2992 events → 1 anomaly → briefing rendered.

## 9. Known noise sources (early dogfood)

The `cc.stuck_signal` regex is intentionally broad. Expect false positives in:
- Markdown templates containing literal `BLOCKED` or `stuck` strings
- Status reports listing past blockers

Tune by editing `STUCK_PATTERNS` in `src/extractors/cc_session.ts`.

The `dispatch.uncertain` rule needs >= 30 min lag before firing — short enough
to be useful, long enough that a dispatching leader is not pinged about a sim
he is still reading.

The `override.spike` rule requires >= 3 (override+accept) events in the window
to avoid screaming on day one. Re-tune `MIN_TOTAL` in `src/anomaly/rules.ts`
as data accumulates.

## 10. Adding more rules

`src/anomaly/rules.ts` exports `ALL_RULES`. Append new rules of type
`RuleFn = (ctx) => Candidate[]`. The engine handles de-dupe and state machine.
Stick to data sources whose truthiness has been audited
(`UX-CC-FIRST.md` §0). Do not promote LLM-narrative fields into anomaly
triggers without explicit attestation.
