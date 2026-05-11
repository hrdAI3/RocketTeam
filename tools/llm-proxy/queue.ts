// CLI helpers for the file-queue LLM proxy.
//
//   bun tools/llm-proxy/queue.ts list
//   bun tools/llm-proxy/queue.ts show <id>
//   bun tools/llm-proxy/queue.ts answer <id> <path-to-content-file>
//   bun tools/llm-proxy/queue.ts answer-inline <id> <<<'content here'
//
// You (Claude in this session) usually use the file tools directly:
//   1. List requests/  → pick oldest
//   2. Read requests/<id>.json
//   3. Write responses/<id>.json with { id, content, ts }
//
// This CLI is just for humans / debugging.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const QUEUE_DIR = resolve(import.meta.dir, 'queue');
const REQ_DIR = join(QUEUE_DIR, 'requests');
const RES_DIR = join(QUEUE_DIR, 'responses');

const cmd = process.argv[2];

async function listPending(): Promise<void> {
  const files = await readdir(REQ_DIR);
  const reqs = files.filter((f) => f.endsWith('.json'));
  if (reqs.length === 0) {
    console.log('(no pending)');
    return;
  }
  for (const f of reqs) {
    const id = f.replace(/\.json$/, '');
    const p = join(REQ_DIR, f);
    const st = await stat(p);
    const txt = await readFile(p, 'utf8');
    const j = JSON.parse(txt) as { user?: string; model?: string };
    const preview = (j.user ?? '').slice(0, 80).replace(/\s+/g, ' ');
    console.log(`${id}  ${st.mtime.toISOString()}  ${j.model}  ${preview}`);
  }
}

async function show(id: string): Promise<void> {
  const txt = await readFile(join(REQ_DIR, `${id}.json`), 'utf8');
  console.log(txt);
}

async function answer(id: string, content: string): Promise<void> {
  const out = {
    id,
    content,
    ts: new Date().toISOString()
  };
  await writeFile(join(RES_DIR, `${id}.json`), JSON.stringify(out, null, 2), 'utf8');
  console.log(`wrote responses/${id}.json (${content.length} chars)`);
}

if (cmd === 'list') {
  await listPending();
} else if (cmd === 'show' && process.argv[3]) {
  await show(process.argv[3]);
} else if (cmd === 'answer' && process.argv[3] && process.argv[4]) {
  const txt = await readFile(process.argv[4], 'utf8');
  await answer(process.argv[3], txt);
} else if (cmd === 'answer-inline' && process.argv[3]) {
  const stdinTxt = await Bun.stdin.text();
  await answer(process.argv[3], stdinTxt);
} else {
  console.log('usage:');
  console.log('  bun tools/llm-proxy/queue.ts list');
  console.log('  bun tools/llm-proxy/queue.ts show <id>');
  console.log('  bun tools/llm-proxy/queue.ts answer <id> <file>');
  console.log('  cat content.txt | bun tools/llm-proxy/queue.ts answer-inline <id>');
  process.exit(1);
}
