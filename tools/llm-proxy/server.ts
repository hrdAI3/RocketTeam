// OpenAI-compatible proxy backed by a file queue.
// The team app hits POST /v1/chat/completions on localhost:PORT.
// Server writes the request to queue/requests/{id}.json, then long-polls
// queue/responses/{id}.json. A human-in-the-loop (you, in this Claude Code
// session) reads the request file, writes a response file, the server
// returns it as a normal OpenAI ChatCompletion to the team app.
//
// Run: bun tools/llm-proxy/server.ts
//   PORT=9001 (default)
//   POLL_INTERVAL_MS=300 (default)
//   POLL_TIMEOUT_MS=180000 (default 3 min)

import { serve } from 'bun';
import { mkdir, readFile, writeFile, rename, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.PORT ?? 9001);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 300);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 180_000);
const QUEUE_DIR = resolve(import.meta.dir, 'queue');
const REQ_DIR = join(QUEUE_DIR, 'requests');
const RES_DIR = join(QUEUE_DIR, 'responses');
const ARC_DIR = join(QUEUE_DIR, 'archive');
const MOCK_DIR = resolve(import.meta.dir, 'mocks');

await mkdir(REQ_DIR, { recursive: true });
await mkdir(RES_DIR, { recursive: true });
await mkdir(ARC_DIR, { recursive: true });
await mkdir(MOCK_DIR, { recursive: true });

// ---- Mock library ----
// Each mock file is JSON: { match: string[], content: string|object, delay_ms?: number }
// Matching: ALL strings in `match` must appear in (system + "\n" + user). First mock
// that matches wins. content can be string (pass-through) or object (JSON.stringify'd).
// Pre-written mocks unlock zero-latency, no-human-in-loop demo flow.
interface MockEntry {
  name: string;
  match: string[];
  content: string;
  delay_ms?: number;
}
let mocks: MockEntry[] = [];

async function loadMocks(): Promise<void> {
  const files = await readdir(MOCK_DIR).catch(() => [] as string[]);
  mocks = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const txt = await readFile(join(MOCK_DIR, f), 'utf8');
      const j = JSON.parse(txt) as { match: string[]; content: string | object; delay_ms?: number };
      const content = typeof j.content === 'string' ? j.content : JSON.stringify(j.content);
      mocks.push({ name: f, match: j.match ?? [], content, delay_ms: j.delay_ms });
    } catch (err) {
      console.warn(`[llm-proxy] bad mock ${f}:`, (err as Error).message);
    }
  }
  console.log(`[llm-proxy] loaded ${mocks.length} mocks`);
}

function findMock(haystack: string): MockEntry | null {
  for (const m of mocks) {
    if (m.match.length === 0) continue;
    if (m.match.every((s) => haystack.includes(s))) return m;
  }
  return null;
}

await loadMocks();

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type: string };
}

interface QueuedRequest {
  id: string;
  ts: string;
  model: string;
  system: string;
  user: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  json_mode: boolean;
  expects_stream: boolean;
}

interface QueuedResponse {
  id: string;
  content: string;
  finish_reason?: string;
  ts: string;
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Cap concurrent claude --print invocations. Each subprocess spins up the
// full Claude Code runtime; spawning >3 in parallel chews CPU + may hit
// OAuth/plan concurrency limits, causing some to hang or fail.
const MAX_CONCURRENT = Number(process.env.CLAUDE_CONCURRENCY ?? 3);
let inflight = 0;
const waiters: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (inflight < MAX_CONCURRENT) {
    inflight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight++;
}
function releaseSlot(): void {
  inflight--;
  const next = waiters.shift();
  if (next) next();
}

// Spawn `claude --print` subprocess. Pipes prompt via stdin, captures stdout.
// Each call is fresh — no session memory across requests.
async function callClaudeCli(req: QueuedRequest): Promise<string> {
  await acquireSlot();
  try {
    return await callClaudeCliInner(req);
  } finally {
    releaseSlot();
  }
}

async function callClaudeCliInner(req: QueuedRequest): Promise<string> {
  const jsonGuard = req.json_mode
    ? '\n\n--- 输出约束 ---\n你必须只输出有效 JSON 对象。不要 markdown 代码块。不要 ```json 围栏。不要任何解释文字。直接以 { 开始，以 } 结束。'
    : '';
  const prompt =
    `[SYSTEM]\n${req.system}\n\n[USER]\n${req.user}${jsonGuard}\n`;

  const proc = Bun.spawn(['claude', '--print', '--output-format', 'json'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();

  const timeoutMs = 180_000;
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* ignore */ }
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`claude --print exit ${exitCode}: ${stderr.slice(0, 300)}`);
  }
  let envelope: { result?: string; is_error?: boolean; error?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude envelope parse failed: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error) throw new Error(envelope.error ?? 'claude reported error');
  let out = (envelope.result ?? '').trim();
  out = out.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  return out;
}

