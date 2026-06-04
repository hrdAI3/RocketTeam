'use client';

// /evaluation — Two things on one page:
//
//   1. "This week" auto-dashboard — per-active-member row with the proxy
//      metrics we can compute today (PRs, commits, median PR close time,
//      last CC activity, silent working days, untracked work). Status pill
//      derived from the gates in the standard doc below.
//
//   2. The standard itself — TL;DR, three dimensions (exploration / closed-
//      loop / judgment), cadence, new-hire buffer, escalation gates, and
//      retired metrics. English translation of the Chinese source standard.
//
// The dashboard sits ABOVE the standard so the leader's eye lands on signal
// first; scroll to read the philosophy.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { Avatar } from '../../components/Avatar';

type EvalStatus = 'green' | 'yellow' | 'orange' | 'red';
type BuilderUnit = 'solo' | 'pair' | 'pod';

interface EvalRow {
  name: string;
  prsThisWeek: number;
  commitsThisWeek: number;
  medianPrCloseHours: number | null;
  lastActivityIso: string | null;
  silentWorkdays: number;
  untrackedCount: number;
  status: EvalStatus;
  cc14d: number[];
  unit: BuilderUnit;
}

interface EvalPayload {
  rows: EvalRow[];
  notes: { hasCommitEvents: boolean; hasUnitMetadata: boolean };
}

// Per-dimension health, derived client-side from the row's proxies. We can't
// compute the missing fields (hypothesis log / dropped / user feedback) yet,
// so each dimension's dot is a "what we CAN see" reading, not a final grade.
// Mapping logic — kept close to the standard doc gates:
//   I  · Exploration  : did they ship anything this week? PRs is our proxy.
//                       0 PR + ≥2 silent workdays = yellow; 0 PR + ≥5 = orange.
//   II · Closed-loop  : are loops fast? median PR close <48h = green; 48-96h
//                       yellow; >96h orange; no closed PR + ≥5 silent = orange.
//   III · Judgement   : we have no hypothesis-log signal yet, so this dot is
//                       neutral (gray) until wired. Don't fake it.
type DimHealth = 'green' | 'yellow' | 'orange' | 'red' | 'neutral';

function dimExploration(row: EvalRow): DimHealth {
  if (row.silentWorkdays >= 10) return 'red';
  if (row.prsThisWeek === 0 && row.silentWorkdays >= 5) return 'orange';
  if (row.prsThisWeek === 0 && row.silentWorkdays >= 2) return 'yellow';
  if (row.prsThisWeek === 0) return 'yellow';
  return 'green';
}

function dimClosedLoop(row: EvalRow): DimHealth {
  if (row.medianPrCloseHours === null) {
    // No closed PRs in 14d AND silent for ≥5 workdays → closed-loop is broken.
    if (row.silentWorkdays >= 5) return 'orange';
    return 'neutral';
  }
  if (row.medianPrCloseHours <= 48) return 'green';
  if (row.medianPrCloseHours <= 96) return 'yellow';
  return 'orange';
}

function dimJudgement(_row: EvalRow): DimHealth {
  // Hypothesis log / drop count not wired yet — show neutral until source
  // (Notion) is connected. Faking this would be worse than admitting the gap.
  return 'neutral';
}

const STATUS_LABEL: Record<EvalStatus, string> = {
  green: 'Green',
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red'
};

const STATUS_PILL: Record<EvalStatus, string> = {
  green: 'bg-forest/15 text-forest',
  yellow: 'bg-amber/15 text-amber',
  orange: 'bg-rust/15 text-rust border border-rust/30',
  red: 'bg-rust text-white'
};

const DIM_DOT: Record<DimHealth, string> = {
  green: 'bg-forest',
  yellow: 'bg-amber',
  orange: 'bg-rust',
  red: 'bg-rust',
  neutral: 'bg-ink-ghost'
};

type SortKey = 'status' | 'exploration' | 'closedLoop' | 'silent' | 'name';

// Sort weight for dim health when used as a sort key: worst first.
const DIM_WEIGHT: Record<DimHealth, number> = {
  red: 0,
  orange: 1,
  yellow: 2,
  neutral: 3,
  green: 4
};

