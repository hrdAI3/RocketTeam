#!/usr/bin/env bun
// Minimal MCP server (JSON-RPC 2.0 over stdio). No external SDK dependency.
//
// Implements just enough of the MCP wire protocol for Claude Code to discover
// and call our tools/prompts. Spec: github.com/modelcontextprotocol
//
// Tools (leader-facing, 4):
//   team:status     — CC work status, all agents or one
//   team:today      — three-tier anomaly briefing
//   team:dispatch   — start a sim from a task brief (+ optional conversation context)
//   team:ask        — natural-language Q&A about one agent's recent CC work
//
// Resources:
//   anomaly://current   — current open anomalies (informational; leader gets a Slack DM when act-now opens)
//   events://recent     — last 200 events
//
// Launch (from leader's machine):
//   bun run src/mcp/server.ts
// or configure in claude_desktop_config.json:
//   { "mcpServers": { "team": { "command": "bun", "args": ["run", "<path>/src/mcp/server.ts"] } } }

import { runToday } from '../services/today';
import { listOpenAnomalies } from '../anomaly/store';
import { readAllEvents } from '../lib/events';
import {
  getRosterView,
  getOneStatus,
  renderRosterMarkdown,
  renderOneStatusMarkdown,
  askAboutAgentCC
} from '../services/cc_status';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = { name: 'team', version: '0.2.0' };

const TOOLS = [
  {
    name: 'team:status',
    description:
      'Team CC status — the attention-scarce leader view. With no `name`: open anomalies (the only thing to act on) + a team aggregate (weekly token cost, activity counts, who needs intervention) + a lean one-line-per-agent roster sorted anomaly-first. With `name`: that agent\'s detail — recent sessions, tools, token usage, stuck-signal quotes. For a natural-language question about one agent use team:ask instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional canonical agent name (e.g. "黄运樟"). Omit for the roster.' }
      }
    }
  },
  {
    name: 'team:today',
    description:
      "Generate today's three-tier anomaly briefing (act-now / next-glance / fyi). Returns markdown. Call at the start of a session, after a /loop tick, or whenever the leader wants to know what is happening across the team.",
    inputSchema: {
      type: 'object',
      properties: {
        last_run_at: { type: 'string', description: 'ISO timestamp of the last team:today run, used to surface "what changed since".' }
      }
    }
  },
  {
    name: 'team:dispatch',
    description:
      'Dispatch a task. Uses the simulation-prediction pipeline: parses the brief into structured fields, then runs the PMA simulation to predict who should take it. IMPORTANT: if the leader has been discussing this task in the current conversation, pass the relevant background in `context` so the simulation has the full picture (deadlines, constraints, who was mentioned, why). If required fields are missing the tool returns a "missing" response listing them — ask the leader, then re-call with the answers folded into `brief` or `context`.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The task, in one or two sentences.' },
        context: {
          type: 'string',
          description: 'Optional. Relevant background from the current conversation — what the leader said about this task, constraints, names, deadlines, prior discussion. Include it whenever the leader has been talking about this; the simulation reads it.'
        }
      },
      required: ['brief']
    }
  },
  {
    name: 'team:ask',
    description:
      "Ask a natural-language question about one agent's recent Claude Code work (last 7 days). An LLM reads that agent's CC events — sessions, tool usage, stuck signals, commits, PRs, meeting action items — and answers. Use for \"黄运樟 最近在搞什么?\" / \"张三 卡在哪?\" type questions. For a structured table use team:status instead. This does NOT page the human.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Canonical agent name, e.g. "黄运樟".' },
        question: { type: 'string', description: 'Free-text question about that agent\'s recent CC work.' }
      },
      required: ['agent', 'question']
    }
  }
];

const PROMPTS = [
  {
    name: 'morning-standup',
    description: '等价于 team:today，prompt 形态便于在 CC 里一键触发。',
    arguments: []
  }
];

const RESOURCES = [
  { uri: 'anomaly://current', name: 'Current open anomalies', mimeType: 'application/json' },
  { uri: 'events://recent', name: 'Recent events (last 200)', mimeType: 'application/json' }
];

