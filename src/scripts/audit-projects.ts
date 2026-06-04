#!/usr/bin/env bun
// §0.6 audit gates — combines gate A (S1 resolver) + gate B (S2 attribution).
//
// Gate A — runs extract+resolve twice and checks:
//   id_stability                  : run-1 ids that survived run 2 (≥ 100%)
//   extraction_evidence_coverage  : proposals with ≥1 evidence_ref (≥ 100%)
//
// Gate B — reads work_summary cache and computes:
//   attributed_rate              : fraction of WorkItems with non-unclear projectId (≥ 70%)
//   attribution_evidence_coverage: of those, fraction with attribution_evidence (≥ 100%)
//
// Usage:
//   bun run audit:projects                  # both gates
//   bun run audit:projects --only=A
//   bun run audit:projects --only=B
// Exits 0 on pass, 1 on any gate failure.

import { runProjectSync } from '../services/project_sync';
import { readProjects } from '../lib/projects';
import { readCachedSummaries, type WorkItem } from '../services/work_summary';

interface Args {
  windowDays?: number;
  only?: 'A' | 'B';
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const a of argv) {
    if (a.startsWith('--window=')) out.windowDays = Number.parseInt(a.slice('--window='.length), 10);
    if (a === '--only=A' || a === '--only=a') out.only = 'A';
    if (a === '--only=B' || a === '--only=b') out.only = 'B';
  }
  return out;
}

async function runGateA(windowDays: number): Promise<{ pass: boolean; report: string[] }> {
  const report: string[] = ['=== Gate A — extraction + resolver ==='];
  report.push(`window=${windowDays}d · run 1 …`);
  const r1 = await runProjectSync({ windowDays });
  report.push(`  proposals=${r1.proposals.length} outcomes=${r1.outcomes.length} errors=${r1.errors.length}`);
  if (r1.errors.length > 0) report.push(`  errors: ${JSON.stringify(r1.errors)}`);
  const after1 = await readProjects();
  const ids1 = new Set(after1.projects.map((p) => p.id));

  report.push(`run 2 …`);
  const r2 = await runProjectSync({ windowDays });
  report.push(`  proposals=${r2.proposals.length} outcomes=${r2.outcomes.length} errors=${r2.errors.length}`);
  if (r2.errors.length > 0) report.push(`  errors: ${JSON.stringify(r2.errors)}`);
  const after2 = await readProjects();
  const ids2 = new Set(after2.projects.map((p) => p.id));

  let stable = 0;
  const drifted: string[] = [];
  for (const id of ids1) {
    if (ids2.has(id)) stable++;
    else drifted.push(id);
  }
  const idStability = ids1.size === 0 ? 1 : stable / ids1.size;

  const allProposals = [...r1.proposals, ...r2.proposals];
  const withEvidence = allProposals.filter((p) => p.evidence_refs.length > 0).length;
  const evidenceCoverage = allProposals.length === 0 ? 1 : withEvidence / allProposals.length;

  const mintsInRun2 = r2.outcomes.filter((o) => o.action === 'mint').length;
  const newSinceRun1 = [...ids2].filter((id) => !ids1.has(id)).length;

  // Defensive mints — proposals where the semantic-merge LLM call failed,
  // so the resolver fell through to mint. Audit must NOT credit these as
  // legitimate id_stability: an LLM-down day can fragment the registry and
  // still report 100% stability across two runs (both runs hit the same fallthrough).
  const defensiveMints = [...r1.outcomes, ...r2.outcomes].filter((o) => o.llmMergeUnreachable).length;
  const llmMergeFailures = r1.llmMergeFailures + r2.llmMergeFailures;

  report.push('');
  report.push(`registry              : ${ids1.size} → ${ids2.size}`);
  report.push(`id_stability          : ${(idStability * 100).toFixed(1)}% (${stable}/${ids1.size})`);
  if (drifted.length > 0) {
    report.push(`  ⚠ disappeared ids: ${drifted.slice(0, 5).join(', ')}`);
  }
  report.push(
    `evidence_coverage     : ${(evidenceCoverage * 100).toFixed(1)}% (${withEvidence}/${allProposals.length})`
  );
  report.push(`run-2 mints           : ${mintsInRun2}`);
  report.push(`new ids since run 1   : ${newSinceRun1}`);
  report.push(`llm_merge_failures    : ${llmMergeFailures} (defensive mints: ${defensiveMints})`);

  const pass =
    idStability >= 0.999 && evidenceCoverage >= 0.999 && defensiveMints === 0;
  report.push('');
  report.push(`Gate A: ${pass ? '✓ PASS' : '✗ FAIL'}`);
  if (!pass) {
    if (idStability < 0.999) {
      report.push(`  ✗ id_stability < 100% — resolver dropped/renamed existing ids.`);
      report.push(`    suspects: ${drifted.slice(0, 10).join(', ')}`);
    }
    if (evidenceCoverage < 0.999) {
      report.push(`  ✗ extraction_evidence_coverage < 100% — parser is letting proposals`);
      report.push(`    through without evidence_refs (regression in §0.5 discipline 2).`);
    }
    if (defensiveMints > 0) {
      report.push(`  ✗ ${defensiveMints} defensive mint(s) — LLM merge endpoint failed during`);
      report.push(`    this run, so any proposal that needed semantic merging fragmented`);
      report.push(`    into a fresh id. Re-run when LLM is healthy.`);
    }
  }
  return { pass, report };
}