const STATUS_WEIGHT: Record<EvalStatus, number> = {
  red: 0,
  orange: 1,
  yellow: 2,
  green: 3
};

function ageStr(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const min = (Date.now() - ms) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 60 / 24)}d ago`;
}

function hoursStr(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default function EvaluationPage() {
  const [data, setData] = useState<EvalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('status');
  // Standard doc collapsed by default — dashboard is the hero. Leader can
  // expand for the reference text.
  const [standardOpen, setStandardOpen] = useState(false);

  useEffect(() => {
    document.title = 'Evaluation · Rocket Team';
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/evaluation', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setData((await res.json()) as EvalPayload);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sort applied client-side so toggling doesn't re-fetch. Worst-first for
  // every key except name (alphabetical).
  const sortedRows = useMemo(() => {
    if (!data) return [] as EvalRow[];
    const rows = [...data.rows];
    rows.sort((a, b) => {
      switch (sortKey) {
        case 'exploration':
          return DIM_WEIGHT[dimExploration(a)] - DIM_WEIGHT[dimExploration(b)]
            || b.silentWorkdays - a.silentWorkdays;
        case 'closedLoop':
          return DIM_WEIGHT[dimClosedLoop(a)] - DIM_WEIGHT[dimClosedLoop(b)]
            || (a.medianPrCloseHours ?? Infinity) - (b.medianPrCloseHours ?? Infinity);
        case 'silent':
          return b.silentWorkdays - a.silentWorkdays;
        case 'name':
          return a.name.localeCompare(b.name);
        case 'status':
        default:
          return STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status]
            || b.silentWorkdays - a.silentWorkdays;
      }
    });
    return rows;
  }, [data, sortKey]);

  return (
    <div className="px-12 py-10 max-w-[1080px] mx-auto">
      {/* Header */}
      <header className="flex items-end justify-between gap-4 mb-8 pb-5 border-b border-rule-soft">
        <div>
          <div className="eyebrow mb-2">Rocket Team / Evaluation</div>
          <h1 className="display-title">AI-Native Builder Evaluation</h1>
        </div>
        <button
          onClick={refresh}
          aria-label="Refresh"
          className="p-2 rounded-md text-ink-quiet hover:text-ink hover:bg-paper-subtle transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {/* AUTO-DASHBOARD — proxy metrics, this week */}
      <section className="mb-12">
        <div className="flex items-baseline justify-between mb-3 gap-4 flex-wrap">
          <h2 className="font-serif text-[22px] text-ink tracking-[-0.015em]">This week</h2>
          <div className="flex items-center gap-3 text-[11px] text-ink-quiet">
            {data && (
              <span>{`${data.rows.length} active member${data.rows.length === 1 ? '' : 's'}`}</span>
            )}
            <label className="flex items-center gap-1.5">
              <span>Sort</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="bg-paper-subtle border border-rule rounded px-1.5 py-1 text-[11px] text-ink-soft font-mono focus:outline-none focus:border-coral"
              >
                <option value="status">Worst status</option>
                <option value="exploration">Worst I · Exploration</option>
                <option value="closedLoop">Worst II · Closed-loop</option>
                <option value="silent">Most silent days</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
        </div>
        <p className="text-[12.5px] text-ink-muted mb-3 leading-relaxed max-w-[760px]">
          What we can see today: PR throughput, PR close latency, CC session rhythm
          (14d), silent working days. What we can&apos;t yet: hypothesis log, dropped
          hypotheses, real user feedback, help-ask trend — those live in Notion /
          Linear and need wiring. The three small dots per row are dimension health;
          the pill on the right is the escalation-gate status (2d yellow / 5d orange
          / 10d red).
        </p>

        {/* Single consolidated CTA row replaces 4 dead "—" tiles. */}
        <div className="rounded-lg border border-rule-soft bg-paper-subtle/40 px-3 py-2 mb-4 text-[11.5px] text-ink-quiet flex items-center gap-2 flex-wrap">
          <span className="text-coral font-mono uppercase tracking-wide text-[10px]">Wire next</span>
          <span>Hypothesis log · Dropped hypotheses · Real user feedback · Help-ask trend</span>
          <span className="text-ink-ghost">— source: Notion / Linear, not yet connected.</span>
        </div>

        {error && (
          <div className="rounded-xl border border-rust bg-paper-card p-4 mb-4 text-body text-ink">
            {error}{' '}
            <button onClick={refresh} className="ml-3 link-coral">
              Retry
            </button>
          </div>
        )}

        {data && !data.notes.hasCommitEvents && (
          <div className="rounded-xl border border-amber/40 bg-amber/[0.07] px-4 py-3 mb-4 text-[12px] text-ink-soft flex items-start gap-2.5">
            <span className="text-amber shrink-0 mt-px">⚠</span>
            <span className="leading-relaxed">
              Commit-level events aren&apos;t in our ingest stream yet — PR count is
              the only ship-throughput proxy until the extractor adds them.
            </span>
          </div>
        )}

        {loading && !data && (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-[78px] rounded-xl border border-rule bg-paper-subtle animate-pulse" />
            ))}
          </div>
        )}

        {data && data.rows.length === 0 && (
          <div className="rounded-xl border border-rule bg-paper-card px-5 py-8 text-center text-[13px] text-ink-quiet">
            No active members with attribution handles.
          </div>
        )}

        {data && sortedRows.length > 0 && (
          <div className="grid grid-cols-1 gap-2">
            {sortedRows.map((row) => (
              <MemberRow key={row.name} row={row} />
            ))}
          </div>
        )}
      </section>

      {/* Standard reference — collapsed by default so the dashboard is hero. */}
      <section className="mb-10 border-t border-rule-soft pt-6">
        <button
          type="button"
          onClick={() => setStandardOpen((v) => !v)}
          className="flex items-center gap-2 text-ink-soft hover:text-ink transition-colors group"
          aria-expanded={standardOpen}
        >
          {standardOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="font-serif text-[20px] tracking-[-0.015em]">Standard reference</span>
          <span className="text-[11px] text-ink-quiet group-hover:text-ink-soft">
            TL;DR · three dimensions · cadence · new-hire buffer · gates · retired metrics
          </span>
        </button>
      </section>

      {standardOpen && (
      <>
      {/* STANDARD — TL;DR */}

      {/* STANDARD — TL;DR */}
      <section className="mb-10">
        <div className="rounded-xl border-2 border-ink bg-paper-card px-6 py-5">
          <div className="eyebrow text-coral mb-2">TL;DR</div>
          <p className="text-[14.5px] leading-[1.7] text-ink">
            Reality baseline: with Agent assist, most builders hit 60-70 on most
            dimensions; a few people hit 90+ on one or two dimensions —
            <strong> that&apos;s the expert seat</strong>. A product that&apos;s 90+ across
            the board is the result of multiple Builder units combining; after MVP,
            collaboration returns to the core. Three dimensions: exploration
            progress; closed-loop efficiency (solo / pair / 3-person pod, 2-3 days
            to think-through→build→ship→feedback, fill gaps with Agent + pairing +
            ad-hoc help); and judgment (highest weight in exploration phase).
            Decreasing reliance on outside help week over week is a strong positive
            signal. Cadence: daily dashboard / weekly hypothesis log / monthly
            convergence check / quarterly direction calibration. Gates: 2-day yellow,
            1-week orange (change direction), 2-week red (exit).
          </p>
        </div>
      </section>

      {/* STANDARD — Three dimensions */}
      <section className="mb-10">
        <h2 className="font-serif text-[22px] text-ink mb-1 tracking-[-0.015em]">
          Three dimensions (exploration phase)
        </h2>
        <p className="text-[13.5px] text-ink-muted mb-5 leading-relaxed">
          There&apos;s no product yet — we&apos;re still hunting PMF — so retention,
          conversion, and revenue don&apos;t apply. What we look at is the
          exploration motion itself: hypotheses, interviews, experiments,
          drops.
        </p>

        <div className="space-y-4">
          <DimensionCard
            rank="I"
            name="Exploration progress"
            tags={[{ label: 'Lag indicator', tone: 'lag' }]}
            summary="Can you keep finding directions worth pursuing? Specifically: how many hypotheses you thought through and shipped this week, how much real user feedback you collected, how many hypotheses you dropped (this is a good thing), and how many fresh insights accumulated."
            fields={[
              { dt: 'How we look at it', dd: 'Monthly: are we converging toward PMF — insights narrowing, dropped directions piling up, remaining candidates getting more specific?' },
              { dt: 'Dashboard fields', dd: 'New hypotheses this week, experiments shipped this week (each ≤ 2-3 days, solo / pair / pod), real user-feedback items, dropped hypotheses, new insights.' },
              { dt: 'Key insight', dd: 'A week without dropping anything = you\'re not actually exploring, you\'re lying to yourself. Decisive drops ≠ no output — they tighten the search.' },
              { dt: 'Edge case', dd: 'Some hypotheses need longer to validate. Pre-sign an exemption: "this hypothesis won\'t trigger drop-pressure for the next X weeks; we substitute [signal A] + [signal B]." Log it in Notion / Linear.' }
            ]}
          />

          <DimensionCard
            rank="II"
            name="Closed-loop efficiency"
            tags={[{ label: 'Lead indicator', tone: 'lead' }]}
            summary="From thinking a hypothesis through, to building, to shipping it to real users, getting feedback, deciding continue or drop — a Builder unit (solo / pair / 3-person pod) must complete one loop within 2-3 days. Builder ≠ does everything alone — end-to-end accountability is on you, but you fill gaps with Agent + pairing + ad-hoc help. Not patching gaps is the problem; having gaps is not."
            fields={[
              { dt: 'Builder unit', dd: 'Solo / pair (2, complementary) / pod (3, eng + product + ops). Past 3 it degrades into a traditional team — don\'t breach that.' },
              { dt: 'A loop counts when', dd: 'Hypothesis thought through → built → code actually shipped → real user used it → feedback received → continue/drop decided. Missing one means it doesn\'t count. "Shipped" is hard: local demo / internal preview do not qualify. Any unit member triggering it counts, but everyone must contribute ship in their strong dimension — no free riding.' },
              { dt: 'How we look at it', dd: 'Loops per week per unit, cost trend per loop, did each member use Agent / actively pair / seek ad-hoc help. Is help-reliance decreasing week over week? Identify the expert seat: which 1-2 dimensions is this Builder hitting 90+ on? That output must be visible and protected.' },
              { dt: 'Edge case', dd: 'Can\'t close in 3 days = hypothesis cut too large (split it) or gap-patching strategy is wrong (swap Agent / add a pair). Don\'t over-engineer — a week building a framework you use once costs more than the time it saves.' }
            ]}
          />

          <DimensionCard
            rank="III"
            name="Judgment"
            tags={[
              { label: 'Lead indicator', tone: 'lead' },
              { label: 'Lag indicator', tone: 'lag' }
            ]}
            summary="Picking the right thing to explore and cutting the wrong ones. There's no PM to call shots. In the exploration phase this dimension carries the highest weight — no data backstop, everything rides on direction-sense and iteration speed."
            fields={[
              { dt: 'How we look at it', dd: 'Weekly hypothesis log: this week\'s new hypotheses, what got dropped, why. Monthly retrospective: are the remaining directions more specific and closer to real demand?' },
              { dt: 'Hypothesis-log template', dd: 'Date | I thought (hypothesis) | Turned out to be (validation / interview feedback) | Next (continue / pivot / drop) | Why. One line per entry, public Notion / Linear page, visible to you and peers.' },
              { dt: 'Edge case', dd: 'In exploration, swapping direction daily is normal — don\'t punish "wrong picks." The criterion is: can the rationale for a drop teach the team something, or are you just thrashing?' }
            ]}
          />
        </div>
      </section>

      {/* STANDARD — Cadence */}
      <section className="mb-10">
        <h2 className="font-serif text-[22px] text-ink mb-3 tracking-[-0.015em]">Cadence</h2>
        <div className="overflow-hidden rounded-xl border border-rule bg-paper-card">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="bg-paper-subtle border-b-2 border-ink">
                <th className="text-left px-4 py-2.5 font-semibold text-ink w-[120px]">Cadence</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink w-[36%]">What to watch</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink">How</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 font-semibold text-ink">Daily</td>
                <td className="px-4 py-3 text-ink-soft">New hypotheses, experiments shipped, user feedback, drops, cost curve.</td>
                <td className="px-4 py-3 text-ink-soft">Auto dashboard. Anomalies auto-alert.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 font-semibold text-ink">Weekly</td>
                <td className="px-4 py-3 text-ink-soft">Hypothesis-log accumulation.</td>
                <td className="px-4 py-3 text-ink-soft">Builders write this week&apos;s hypotheses, drops, and insights into the log. By Friday each peer leaves a one-line reaction (agree / disagree / unclear). No meeting.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 font-semibold text-ink">Monthly</td>
                <td className="px-4 py-3 text-ink-soft">Insight accumulation + direction convergence.</td>
                <td className="px-4 py-3 text-ink-soft">Are candidate directions narrowing? Drop pile thickening? Closer to PMF signal?</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-semibold text-ink">Quarterly</td>
                <td className="px-4 py-3 text-ink-soft">Strategic direction.</td>
                <td className="px-4 py-3 text-ink-soft">Direction calibration — not a performance review.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[12.5px] text-ink-quiet mt-3 leading-relaxed">
          Process metrics fully automated, evaluation fully async. No Scrum ceremonies
          (no standups / sprints / retros / weekly reports).
        </p>
      </section>

      {/* STANDARD — New-hire buffer */}
      <section className="mb-10">
        <h2 className="font-serif text-[22px] text-ink mb-3 tracking-[-0.015em]">
          2-day buffer for new joiners
        </h2>
        <div className="rounded-xl border border-rule bg-paper-card px-5 py-4">
          <p className="text-[13.5px] text-ink-soft leading-relaxed mb-2.5">
            New joiners with no AI-Native experience get a 2-day grace window — no
            escalation gates trigger during those two days. They spend the time on
            two things:
          </p>
          <ul className="list-disc pl-5 text-[13.5px] text-ink-soft space-y-1 mb-3">
            <li><strong className="text-ink">Observe the system</strong> — dashboard, loop cadence, hypothesis log, escalation gates, peer-review style.</li>
            <li><strong className="text-ink">Decide at end of day 2</strong> — accept this evaluation system or not.</li>
          </ul>
          <p className="text-[13.5px] text-ink-soft leading-relaxed">
            Accept → from day 3 onward, the 2-day / 1-week / 2-week clocks start.
            Decline → part ways amicably the same day, no record kept.
          </p>
          <p className="text-[12.5px] text-ink-quiet leading-relaxed mt-3">
            We give the decision to the new joiner — not a one-sided probation. AI-Native
            evaluation asks a lot (2-day loop, high pace, self-direction, end-to-end). Two
            no-pressure days to see clearly beats both sides regretting it later.
          </p>
        </div>
      </section>

      {/* STANDARD — Escalation gates */}
      <section className="mb-10">
        <h2 className="font-serif text-[22px] text-ink mb-3 tracking-[-0.015em]">
          Escalation gates
        </h2>
        <p className="text-[13.5px] text-ink-muted mb-3 leading-relaxed">
          Two tests: (1) Can the Builder unit still close loops? (2) Are known gaps
          being patched? (Agent isn&apos;t enough today — pair up or ask for help; doing
          none of those three counts as &quot;not patched&quot;.) No stack ranking, no
          KPI-based rankings. Three gates: 2 days / 1 week / 2 weeks (new joiners
          start counting from day 3).
        </p>
        <div className="overflow-hidden rounded-xl border border-rule bg-paper-card">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="bg-paper-subtle border-b-2 border-ink">
                <th className="text-left px-4 py-2.5 font-semibold text-ink w-[120px]">Gate</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink w-[38%]">Trigger</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink">Response</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 align-top">
                  <span className="inline-block px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wide bg-amber/15 text-amber font-semibold">2 days · Yellow</span>
                </td>
                <td className="px-4 py-3 text-ink-soft">2-3 consecutive days of fully-quiet dashboard (no shipped hypothesis / no new user feedback / no entries in the hypothesis log), OR visible gaps left unpatched (no Agent / no pairing / no ad-hoc help).</td>
                <td className="px-4 py-3 text-ink-soft">30-min 1:1 with three questions: (1) Where are you stuck? (2) What do you need to unblock? (3) Time to change direction? Not a formal warning.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 align-top">
                  <span className="inline-block px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wide bg-rust/15 text-rust border border-rust/30 font-semibold">1 week · Orange</span>
                </td>
                <td className="px-4 py-3 text-ink-soft">After the talk, another 5 days with no motion — or a key business metric trending the wrong way.</td>
                <td className="px-4 py-3 text-ink-soft">Change exploration direction or switch roles. Make clear this is the last try.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top">
                  <span className="inline-block px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wide bg-rust text-white font-semibold">2 weeks · Red</span>
                </td>
                <td className="px-4 py-3 text-ink-soft">New direction still hasn&apos;t moved after 5 days.</td>
                <td className="px-4 py-3 text-ink-soft">Exit. They can pick &quot;try one more&quot; or leave, but the org no longer arranges placements.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul className="list-disc pl-5 text-[13px] text-ink-soft space-y-1.5 mt-4 leading-relaxed">
          <li><strong className="text-ink">Big-bet exemption</strong> — agree up front what signal substitutes during the exemption window; the gates don&apos;t fire. Without this, a big bet gets strangled on day one.</li>
          <li><strong className="text-ink">See it yourself first</strong> — Builders should spot their own yellow light before the org does. &quot;I&apos;m stuck / want to pivot&quot; spoken voluntarily is more dignified than passively hitting red.</li>
          <li><strong className="text-ink">Exiting isn&apos;t shameful</strong> — the Builder role is demanding (end-to-end + fast cadence + self-direction). Not fitting the role is normal, not a personal failure.</li>
          <li><strong className="text-ink">No quota-based cuts</strong> — &quot;cut bottom 10% each quarter&quot; pushes Builders from collaboration to competition and kills dimension II. Cuts are absolute (&quot;can you close loops?&quot;), not relative.</li>
        </ul>
      </section>

      {/* STANDARD — Retired metrics */}
      <section className="mb-12">
        <h2 className="font-serif text-[22px] text-ink mb-3 tracking-[-0.015em]">
          Retired / downgraded metrics
        </h2>
        <div className="overflow-hidden rounded-xl border border-rule bg-paper-card">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="bg-paper-subtle border-b-2 border-ink">
                <th className="text-left px-4 py-2.5 font-semibold text-ink w-[40%]">Old metric</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink w-[24%]">Status</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink">Reason</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 text-ink-quiet"><strong>LOC</strong> / Commits / <strong>PR count</strong></td>
                <td className="px-4 py-3 text-ink-soft">Aux signal</td>
                <td className="px-4 py-3 text-ink-soft">Zero PRs is still a &quot;no output&quot; signal — but not a primary metric.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 text-ink-quiet">Hours worked</td>
                <td className="px-4 py-3 text-ink-soft">Retired</td>
                <td className="px-4 py-3 text-ink-soft">Rewarding hours = punishing leverage.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 text-ink-quiet">Meeting load / comms volume</td>
                <td className="px-4 py-3 text-ink-soft">Anti-signal</td>
                <td className="px-4 py-3 text-ink-soft">High comms volume = the system isn&apos;t automated enough.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 text-ink-quiet">Story points</td>
                <td className="px-4 py-3 text-ink-soft">Onboarding only</td>
                <td className="px-4 py-3 text-ink-soft">First two months of a new Builder — not after.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 text-ink-quiet">Job levels (Senior / Staff / Principal)</td>
                <td className="px-4 py-3 text-ink-soft">Retired</td>
                <td className="px-4 py-3 text-ink-soft">Couples management radius and tech depth, divorced from business results.</td>
              </tr>
              <tr className="border-b border-rule-soft">
                <td className="px-4 py-3 text-ink-quiet">Reports-to count</td>
                <td className="px-4 py-3 text-ink-soft">Retired</td>
                <td className="px-4 py-3 text-ink-soft">Builders work with Agents, not direct reports.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-ink-quiet"><strong>KPI</strong> completion</td>
                <td className="px-4 py-3 text-ink-soft">Replaced</td>
                <td className="px-4 py-3 text-ink-soft">Bind directly to business outcomes — no intermediate process layer.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      </>
      )}
    </div>
  );
}

// ─── Components ────────────────────────────────────────────────────────────

function MemberRow({ row }: { row: EvalRow }) {
  // Row layout is now a name+unit column, three dimension blocks each with a
  // health dot + a tight set of REAL tiles (no "—" placeholders), an inline
  // 14d CC sparkline, and the overall escalation-gate pill on the right.
  //
  // What changed from the prior version:
  //   - Per-dimension health dots replace the single overall pill collapse.
  //     Leader can spot "fine on Exploration, broken on Closed-loop" at a
  //     glance.
  //   - Dropped the 4 "—" tiles (Dropped hypotheses / Help-ask trend /
  //     Hypothesis log / User feedback). One consolidated CTA up top names
  //     the gap honestly instead of wallpapering it with em-dashes.
  //   - "Active directions = untrackedCount" was wrong — untrackedCount is
  //     stuff falling through workboard hygiene, not exploration. Demoted
  //     to a small badge ("untracked: N") attached to Exploration, with
  //     tooltip explaining what it really measures.
  //   - Silent workdays now shows distance to the next escalation gate
  //     (e.g. "1 · next gate 2d") so a 1 reads as "headroom" not "alarm".
  const expl = dimExploration(row);
  const cl = dimClosedLoop(row);
  const jd = dimJudgement(row);

  return (
    <div className="rounded-xl border border-rule bg-paper-card px-4 py-3 flex items-stretch gap-3">
      {/* Identity + unit */}
      <div className="flex items-center gap-2.5 w-[140px] shrink-0">
        <Avatar name={row.name} size="sm" />
        <div className="min-w-0">
          <div className="font-serif text-[14px] text-ink truncate leading-tight">{row.name}</div>
          <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-quiet font-mono mt-0.5">
            {row.unit}
          </div>
        </div>
      </div>

      {/* Three dimension blocks */}
      <div className="grid grid-cols-3 gap-2 flex-1 min-w-0">
        <DimensionBlock rank="I" name="Exploration" tone="lag" health={expl}>
          <Tile label="Shipped PRs / wk" value={String(row.prsThisWeek)} emphasis={row.prsThisWeek === 0} />
          <Tile
            label="WB untracked"
            value={String(row.untrackedCount)}
            tooltip="Untracked workboard items owned by this member. Hygiene signal, not a count of active directions."
            muted
          />
        </DimensionBlock>

        <DimensionBlock rank="II" name="Closed-loop" tone="lead" health={cl}>
          <Tile label="Median PR close" value={hoursStr(row.medianPrCloseHours)} />
          <Tile label="Last CC" value={ageStr(row.lastActivityIso)} />
        </DimensionBlock>

        <DimensionBlock rank="III" name="Judgement" tone="lead" health={jd}>
          <Tile
            label={`Silent wd · gates 2/5/10`}
            value={row.silentWorkdays >= 30 ? '30+' : String(row.silentWorkdays)}
            emphasis={row.silentWorkdays >= 2}
            tooltip="Silent working days. Yellow at 2, orange at 5, red at 10."
          />
          <Tile label="Hypothesis log" value="wire Notion" muted small />
        </DimensionBlock>
      </div>

      {/* 14d CC sparkline */}
      <div className="hidden md:flex flex-col items-center justify-center w-[88px] shrink-0">
        <Sparkline values={row.cc14d} />
        <span className="text-[9px] uppercase tracking-wide text-ink-quiet font-mono mt-1">cc · 14d</span>
      </div>

      {/* Escalation-gate pill */}
      <span
        className={`self-start text-[11px] uppercase tracking-wide px-2 py-1 rounded font-mono shrink-0 ${STATUS_PILL[row.status]}`}
        title="Overall escalation-gate status: 2d yellow / 5d orange / 10d red"
      >
        {STATUS_LABEL[row.status]}
      </span>
    </div>
  );
}

function DimensionBlock({
  rank,
  name,
  tone,
  health,
  children
}: {
  rank: string;
  name: string;
  tone: 'lead' | 'lag';
  health: DimHealth;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-paper-subtle/60 px-2.5 py-2 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-1.5">
        {/* Per-dimension health dot — neutral=gray = "we can't measure yet" */}
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${DIM_DOT[health]}`}
          title={`${name} health: ${health}`}
          aria-label={`${name} health: ${health}`}
        />
        <span className="text-[9px] uppercase tracking-[0.08em] text-coral font-mono font-semibold">
          {rank}
        </span>
        <span className="text-[10.5px] uppercase tracking-wide text-ink-soft font-mono font-medium truncate">
          {name}
        </span>
        <span
          className={`ml-auto text-[8.5px] uppercase tracking-wide px-1.5 py-px rounded font-mono ${
            tone === 'lead' ? 'bg-coral-subtle text-coral-deep' : 'bg-paper-deep text-ink-quiet'
          }`}
        >
          {tone}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function Tile({
  label,
  value,
  emphasis = false,
  muted = false,
  small = false,
  tooltip
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  muted?: boolean;
  small?: boolean;
  tooltip?: string;
}) {
  return (
    <div className="flex flex-col min-w-0" title={tooltip ?? label}>
      <span
        className={`text-[8.5px] uppercase tracking-[0.06em] font-mono leading-tight truncate ${
          muted ? 'text-ink-ghost' : 'text-ink-quiet'
        }`}
      >
        {label}
      </span>
      <span
        className={`font-serif tabular-nums leading-snug truncate ${
          small ? 'text-[11px]' : 'text-[14px]'
        } ${
          emphasis ? 'text-rust font-semibold' : muted ? 'text-ink-ghost' : 'text-ink'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// Inline SVG sparkline — no chart lib, no deps. Bars represent daily CC
// event count over the last 14d (oldest left, today right). All-zero shows
// as a flat row of ghost ticks so a dormant member doesn't render blank.
function Sparkline({ values }: { values: number[] }) {
  const w = 84;
  const h = 22;
  const n = values.length || 14;
  const max = Math.max(1, ...values);
  const barW = w / n - 1;
  return (
    <svg width={w} height={h} role="img" aria-label="14-day CC activity">
      {values.map((v, i) => {
        const x = i * (w / n);
        const barH = v === 0 ? 1 : Math.max(1, (v / max) * (h - 2));
        const y = h - barH;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={barH}
            className={v === 0 ? 'fill-ink-ghost/40' : 'fill-coral/70'}
          >
            <title>{`day -${n - 1 - i}: ${v}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

type DimensionTagTone = 'lead' | 'lag';
function DimensionCard({
  rank,
  name,
  tags,
  summary,
  fields
}: {
  rank: string;
  name: string;
  tags: Array<{ label: string; tone: DimensionTagTone }>;
  summary: string;
  fields: Array<{ dt: string; dd: string }>;
}) {
  return (
    <article className="rounded-xl border border-rule bg-paper-card border-l-4 border-l-coral px-5 py-4">
      <div className="flex items-center flex-wrap gap-2 mb-2">
        <span className="eyebrow text-coral">{rank}. {name}</span>
        {tags.map((t) => (
          <span
            key={t.label}
            className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full font-mono ${
              t.tone === 'lead' ? 'bg-coral-subtle text-coral-deep' : 'bg-paper-subtle text-ink-quiet'
            }`}
          >
            {t.label}
          </span>
        ))}
      </div>
      <p className="text-[14px] text-ink leading-[1.65] mb-3">{summary}</p>
      <dl className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-2 text-[13px]">
        {fields.map((f) => (
          <FieldRow key={f.dt} dt={f.dt} dd={f.dd} />
        ))}
      </dl>
    </article>
  );
}

function FieldRow({ dt, dd }: { dt: string; dd: string }) {
  return (
    <>
      <dt className="font-semibold text-ink-soft">{dt}</dt>
      <dd className="text-ink-soft leading-relaxed">{dd}</dd>
    </>
  );
}
