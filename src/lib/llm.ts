// LLM client abstraction.
// Primary: MiniMax (OpenAI-compatible endpoint).
// Fallback: Anthropic Claude Sonnet 4.6.
// Selection at startup based on LLM_PROVIDER env, with runtime fallback on
// MiniMax 5xx / network errors (eng review 3A: never let one provider take
// the demo down).

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type LLMProvider = 'minimax' | 'anthropic' | 'openai_compat';

export interface LLMCallOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  jsonMode?: boolean;
}

export interface LLMStreamOptions extends LLMCallOptions {
  onToken: (token: string) => void;
}

const ACTIVE_PROVIDER: LLMProvider = (process.env.LLM_PROVIDER as LLMProvider) ?? 'minimax';

function getMinimaxClient(): OpenAI {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error('MINIMAX_API_KEY not set in environment');
  return new OpenAI({
    apiKey: key,
    baseURL: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.chat/v1'
  });
}

// Generic OpenAI-compatible provider (DeepSeek, Moonshot, Qwen-DashScope,
// OpenAI direct, OpenRouter, Together, Groq, etc.). Configure via env:
//   OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
function getOpenAICompatClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set in environment');
  return new OpenAI({
    apiKey: key,
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  });
}

async function callOpenAICompat(opts: LLMCallOptions): Promise<string> {
  const client = getOpenAICompatClient();
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const body: Parameters<typeof client.chat.completions.create>[0] = {
    model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user }
    ],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048
  };
  if (opts.jsonMode) {
    (body as unknown as Record<string, unknown>).response_format = { type: 'json_object' };
  }
  const res = (await client.chat.completions.create(
    { ...body, stream: false },
    { signal: opts.signal }
  )) as { choices: Array<{ message?: { content?: string } }> };
  return res.choices[0]?.message?.content ?? '';
}

function getAnthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set in environment');
  return new Anthropic({ apiKey: key });
}

async function callMinimax(opts: LLMCallOptions): Promise<string> {
  const client = getMinimaxClient();
  // MiniMax JSON enforcement notes (docs: platform.minimax.io/docs/api-reference/text-post):
  //   - `response_format` shape is `{type: 'json_schema', json_schema: {name, schema}}`
  //     (NOT OpenAI's `{type: 'json_object'}` — sending that returns 400 / code 2013).
  //   - Per docs, only MiniMax-Text-01 actually ENFORCES the schema. M2.x
  //     models reject the parameter or silently ignore it.
  //   - For M2.x we rely on prompt-level JSON instructions + the tolerant
  //     `tryParseJSON` extractor.
  const model = process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7';
  const body: Parameters<typeof client.chat.completions.create>[0] = {
    model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user }
    ],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048
  };
  if (opts.jsonMode && model === 'MiniMax-Text-01') {
    (body as unknown as Record<string, unknown>).response_format = {
      type: 'json_schema',
      json_schema: { name: 'output', schema: { type: 'object' } }
    };
  }
  // Cast: TS cannot narrow Stream vs ChatCompletion when `stream` is omitted
  // dynamically. We never set `stream: true` on this code path.
  const res = (await client.chat.completions.create(
    { ...body, stream: false },
    { signal: opts.signal }
  )) as { choices: Array<{ message?: { content?: string } }> };
  return res.choices[0]?.message?.content ?? '';
}

async function callAnthropic(opts: LLMCallOptions): Promise<string> {
  const client = getAnthropicClient();
  const res = await client.messages.create(
    {
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 2048
    },
    { signal: opts.signal }
  );
  const block = res.content[0];
  return block?.type === 'text' ? block.text : '';
}

function primaryCaller(): (opts: LLMCallOptions) => Promise<string> {
  if (ACTIVE_PROVIDER === 'minimax') return callMinimax;
  if (ACTIVE_PROVIDER === 'anthropic') return callAnthropic;
  return callOpenAICompat;
}

function fallbackChain(): Array<{ name: string; fn: (o: LLMCallOptions) => Promise<string> }> {
  // Try every other configured provider in turn.
  const out: Array<{ name: string; fn: (o: LLMCallOptions) => Promise<string> }> = [];
  if (ACTIVE_PROVIDER !== 'openai_compat' && process.env.OPENAI_API_KEY) {
    out.push({ name: 'openai_compat', fn: callOpenAICompat });
  }
  if (ACTIVE_PROVIDER !== 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    out.push({ name: 'anthropic', fn: callAnthropic });
  }
  if (ACTIVE_PROVIDER !== 'minimax' && process.env.MINIMAX_API_KEY) {
    out.push({ name: 'minimax', fn: callMinimax });
  }
  return out;
}

export async function llmCall(opts: LLMCallOptions): Promise<string> {
  const primary = primaryCaller();
  try {
    return await primary(opts);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const msg = (err as Error).message ?? String(err);
    const chain = fallbackChain();
    if (chain.length === 0) throw err;
    console.warn(`[llm] ${ACTIVE_PROVIDER} failed:`, msg.slice(0, 200));
    let lastErr: Error = err as Error;
    for (const f of chain) {
      try {
        console.warn(`[llm] falling back to ${f.name}`);
        return await f.fn(opts);
      } catch (e2) {
        lastErr = e2 as Error;
      }
    }
    throw lastErr;
  }
}