async function handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  try {
    const result = await dispatch(req.method, req.params ?? {});
    if (result === '__notification__') return null;
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } };
  }
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: SERVER_INFO
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return '__notification__';
    case 'tools/list':
      return { tools: TOOLS };
    case 'prompts/list':
      return { prompts: PROMPTS };
    case 'resources/list':
      return { resources: RESOURCES };
    case 'tools/call':
      return callTool(params);
    case 'prompts/get':
      return getPrompt(params);
    case 'resources/read':
      return readResource(params);
    case 'ping':
      return {};
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

function asString(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error('expected non-empty string');
  return v;
}

function asOptString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error('expected string');
  return v;
}

async function callTool(params: Record<string, unknown>): Promise<unknown> {
  const name = asString(params.name);
  const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
  switch (name) {
    case 'team:status': {
      const nameArg = asOptString(args.name);
      if (nameArg) {
        const detail = await getOneStatus(nameArg);
        if (!detail) return { content: [{ type: 'text', text: `No CC status for ${nameArg}.` }] };
        return { content: [{ type: 'text', text: renderOneStatusMarkdown(detail) }] };
      }
      const view = await getRosterView();
      return { content: [{ type: 'text', text: renderRosterMarkdown(view) }] };
    }
    case 'team:today': {
      const result = await runToday({ lastRunAt: asOptString(args.last_run_at) ?? null });
      return { content: [{ type: 'text', text: result.markdown }], _meta: result.inputSummary };
    }
    case 'team:dispatch': {
      const brief = asString(args.brief);
      const context = asOptString(args.context);
      return dispatchTask(brief, context);
    }
    case 'team:ask': {
      const agent = asString(args.agent);
      const question = asString(args.question);
      const answer = await askAboutAgentCC(agent, question);
      return { content: [{ type: 'text', text: answer }] };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function getPrompt(params: Record<string, unknown>): Promise<unknown> {
  const name = asString(params.name);
  if (name === 'morning-standup') {
    const result = await runToday({});
    return {
      description: '当日 anomaly briefing',
      messages: [{ role: 'user', content: { type: 'text', text: result.markdown } }]
    };
  }
  throw new Error(`unknown prompt: ${name}`);
}

async function readResource(params: Record<string, unknown>): Promise<unknown> {
  const uri = asString(params.uri);
  if (uri === 'anomaly://current') {
    const anomalies = await listOpenAnomalies();
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ anomalies }, null, 2) }] };
  }
  if (uri === 'events://recent') {
    const events = (await readAllEvents()).slice(-200);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ events }, null, 2) }] };
  }
  throw new Error(`unknown resource: ${uri}`);
}

async function dispatchTask(brief: string, context?: string): Promise<unknown> {
  const base = process.env.TEAM_API_BASE ?? 'http://127.0.0.1:3000';
  // Fold conversation context into the description so the parser + simulation
  // see everything the leader already said about this task.
  const description = context && context.trim().length > 0
    ? `${brief}\n\n[来自对话的背景]\n${context.trim()}`
    : brief;
  // 1) parse
  const parseRes = await fetch(`${base}/api/tasks/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, prior: {} })
  });
  if (!parseRes.ok) throw new Error(`parse ${parseRes.status}`);
  const parsed = (await parseRes.json()) as {
    extracted: Record<string, unknown>;
    missing_required: string[];
    ready_to_submit: boolean;
    next_question?: { prompt: string };
  };
  if (!parsed.ready_to_submit) {
    return {
      content: [
        {
          type: 'text',
          text: `任务缺少：${parsed.missing_required.join('、')}。${parsed.next_question?.prompt ?? ''}\n（问 leader 后，把答案补进 brief 或 context 再调一次）`
        }
      ],
      _meta: { extracted: parsed.extracted, missing: parsed.missing_required }
    };
  }
  // 2) start sim
  const simRes = await fetch(`${base}/api/sim/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.extracted)
  });
  if (!simRes.ok) throw new Error(`sim/start ${simRes.status}`);
  const sim = (await simRes.json()) as { sim_id: string; task_id: string };
  return {
    content: [
      { type: 'text', text: `✓ 已派 task=${sim.task_id} sim=${sim.sim_id}\n推演实时: ${base}/live/${sim.sim_id}` }
    ],
    _meta: { sim_id: sim.sim_id, task_id: sim.task_id, url: `${base}/live/${sim.sim_id}` }
  };
}

// ============== stdio loop ==============

async function main() {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', async (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'
        );
        continue;
      }
      const resp = await handle(req);
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

void main();
