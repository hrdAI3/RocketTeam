import { NextRequest } from 'next/server';
import { readSimReplay } from '@/sim/runner';
import { llmStream, stripThinkBlocks } from '@/lib/llm';
import { getTask } from '@/lib/tasks';
import { REPORT_CHAT_ACTION_CITE_EXAMPLE } from '@private/source-data/prompt-examples';
import type { Task, PMADecisionV2, SimulationRunState } from '@/types';

export const dynamic = 'force-dynamic';

// POST /api/report/chat
// Body: { sim_id: string, question: string, history?: Array<{role, content}> }
// Streams Report Agent answer as SSE tokens.
export async function POST(req: NextRequest): Promise<Response> {
  let body: { sim_id?: string; task_id?: string; question?: string; history?: Array<{ role: string; content: string }> } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }

  const sim_id = body.sim_id;
  const question = (body.question ?? '').trim();
  if (!sim_id || !question) {
    return new Response(JSON.stringify({ error: 'sim_id and question required' }), { status: 400 });
  }

  const sim = await readSimReplay(sim_id);
  if (!sim) {
    return new Response(JSON.stringify({ error: 'sim not found' }), { status: 404 });
  }

  let task: Task | null = null;
  if (body.task_id) {
    task = await getTask(body.task_id);
  }

  const history = body.history ?? [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* closed */
        }
      };

      try {
        const system = buildReportSystemPrompt(sim, task);
        const user = buildUserPrompt(question, history);

        let full = '';
        await llmStream({
          system,
          user,
          signal: req.signal,
          temperature: 0.6,
          maxTokens: 1500,
          onToken: (t) => {
            const cleaned = t.replace(/<\/?think>/gi, '');
            if (cleaned) {
              full += cleaned;
              send('token', { token: cleaned });
            }
          }
        });

        const final = stripThinkBlocks(full);
        send('done', { content: final });
      } catch (err) {
        send('error', { error: (err as Error).message });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
}

function buildReportSystemPrompt(sim: SimulationRunState, task: Task | null): string {
  const decision = task?.decision;
  const decisionBlock =
    decision && 'sim_replay_id' in decision
      ? `# Final decision (PMADecisionV2)
${(decision as PMADecisionV2).decomposition
  ?.map(
    (s) =>
      `- ${s.subtask} → ${s.assignee} · cap=${s.capability_fit} load=${s.load_fit} collab=${s.collab_fit}`
  )
  .join('\n') ?? `top1 = ${(decision as PMADecisionV2).top1 ?? 'null'}`}
Confidence: ${(decision as PMADecisionV2).confidence}
Rationale: ${(decision as PMADecisionV2).rationale}`
      : '(决策待综合)';

  const trackBlock = (label: string, rounds: typeof sim.rounds_a) =>
    `# ${label}
${rounds
  .map(
    (r) =>
      `## Round ${r.round_num}\n` +
      r.actions
        .map((a) => {
          const p = a.payload;
          switch (p.type) {
            case 'BID':
              return `  ${a.agent_name} BID cap=${p.capability_fit} load=${p.load_fit} collab=${p.collab_fit} 「${p.reason}」`;
            case 'DEFER':
              return `  ${a.agent_name} DEFER → ${p.recommend} 「${p.reason}」`;
            case 'RECOMMEND_SPLIT':
              return `  ${a.agent_name} SPLIT [${p.subtasks
                .map((s) => `${s.subtask}→${s.assignee}`)
                .join(' | ')}]`;
            case 'OBJECT':
              return `  ${a.agent_name} OBJECT against「${p.against}」「${p.reason}」`;
            case 'COMMIT':
              return `  ${a.agent_name} COMMIT 「${p.subtask}」`;
          }
        })
        .join('\n')
  )
  .join('\n')}`;

  return `你是 Report Agent。manager 在向你询问关于一次仿真的问题。你掌握仿真完整 record（双 track 4 轮 actions + 最终决策）。

任务：${sim.config.task_description}

${trackBlock('Track A · Optimistic', sim.rounds_a)}

${trackBlock('Track B · Skeptical', sim.rounds_b)}

${decisionBlock}

回答要求：
- 中文，直接，不啰嗦
- cite 至少 1 个具体 round action（"${REPORT_CHAT_ACTION_CITE_EXAMPLE}"）
- 如果两 track 不一致，明示分歧
- 不要"好的"/"以下是"开场白
- 回答控制在 4-6 句以内

如果 manager 在做"上帝视角变量注入"（"如果 X 生病"/"如果 X 不在"等假设），回答：
1. 哪些子任务需要重新分配
2. 用同一仿真数据推断（不真跑 mini-sim）最佳替代
3. 注明这是基于 cached evidence 的推断、若需精确请重跑仿真`;
}

function buildUserPrompt(question: string, history: Array<{ role: string; content: string }>): string {
  if (history.length === 0) return question;
  const hist = history
    .slice(-6)
    .map((h) => `${h.role === 'user' ? 'Manager' : 'Report'}: ${h.content}`)
    .join('\n');
  return `# 历史对话\n${hist}\n\n# 当前问题\n${question}`;
}