async function streamMinimax(opts: LLMStreamOptions): Promise<string> {
  const client = getMinimaxClient();
  let full = '';
  const stream = await client.chat.completions.create(
    {
      model: process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7',
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user }
      ],
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 2048,
      stream: true
    },
    { signal: opts.signal }
  );
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content ?? '';
    if (token) {
      full += token;
      opts.onToken(token);
    }
  }
  return full;
}

async function streamAnthropic(opts: LLMStreamOptions): Promise<string> {
  const client = getAnthropicClient();
  let full = '';
  const stream = await client.messages.stream(
    {
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 2048
    },
    { signal: opts.signal }
  );
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      full += event.delta.text;
      opts.onToken(event.delta.text);
    }
  }
  return full;
}

async function streamOpenAICompat(opts: LLMStreamOptions): Promise<string> {
  const client = getOpenAICompatClient();
  let full = '';
  const stream = await client.chat.completions.create(
    {
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user }
      ],
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 2048,
      stream: true
    },
    { signal: opts.signal }
  );
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content ?? '';
    if (token) {
      full += token;
      opts.onToken(token);
    }
  }
  return full;
}

export async function llmStream(opts: LLMStreamOptions): Promise<string> {
  const primary =
    ACTIVE_PROVIDER === 'minimax'
      ? streamMinimax
      : ACTIVE_PROVIDER === 'anthropic'
        ? streamAnthropic
        : streamOpenAICompat;
  try {
    return await primary(opts);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    console.warn(`[llm] ${ACTIVE_PROVIDER} stream failed:`, (err as Error).message?.slice(0, 200));
    // Fallback: non-stream call via llmCall (which has the full chain).
    const result = await llmCall(opts);
    opts.onToken(result);
    return result;
  }
}

// Try to extract a JSON object from a model response. Tolerant to:
//   - <think>...</think> reasoning blocks (M2.7 / DeepSeek-style)
//   - ```json fences
//   - prose before/after the JSON
// Returns null if no parseable JSON found.
export function tryParseJSON<T = unknown>(text: string): T | null {
  if (!text) return null;
  // 1a. Strip closed M2.7 / DeepSeek reasoning blocks.
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 1b. If the model emitted an unclosed <think> (e.g. truncated by max_tokens),
  //     drop everything from the opening tag onward — there is no answer to
  //     extract. Caller will retry with a higher budget.
  const openOnly = cleaned.indexOf('<think>');
  if (openOnly !== -1) cleaned = cleaned.slice(0, openOnly);
  // 2. Prefer fenced ```json block if present (likely the answer).
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1];
  // 3. Find the largest balanced JSON object/array. We scan for the first
  //    top-level `{` or `[` and try to JSON.parse from there. If that fails,
  //    we walk back to the last matching close brace/bracket and retry.
  const start = cleaned.search(/[{[]/);
  if (start === -1) return null;
  const startCh = cleaned[start];
  const endCh = startCh === '{' ? '}' : ']';
  // Walk from the LAST endCh backward — handles cases where the model emitted
  // multiple JSON-ish fragments and we want the last (final) one.
  for (let end = cleaned.lastIndexOf(endCh); end > start; end = cleaned.lastIndexOf(endCh, end - 1)) {
    const slice = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(slice) as T;
    } catch {
      // try a smaller slice
    }
    if (end <= start) break;
  }
  return null;
}

// Small helper: call llmCall + parse JSON + retry up to N times if parse fails.
export async function llmJSON<T = unknown>(
  opts: LLMCallOptions & { maxRetries?: number }
): Promise<T> {
  const max = opts.maxRetries ?? 2;
  let lastErr: string = '';
  for (let i = 0; i <= max; i++) {
    const text = await llmCall({ ...opts, jsonMode: true });
    const parsed = tryParseJSON<T>(text);
    if (parsed !== null) return parsed;
    lastErr = `attempt ${i + 1}: failed to parse JSON from response (first 200 chars): ${text.slice(0, 200)}`;
    console.warn(`[llm] ${lastErr}`);
  }
  throw new Error(`llmJSON failed after ${max + 1} attempts. ${lastErr}`);
}

export function activeProvider(): LLMProvider {
  return ACTIVE_PROVIDER;
}

// Strip M2.7 / DeepSeek reasoning blocks from human-facing prose output.
// Used by PMA synthesis (rationale field) — the user sees this in the UI,
// they don't want to see chain-of-thought.
export function stripThinkBlocks(text: string): string {
  if (!text) return '';
  // Remove balanced <think>...</think>.
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // If an unclosed <think> remains, drop everything from it onward.
  const open = out.indexOf('<think>');
  if (open !== -1) out = out.slice(0, open);
  // Trim leading whitespace left over.
  return out.trim();
}
