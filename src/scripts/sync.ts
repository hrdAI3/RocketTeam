// One-shot sync: pull from each connected source, run the Anomaly Engine,
// write the snapshot. Intended for cron or manual invocation.
//
// Usage:
//   bun run src/scripts/sync.ts                  # all sources
//   bun run src/scripts/sync.ts --only=cc        # one source
//   bun run src/scripts/sync.ts --skip=meeting   # skip a source
//   bun run src/scripts/sync.ts --only=cc --user=liboze2026@163.com  # CC, single user

import { syncCcSessions } from '../extractors/cc_session';
import { syncGithub } from '../extractors/github';
import { syncSlack } from '../extractors/slack';
import { syncMeetings } from '../extractors/meeting';
import { evaluateAll } from '../anomaly/engine';
import { getAllStatus } from '../services/cc_status';
import { refreshActiveWorkSummaries } from '../services/work_summary';

interface CliOpts {
  only?: Set<string>;
  skip?: Set<string>;
  ccUsers?: string[];
  lookback?: number;
}

function parseArgs(argv: string[]): CliOpts {
  const out: CliOpts = {};
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      out.only = new Set(arg.slice('--only='.length).split(','));
    } else if (arg.startsWith('--skip=')) {
      out.skip = new Set(arg.slice('--skip='.length).split(','));
    } else if (arg.startsWith('--user=')) {
      out.ccUsers = arg.slice('--user='.length).split(',');
    } else if (arg.startsWith('--lookback=')) {
      out.lookback = Number.parseInt(arg.slice('--lookback='.length), 10);
    }
  }
  return out;
}

function should(name: string, opts: CliOpts): boolean {
  if (opts.only && !opts.only.has(name)) return false;
  if (opts.skip && opts.skip.has(name)) return false;
  return true;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const totals: Record<string, unknown> = {};

  if (should('cc', opts)) {
    const r = await syncCcSessions({ limitUsers: opts.ccUsers, lookbackDays: opts.lookback ?? 14 });
    totals.cc = r;
  }
  if (should('github', opts)) {
    try {
      totals.github = await syncGithub();
    } catch (err) {
      totals.github = { error: (err as Error).message };
    }
  }
  if (should('slack', opts)) {
    try {
      totals.slack = await syncSlack();
    } catch (err) {
      totals.slack = { error: (err as Error).message };
    }
  }
  if (should('meeting', opts)) {
    try {
      totals.meeting = await syncMeetings();
    } catch (err) {
      totals.meeting = { error: (err as Error).message };
    }
  }
  if (should('anomaly', opts)) {
    totals.anomaly = await evaluateAll();
  }
  // Warm the "在做什么" summaries for whoever's active/idle so the /status
  // roster shows fresh hints without paying for an LLM call on each poll.
  if (should('summaries', opts)) {
    try {
      const status = await getAllStatus({ onlyWithActivity: true });
      const names = status.filter((s) => s.activityFlag === 'active' || s.activityFlag === 'idle').map((s) => s.name);
      totals.summaries = await refreshActiveWorkSummaries(names);
    } catch (err) {
      totals.summaries = { error: (err as Error).message };
    }
  }

  console.log(JSON.stringify({ tookMs: Date.now() - started, ...totals }, null, 2));
}

void main();
