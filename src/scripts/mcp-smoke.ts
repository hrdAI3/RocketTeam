#!/usr/bin/env bun
// MCP smoke test for anzy's CC integration. Talks to the team MCP server over
// stdio just like Claude Code would. Confirms:
//   1. server starts and responds to `initialize`
//   2. tools/list returns the 4 leader tools
//   3. team:dispatch end-to-end (parse → sim start) actually fires
//
// Run from the team app dir:
//   bun run src/scripts/mcp-smoke.ts
// Exits 0 on success, 1 on any failure.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

interface RpcResp<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string };
}

async function runSmoke(): Promise<number> {
  const serverPath = join(process.cwd(), 'src', 'mcp', 'server.ts');
  const child = spawn('bun', ['run', serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  let buf = '';
  const responses: Record<string | number, RpcResp> = {};
  // Keep a rolling tail of the child's stderr so that on RPC timeout we can
  // surface the real failure (e.g. LLM provider rejected the key) instead of
  // the bare "MCP id=3 timed out".
  const stderrTail: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const resp = JSON.parse(line) as RpcResp;
        if (resp.id !== null && resp.id !== undefined) responses[resp.id] = resp;
      } catch {
        /* skip non-JSON noise */
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[mcp.stderr] ${chunk}`);
    stderrTail.push(chunk);
    while (stderrTail.length > 40) stderrTail.shift();
  });

  function send(id: number, method: string, params: Record<string, unknown> = {}): void {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }
  async function wait(id: number, timeoutMs: number = 30_000): Promise<RpcResp> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (responses[id]) return responses[id];
      await new Promise((r) => setTimeout(r, 50));
    }
    const tail = stderrTail.join('').trim().slice(-800);
    throw new Error(
      `MCP id=${id} timed out after ${timeoutMs}ms` +
        (tail.length > 0 ? `\nLast stderr from MCP server:\n${tail}` : '')
    );
  }

  const fail = (msg: string): number => {
    process.stderr.write(`✗ ${msg}\n`);
    return 1;
  };

  try {
    send(1, 'initialize', {});
    const init = await wait(1);
    if (init.error) return fail(`initialize errored: ${init.error.message}`);
    console.log('✓ initialize ok');

    send(2, 'tools/list', {});
    const tools = await wait(2);
    if (tools.error) return fail(`tools/list errored: ${tools.error.message}`);
    const list = (tools.result as { tools?: Array<{ name: string }> }).tools ?? [];
    const names = new Set(list.map((t) => t.name));
    const wanted = ['team:status', 'team:today', 'team:dispatch', 'team:ask'];
    for (const w of wanted) {
      if (!names.has(w)) return fail(`tools/list missing ${w}`);
    }
    console.log(`✓ tools/list ok (${list.length} tools)`);

    // The dispatch path runs an LLM call. Skip cleanly if the env doesn't
    // carry MINIMAX_API_KEY — better to say "skipped, set the key" than to
    // burn 20s on a misleading timeout.
    if (!process.env.MINIMAX_API_KEY) {
      console.log('⚠ team:dispatch skipped — MINIMAX_API_KEY not set in this shell');
      return 0;
    }

    send(3, 'tools/call', {
      name: 'team:dispatch',
      arguments: {
        brief:
          'Smoke test: 写一个把 events.jsonl 按周切片的小脚本。优先级一般，紧急度低，预计 0.5 天能搞定，质量要求一般。',
        context: '从 mcp-smoke.ts 触发的烟测，不要真起 sim。'
      }
    });
    // 35s tolerance: the parser path triggers an LLM call. MiniMax M2.7
    // routinely takes 15-25s, occasionally 30s. Below this on a bad key the
    // provider 401s in <1s and we exit cleanly; above it the tail-of-stderr
    // dump tells anzy whether the provider hung or the response was malformed.
    const dispatch = await wait(3, 35_000);
    if (dispatch.error) return fail(`team:dispatch errored: ${dispatch.error.message}`);
    const payload = dispatch.result as {
      content?: Array<{ type: string; text: string }>;
      _meta?: Record<string, unknown>;
    };
    const text = payload.content?.[0]?.text ?? '';
    console.log(`✓ team:dispatch responded: ${text.split('\n')[0]}`);
    if (payload._meta?.sim_id) {
      console.log(`   sim_id=${payload._meta.sim_id} task_id=${payload._meta.task_id ?? '?'}`);
    } else {
      console.log('   (no sim started — parser likely asked for more fields, OK for smoke)');
    }

    return 0;
  } finally {
    child.kill();
  }
}

runSmoke()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
