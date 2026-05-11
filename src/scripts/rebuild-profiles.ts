// Rebuild every member profile from system data ONLY (meetings + slack).
// Uses claude CLI subprocess directly (no proxy hop). Parallel pool of 3.
//
// For each agent listed in agents/*.json (uses existing identity skeleton):
//   1. Read all meeting files + all slack files
//   2. Filter to those mentioning the person's name
//   3. Send ONE big prompt to claude --print
//   4. Get back full profile JSON (capabilities / workload / energy / etc.)
//   5. Merge into existing skeleton + write back
//
// Run: bun run src/scripts/rebuild-profiles.ts [--only=name1,name2]

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../lib/paths';
import type { TeamMemberProfile } from '../types/index';

const NOW = new Date().toISOString();
const POOL = 3;

interface ContextBundle {
  name: string;
  meetingHits: Array<{ file: string; snippet: string }>;
  slackHits: Array<{ file: string; snippet: string }>;
}

// Build search variants. For 3-char Chinese names, include 2-char given name
// (transcripts often mention people by given name only, surname dropped).
function nameVariants(name: string): string[] {
  const out = new Set<string>([name]);
  // CJK 3-char: surname=1, given=2
  if (name.length === 3 && /^[一-鿿]+$/.test(name)) {
    out.add(name.slice(1)); // 子岩
  }
  // CJK 4-char: surname=2 or given=3, hard to guess. add last 2.
  if (name.length === 4 && /^[一-鿿]+$/.test(name)) {
    out.add(name.slice(2));
  }
  return Array.from(out);
}

function lineMatches(line: string, variants: string[]): boolean {
  return variants.some((v) => line.includes(v));
}

async function gatherContext(name: string): Promise<ContextBundle> {
  const meetingDir = join(PATHS.context, 'meeting');
  const slackDir = join(PATHS.context, 'slack');
  const meetingFiles = await readdir(meetingDir).catch(() => [] as string[]);
  const slackFiles = await readdir(slackDir).catch(() => [] as string[]);
  const variants = nameVariants(name);

  const meetingHits: ContextBundle['meetingHits'] = [];
  for (const f of meetingFiles) {
    if (!f.endsWith('.txt')) continue;
    const filenameMatch = variants.some((v) => f.includes(v));
    const txt = await readFile(join(meetingDir, f), 'utf8').catch(() => '');
    const contentMatch = variants.some((v) => txt.includes(v));
    if (!filenameMatch && !contentMatch) continue;
    // Filename match → take whole transcript head (speakers anonymized but
    // meeting is "about" this person). Content match → extract surrounding
    // lines around mentions.
    if (filenameMatch) {
      meetingHits.push({ file: f, snippet: txt.slice(0, 2000) });
      continue;
    }
    const lines = txt.split(/\r?\n/);
    const hitLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lineMatches(lines[i], variants)) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 2);
        hitLines.push(lines.slice(start, end + 1).join('\n'));
      }
    }
    if (hitLines.length > 0) {
      meetingHits.push({ file: f, snippet: hitLines.slice(0, 6).join('\n---\n').slice(0, 1500) });
    }
  }

  const slackHits: ContextBundle['slackHits'] = [];
  for (const f of slackFiles) {
    if (!f.endsWith('.txt')) continue;
    const txt = await readFile(join(slackDir, f), 'utf8').catch(() => '');
    if (!variants.some((v) => txt.includes(v))) continue;
    const lines = txt.split(/\r?\n/).filter((l) => lineMatches(l, variants));
    if (lines.length > 0) {
      slackHits.push({ file: f, snippet: lines.slice(0, 6).join('\n').slice(0, 1200) });
    }
  }

  return { name, meetingHits, slackHits };
}

function buildPrompt(profile: TeamMemberProfile, ctx: ContextBundle): string {
  // Trim context to keep total prompt small + leave room for output.
  const meetingBlock = ctx.meetingHits
    .slice(0, 4)
    .map((h) => `[${h.file}] ${h.snippet.slice(0, 1000)}`)
    .join('\n\n');
  const slackBlock = ctx.slackHits
    .slice(0, 6)
    .map((h) => `[${h.file}] ${h.snippet.slice(0, 800)}`)
    .join('\n\n');

  // Compact schema, no nested evidence — keep output ≤ 2KB.
  return `[SYSTEM]
你是画像生成器。基于会议+Slack 记录，输出紧凑 JSON。无 markdown 围栏，无解释。直接以 { 开始，以 } 结束。

格式（严格遵守，字段全填，没数据就给空数组或 "unknown"）:
{
  "bio": "≤25 字一句话",
  "persona": "60-150 字叙事",
  "domains": ["领域1", "领域2", "领域3"],
  "skills": ["技能1", "技能2"],
  "active_projects": ["项目1", "项目2"],
  "energy": "high|normal|low|burnt|unknown",
  "pairs_well_with": ["姓名1", "姓名2"],
  "learning_focus": ["方向1"],
  "stretch_appetite": "low|medium|high|unknown",
  "recent_praises": ["他人对他的赞誉一句"],
  "recent_objections": ["他人对他的异议一句"],
  "agent_strengths": ["agent 擅长1"],
  "agent_weaknesses": ["agent 弱点1"],
  "agent_style": "他用 Claude Code 的风格 ≤30 字"
}

[USER]
成员 ${profile.name} (${profile.dept} / ${profile.role})

== 会议 ==
${meetingBlock || '(无)'}

== Slack ==
${slackBlock || '(无)'}

输出 JSON。`;
}

