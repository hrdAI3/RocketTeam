// Infer MBTI for each member from persona+capabilities. Calls claude --print
// per agent in parallel pool of 3. Writes back into profile.mbti.
//
// Run: bun run src/scripts/add-mbti.ts

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../lib/paths';
import type { TeamMemberProfile } from '../types/index';

const POOL = 3;

async function callClaudeCli(prompt: string): Promise<string> {
  const proc = Bun.spawn(['claude', '--print', '--output-format', 'json'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 60_000);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) throw new Error(`claude exit ${exitCode}`);
  const env = JSON.parse(stdout) as { result?: string };
  return (env.result ?? '').trim();
}

const VALID = /^[EI][NS][TF][JP]$/;

function buildPrompt(profile: TeamMemberProfile): string {
  const domains = profile.capabilities?.domains?.map((d) => d.name).join('、') ?? '';
  const focus = profile.trajectory?.learning_focus?.join('、') ?? '';
  return `[SYSTEM]
基于团队成员画像推测 MBTI 16 型人格。只输出 4 个字母（如 INTJ / ENFP）。无解释、无符号、无换行。

[USER]
姓名：${profile.name}
角色：${profile.dept} / ${profile.role}
个性：${profile.persona ?? ''}
擅长：${domains}
当前方向：${focus}

输出 4 字母 MBTI:`;
}

async function processOne(file: string): Promise<{ name: string; ok: boolean; mbti?: string }> {
  const fullPath = join(PATHS.agents, file);
  const txt = await readFile(fullPath, 'utf8');
  const profile = JSON.parse(txt) as TeamMemberProfile;
  try {
    const out = await callClaudeCli(buildPrompt(profile));
    const cleaned = out.replace(/[^A-Z]/g, '').slice(0, 4);
    if (!VALID.test(cleaned)) {
      return { name: profile.name, ok: false, mbti: out.slice(0, 30) };
    }
    profile.mbti = cleaned;
    await writeFile(fullPath, JSON.stringify(profile, null, 2), 'utf8');
    return { name: profile.name, ok: true, mbti: cleaned };
  } catch (err) {
    return { name: profile.name, ok: false, mbti: (err as Error).message.slice(0, 60) };
  }
}

async function main() {
  const files = (await readdir(PATHS.agents)).filter((f) => f.endsWith('.json'));
  let i = 0;
  const results: Array<{ name: string; ok: boolean; mbti?: string }> = [];
  async function worker() {
    while (i < files.length) {
      const idx = i++;
      const r = await processOne(files[idx]);
      results.push(r);
      console.log(`[mbti] (${results.length}/${files.length}) ${r.name} ${r.ok ? r.mbti : '✗ ' + r.mbti}`);
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n[mbti] done. ok=${ok}/${files.length}`);
}

main().catch((err) => {
  console.error('[mbti] fatal:', err);
  process.exit(1);
});
