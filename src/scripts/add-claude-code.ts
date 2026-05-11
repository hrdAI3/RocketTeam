// One-shot: add `agents.claude_code` instance to every member profile.
// Deterministic mock — no LLM call. Each profile gets quota / current task /
// collaboration_style derived from name + role.
//
// Run: bun run src/scripts/add-claude-code.ts

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../lib/paths';
import type { TeamMemberProfile, AgentInstance } from '../types/index';

const NOW = new Date().toISOString();

function quotaLimitFor(role: string): number {
  if (/负责人|总监|VP|首席|创始/.test(role)) return 800;
  if (/工程师|研发|开发|前端|后端/.test(role)) return 600;
  if (/设计/.test(role)) return 400;
  return 300;
}

function styleFor(role: string, persona: string): string {
  if (/产品|策略/.test(role)) return '会先丢一段长 brief 让 agent 写需求文档，再分多次让它细化交互。';
  if (/工程师|研发|开发|前端|后端/.test(role)) return '让 agent 写测试 + 跑实验为主，复杂状态推理时先自己拆解再让它写。';
  if (/设计/.test(role)) return '主要让 agent 写 spec / 切图 boilerplate，视觉判断仍亲自做。';
  if (/运营/.test(role)) return '让 agent 帮草拟文案、整理数据 dashboard，关键决策仍亲自审。';
  if (/HR|招聘|人事/.test(role)) return '让 agent 起草 JD / 邮件，最终发出前确认口吻。';
  return persona.slice(0, 60) + '...';
}

function mockTaskFor(role: string): { description: string; started_at: string } | null {
  const todayDate = new Date(Date.now() - Math.random() * 3 * 86400000).toISOString();
  if (/产品|策略/.test(role)) return { description: '梳理 5/20 demo 的产品故事线', started_at: todayDate };
  if (/前端|UI/.test(role)) return { description: '招聘官网首屏改版切图与响应式适配', started_at: todayDate };
  if (/后端|研发/.test(role)) return { description: '推演 sim runner 性能优化与日志', started_at: todayDate };
  if (/设计/.test(role)) return { description: '0.5 亿目标海报视觉初稿 v3', started_at: todayDate };
  if (/运营/.test(role)) return { description: '小红书 5 月内容矩阵起草', started_at: todayDate };
  if (/HR|招聘/.test(role)) return { description: '前端候选人 JD 改写与初筛邮件', started_at: todayDate };
  return null;
}

function buildAgent(p: TeamMemberProfile): AgentInstance {
  const limit = quotaLimitFor(p.role);
  const used = Math.round(Math.random() * limit * 0.7);
  const cur = mockTaskFor(p.role);
  const isLeader = /负责人/.test(p.role);
  return {
    vendor: 'Anthropic',
    model_handle: 'claude-code',
    display_name: 'Claude Code',
    quota_period: 'monthly',
    quota_used_cny: used,
    quota_limit_cny: limit,
    current_tasks: cur ? [cur] : [],
    past_tasks: [
      {
        description: '上周协助起草项目周报',
        finished_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        outcome: 'success'
      }
    ],
    strengths_observed: isLeader
      ? ['拆解大方向', '同时推进多线并行']
      : ['在熟悉的领域里执行迅速', '愿意先小规模试验再扩大'],
    weaknesses_observed: ['复杂跨团队上下文容易丢线', '初稿交付偶尔 over-engineer'],
    collaboration_style: styleFor(p.role, p.persona ?? ''),
    tools_enabled: ['code_edit', 'shell', 'web_search', 'mcp:slack'],
    last_active_at: NOW
  };
}

async function main() {
  const files = await readdir(PATHS.agents);
  let updated = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = join(PATHS.agents, f);
    const txt = await readFile(p, 'utf8');
    const profile = JSON.parse(txt) as TeamMemberProfile;
    profile.agents = profile.agents ?? {};
    profile.agents.claude_code = buildAgent(profile);
    await writeFile(p, JSON.stringify(profile, null, 2), 'utf8');
    updated++;
    console.log(`[add-claude-code] ${profile.name} ✓`);
  }
  console.log(`\n[add-claude-code] done. ${updated} profiles updated.`);
}

main().catch((err) => {
  console.error('[add-claude-code] fatal:', err);
  process.exit(1);
});