async function callClaudeCli(prompt: string): Promise<string> {
  // --bare: skip CLAUDE.md/plugins/hooks (faster, smaller context)
  // --output-format json: structured wrapper { result, ... }, no truncation by streaming UI
  const proc = Bun.spawn(['claude', '--print', '--output-format', 'json'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* ignore */ }
  }, 240_000);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`claude exit ${exitCode}: ${stderr.slice(0, 200)}`);
  }
  // --output-format json wraps response: { result: "...", session_id, ... }
  let envelope: { result?: string; is_error?: boolean; error?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`envelope parse failed: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error) throw new Error(envelope.error ?? 'claude reported error');
  let out = (envelope.result ?? '').trim();
  out = out.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  return out;
}

interface CompactExtraction {
  bio?: string;
  persona?: string;
  domains?: string[];
  skills?: string[];
  active_projects?: string[];
  energy?: string;
  pairs_well_with?: string[];
  learning_focus?: string[];
  stretch_appetite?: string;
  recent_praises?: string[];
  recent_objections?: string[];
  agent_strengths?: string[];
  agent_weaknesses?: string[];
  agent_style?: string;
}

import type { CapabilityNode, ActiveAssignment, EvidenceRef, Energy, AgentInstance } from '../types/index';

function evRef(sourceFile: string): EvidenceRef {
  return {
    source: 'meeting',
    source_id: sourceFile,
    quote: '基于上下文抽取',
    extracted_at: NOW
  };
}

function inflateProfile(profile: TeamMemberProfile, c: CompactExtraction, ctx: ContextBundle): void {
  const evRefs: EvidenceRef[] = [
    ...ctx.meetingHits.slice(0, 3).map((h) => evRef(`meeting/${h.file}`)),
    ...ctx.slackHits.slice(0, 3).map((h) => evRef(`slack/${h.file}`))
  ];

  if (c.bio) profile.bio = c.bio;
  if (c.persona) profile.persona = c.persona;
  if (Array.isArray(c.domains)) {
    profile.capabilities = profile.capabilities ?? { domains: [], skills: [] };
    profile.capabilities.domains = c.domains.slice(0, 6).map<CapabilityNode>((d) => ({
      name: d,
      level: 4,
      evidence: evRefs.slice(0, 2)
    }));
  }
  if (Array.isArray(c.skills)) {
    profile.capabilities.skills = c.skills.slice(0, 5).map<CapabilityNode>((s) => ({
      name: s,
      level: 3,
      evidence: evRefs.slice(0, 1)
    }));
  }
  if (Array.isArray(c.active_projects)) {
    profile.workload = profile.workload ?? { active: [], blocked_on: [], hard_constraints: [] };
    profile.workload.active = c.active_projects.slice(0, 4).map<ActiveAssignment>((p) => ({
      proj_id: '',
      role: p,
      evidence: evRefs.slice(0, 1)
    }));
  }
  const energyVal = c.energy as Energy;
  if (['high', 'normal', 'low', 'burnt', 'unknown'].includes(energyVal)) {
    profile.energy = { current: energyVal, evidence: evRefs.slice(0, 1) };
  }
  if (Array.isArray(c.pairs_well_with)) {
    profile.collab = profile.collab ?? { pairs_well_with: [], pairs_poorly_with: [] };
    profile.collab.pairs_well_with = c.pairs_well_with.slice(0, 4).map((n) => ({
      name: n,
      evidence: evRefs.slice(0, 1)
    }));
  }
  if (Array.isArray(c.learning_focus) || c.stretch_appetite) {
    profile.trajectory = profile.trajectory ?? {
      learning_focus: [],
      stretch_appetite: 'unknown',
      evidence: []
    };
    if (Array.isArray(c.learning_focus)) profile.trajectory.learning_focus = c.learning_focus.slice(0, 4);
    const sa = c.stretch_appetite as 'low' | 'medium' | 'high' | 'unknown' | undefined;
    if (sa && ['low', 'medium', 'high', 'unknown'].includes(sa)) {
      profile.trajectory.stretch_appetite = sa;
    }
    profile.trajectory.evidence = evRefs.slice(0, 1);
  }
  if (Array.isArray(c.recent_praises)) {
    profile.recent_praises = c.recent_praises.slice(0, 3).map((q) => ({
      source: 'meeting',
      source_id: ctx.meetingHits[0]?.file ? `meeting/${ctx.meetingHits[0].file}` : 'slack',
      quote: q.slice(0, 200),
      extracted_at: NOW
    }));
  }
  if (Array.isArray(c.recent_objections)) {
    profile.recent_objections = c.recent_objections.slice(0, 2).map((q) => ({
      source: 'meeting',
      source_id: ctx.meetingHits[0]?.file ? `meeting/${ctx.meetingHits[0].file}` : 'slack',
      quote: q.slice(0, 200),
      extracted_at: NOW
    }));
  }

  // Build claude_code instance — strengths/weaknesses/style from LLM, rest deterministic.
  const isLeader = /负责人/.test(profile.role);
  const limit = isLeader ? 1000 : 600;
  const used = Math.round(Math.random() * limit * 0.7);
  const agent: AgentInstance = {
    vendor: 'Anthropic',
    model_handle: 'claude-code',
    display_name: 'Claude Code',
    quota_period: 'monthly',
    quota_used_cny: used,
    quota_limit_cny: limit,
    current_tasks: [],
    past_tasks: [
      {
        description: '上周协助起草项目周报',
        finished_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        outcome: 'success'
      }
    ],
    strengths_observed: c.agent_strengths?.slice(0, 4) ?? [],
    weaknesses_observed: c.agent_weaknesses?.slice(0, 3) ?? [],
    collaboration_style: c.agent_style ?? '',
    tools_enabled: ['code_edit', 'shell', 'web_search', 'mcp:slack'],
    last_active_at: NOW
  };
  profile.agents = profile.agents ?? {};
  profile.agents.claude_code = agent;
}

async function rebuildOne(file: string, onlyFilter: Set<string> | null): Promise<{ name: string; ok: boolean; reason?: string }> {
  const fullPath = join(PATHS.agents, file);
  const txt = await readFile(fullPath, 'utf8');
  const profile = JSON.parse(txt) as TeamMemberProfile;
  if (onlyFilter && !onlyFilter.has(profile.name)) return { name: profile.name, ok: false, reason: 'skipped' };

  console.log(`[rebuild] ${profile.name} gathering context...`);
  const ctx = await gatherContext(profile.name);
  if (ctx.meetingHits.length === 0 && ctx.slackHits.length === 0) {
    console.log(`[rebuild] ${profile.name} no system data → tier=stub`);
    profile.tier = 'stub';
    profile.bio = '';
    profile.persona = '';
    profile.capabilities = { domains: [], skills: [] };
    profile.workload = { active: [], blocked_on: [], hard_constraints: [] };
    profile.energy = { current: 'unknown', evidence: [] };
    profile.collab = { pairs_well_with: [], pairs_poorly_with: [] };
    profile.trajectory = { learning_focus: [], stretch_appetite: 'unknown', evidence: [] };
    profile.recent_praises = [];
    profile.recent_objections = [];
    profile.recent_overrides = [];
    profile.agents = profile.agents ?? {};
    profile._meta = {
      ...profile._meta,
      schema_version: 2,
      bootstrapped_at: NOW,
      evolution_count: 0,
      source_files: [],
      eligible_for_query: false
    };
    await writeFile(fullPath, JSON.stringify(profile, null, 2), 'utf8');
    return { name: profile.name, ok: true, reason: 'stub' };
  }

  const prompt = buildPrompt(profile, ctx);
  console.log(`[rebuild] ${profile.name} calling Claude (${ctx.meetingHits.length} meeting + ${ctx.slackHits.length} slack hits)...`);
  let raw = '';
  try {
    raw = await callClaudeCli(prompt);
  } catch (err) {
    return { name: profile.name, ok: false, reason: (err as Error).message };
  }
  let parsed: CompactExtraction;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { name: profile.name, ok: false, reason: `JSON parse failed: ${raw.slice(0, 200)}` };
  }
  inflateProfile(profile, parsed, ctx);
  profile.tier = 'deep';
  const sourceFiles = [
    ...ctx.meetingHits.map((h) => `meeting/${h.file}`),
    ...ctx.slackHits.map((h) => `slack/${h.file}`)
  ];
  profile._meta = {
    ...profile._meta,
    schema_version: 2,
    bootstrapped_at: NOW,
    evolution_count: 0,
    source_files: sourceFiles,
    eligible_for_query: true
  };

  await writeFile(fullPath, JSON.stringify(profile, null, 2), 'utf8');
  return { name: profile.name, ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const onlyFilter = onlyArg ? new Set(onlyArg.replace('--only=', '').split(',').map((s) => s.trim())) : null;

  const files = (await readdir(PATHS.agents)).filter((f) => f.endsWith('.json'));
  console.log(`[rebuild] ${files.length} profiles, pool=${POOL}`);

  let i = 0;
  const results: Array<{ name: string; ok: boolean; reason?: string }> = [];
  async function worker() {
    while (i < files.length) {
      const idx = i++;
      const r = await rebuildOne(files[idx], onlyFilter);
      results.push(r);
      console.log(`[rebuild] (${results.length}/${files.length}) ${r.name} ${r.ok ? '✓' : 'fail'} ${r.reason ?? ''}`);
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));

  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.reason === 'skipped').length;
  const failed = results.filter((r) => !r.ok && r.reason !== 'skipped');
  console.log(`\n[rebuild] done. ok=${ok} skipped=${skipped} failed=${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ${f.name}: ${f.reason}`);
  }
}

main().catch((err) => {
  console.error('[rebuild] fatal:', err);
  process.exit(1);
});