async function waitForResponse(id: string): Promise<QueuedResponse> {
  const path = join(RES_DIR, `${id}.json`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await fileExists(path)) {
      const txt = await readFile(path, 'utf8');
      const res = JSON.parse(txt) as QueuedResponse;
      // Archive the response file (keep request in archive too if exists).
      await rename(path, join(ARC_DIR, `${id}.res.json`)).catch(() => {});
      const reqPath = join(REQ_DIR, `${id}.json`);
      if (await fileExists(reqPath)) {
        await rename(reqPath, join(ARC_DIR, `${id}.req.json`)).catch(() => {});
      }
      return res;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`response timeout after ${POLL_TIMEOUT_MS}ms for id=${id}`);
}

function shapeChatCompletion(id: string, model: string, content: string): unknown {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

function shapeStreamChunk(id: string, model: string, delta: string, done = false): string {
  const data = {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: done ? {} : { content: delta },
        finish_reason: done ? 'stop' : null
      }
    ]
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}

console.log(`[llm-proxy] queue: ${QUEUE_DIR}`);
console.log(`[llm-proxy] listening on http://localhost:${PORT}`);

serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, queue: QUEUE_DIR, mocks: mocks.length }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.pathname === '/reload-mocks') {
      await loadMocks();
      return new Response(JSON.stringify({ ok: true, mocks: mocks.length }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.pathname === '/v1/models') {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'claude-via-cli', object: 'model', owned_by: 'local-proxy' }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = (await req.json()) as ChatCompletionRequest;
      const id = genId();
      const messages = body.messages ?? [];
      const sys = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      const usr = messages
        .filter((m) => m.role !== 'system')
        .map((m) => m.content)
        .join('\n\n');
      const queued: QueuedRequest = {
        id,
        ts: new Date().toISOString(),
        model: body.model ?? 'claude-via-cli',
        system: sys,
        user: usr,
        messages,
        temperature: body.temperature ?? 0.4,
        max_tokens: body.max_tokens ?? 2048,
        json_mode: body.response_format?.type?.includes('json') ?? false,
        expects_stream: body.stream ?? false
      };

      // ---- Direct subprocess: claude --print ----
      // Use the user's existing Claude OAuth login to generate the response.
      // Each call is a fresh session (no memory across calls), which matches
      // how the team app expects stateless LLM behaviour.
      console.log(`[llm-proxy] req ${id} dispatching to claude CLI (json=${queued.json_mode})`);
      try {
        const content = await callClaudeCli(queued);
        if (queued.expects_stream) {
          const encoder = new TextEncoder();
          const chunkSize = 80;
          const stream = new ReadableStream({
            async start(controller) {
              for (let i = 0; i < content.length; i += chunkSize) {
                const slice = content.slice(i, i + chunkSize);
                controller.enqueue(encoder.encode(shapeStreamChunk(id, queued.model, slice)));
                await Bun.sleep(20);
              }
              controller.enqueue(encoder.encode(shapeStreamChunk(id, queued.model, '', true)));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });
          return new Response(stream, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
          });
        }
        return new Response(
          JSON.stringify(shapeChatCompletion(id, queued.model, content)),
          { headers: { 'content-type': 'application/json' } }
        );
      } catch (err) {
        console.error(`[llm-proxy] req ${id} claude CLI failed:`, (err as Error).message);
        return new Response(
          JSON.stringify({ error: { message: (err as Error).message, type: 'cli_error' } }),
          { status: 502, headers: { 'content-type': 'application/json' } }
        );
      }

    }
    return new Response('not found', { status: 404 });
  }
});