async function runGateB(): Promise<{ pass: boolean; report: string[] }> {
  const report: string[] = ['=== Gate B — work_summary attribution ==='];
  const summaries = await readCachedSummaries();
  let total = 0;
  let attributed = 0;
  let evidenceOk = 0;
  let evidenceMissingButAttributed = 0;
  const ruleSamples: Array<{ name: string; title: string; pid: string }> = [];
  for (const [name, summ] of summaries) {
    for (const wi of summ.items) {
      total++;
      const pid = (wi as WorkItem).projectId;
      const ev = (wi as WorkItem).attribution_evidence ?? '';
      if (!pid || pid === 'unclear') continue;
      if (pid.startsWith('new:')) continue; // unresolved proposal, not attributed
      attributed++;
      if (ev.length > 0) {
        evidenceOk++;
      } else {
        evidenceMissingButAttributed++;
        if (ruleSamples.length < 5) ruleSamples.push({ name, title: wi.title, pid });
      }
    }
  }
  const attributedRate = total === 0 ? 0 : attributed / total;
  const evidenceCoverage = attributed === 0 ? 1 : evidenceOk / attributed;

  report.push(`total work items          : ${total}`);
  report.push(
    `attributed (non-unclear)  : ${attributed} (${(attributedRate * 100).toFixed(1)}%)`
  );
  report.push(
    `attribution_evidence_cov  : ${(evidenceCoverage * 100).toFixed(1)}% (${evidenceOk}/${attributed})`
  );
  if (evidenceMissingButAttributed > 0) {
    report.push(
      `  ⚠ ${evidenceMissingButAttributed} attributed items missing evidence — parseSummary regression`
    );
    for (const s of ruleSamples) {
      report.push(`    ${s.name} · ${s.title} → ${s.pid}`);
    }
  }

  // Gate B per spec §0.6:
  //   - attribution_evidence_coverage MUST be 100% — this is a regression
  //     detector; parseSummary forces evidence to non-empty when projectId is
  //     non-unclear, so anything < 100% means the discipline 2 strap broke.
  //     HARD FAIL.
  //   - attributed_rate is a **shaping signal, not a blocker**. Spec is
  //     explicit: "attributed_rate 低不阻塞软聚类模式发布". Surface as warning,
  //     don't fail audit. Anything < 70% just narrates what's happening.
  const ratePass = attributedRate >= 0.7;
  const evidencePass = evidenceCoverage >= 0.999;
  const pass = evidencePass; // intentional: rate is warn-only
  report.push('');
  report.push(`Gate B: ${pass ? (ratePass ? '✓ PASS' : '✓ PASS (with attributed_rate warning)') : '✗ FAIL'}`);
  if (!ratePass) {
    if (attributedRate < 0.5) {
      report.push(`  ⚠ attributed_rate < 50% — extraction is barely covering the team's work.`);
      report.push(`    First lever: enrich projects[].description (resolver runs more LLM-merge),`);
      report.push(`    then re-warm: bun run sync --only=summaries.`);
      report.push(`    Spec §0.6: not a blocker. Soft-cluster mode ships.`);
    } else {
      report.push(`  ⚠ attributed_rate in [50%, 70%) — registry too thin.`);
      report.push(`    Run another extraction pass or wait for evidence to accumulate.`);
      report.push(`    Spec §0.6: not a blocker.`);
    }
  }
  if (!evidencePass) {
    report.push(`  ✗ attribution_evidence_coverage < 100% — parseSummary's enforcement broke.`);
  }
  return { pass, report };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const windowDays = args.windowDays ?? 30;
  let pass = true;
  if (!args.only || args.only === 'A') {
    const g = await runGateA(windowDays);
    console.log(g.report.join('\n'));
    pass = pass && g.pass;
  }
  if (!args.only || args.only === 'B') {
    if (!args.only) console.log('');
    const g = await runGateB();
    console.log(g.report.join('\n'));
    pass = pass && g.pass;
  }
  console.log('');
  console.log(pass ? '✓ ALL GATES PASS' : '✗ AUDIT FAILED');
  return pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[audit] fatal:', err);
    process.exit(1);
  });
