// Evolution layer. Eng review 6A.
//
// Input: profile + new context text (e.g. a fresh standup transcript snippet).
// Output: a JSON Patch list (RFC 6902) plus a human summary, suitable for
// review in the UI before being applied.
//
// Mutations are restricted to EVOLVABLE_PATH_PREFIXES — _meta and identity
// fields (name / dept / role / join_date) are NEVER patched here. Bootstrap
// owns full overwrite; evolution owns incremental update.

import { llmJSON } from '../lib/llm';
import { getState, updateState } from '../lib/agents';
import { appendTimelineEvent } from '../lib/timeline';
import { EVOLVABLE_PATH_PREFIXES, type PersonalAgentProfile, type EvolutionDiff } from '../types/index';

const SYSTEM = `你是一个 personal agent state evolution 助理。
任务：给定一份 personal agent profile 和一段新上下文（晨会片段、Slack 消息片段等），
判断 profile 中哪些字段需要更新，输出 RFC 6902 JSON Patch。

只允许修改这些 path 前缀：
${EVOLVABLE_PATH_PREFIXES.join('\n')}

绝对禁止修改 /_meta 或身份字段（/name /dept /role /join_date）。

只输出 JSON，不要解释，不要 markdown。`;

function userPrompt(profile: PersonalAgentProfile, newContext: string): string {
  return `当前 profile：
${JSON.stringify(profile, null, 2)}

新上下文：
"""
${newContext.slice(0, 4000)}
"""

任务：判断该上下文是否要求更新 profile。如有更新，输出 JSON Patch 操作。

输出 JSON：
{
  "patches": [
    { "op": "replace" | "add" | "remove", "path": "/<allowed-prefix>...", "value": <any> }
  ],
  "human_summary": [
    "<一句中文，每条 patch 一行的摘要>"
  ]
}

如果新上下文没有触发任何 profile 字段变化，输出空 patches 和空 human_summary。
只允许修改：${EVOLVABLE_PATH_PREFIXES.join(' / ')}
不要触碰 /_meta、/name、/dept、/role、/join_date。

只输出 JSON。`;
}

export async function computeEvolutionDiff(
  agentName: string,
  newContext: string,
  signal?: AbortSignal
): Promise<EvolutionDiff> {
  const profile = await getState(agentName);
  const raw = await llmJSON<{ patches?: unknown; human_summary?: unknown }>({
    system: SYSTEM,
    user: userPrompt(profile, newContext),
    signal,
    maxTokens: 1500,
    temperature: 0.3,
    maxRetries: 2
  });

  const patches = sanitizePatches(raw.patches);
  const human_summary =
    Array.isArray(raw.human_summary) && raw.human_summary.every((s) => typeof s === 'string')
      ? (raw.human_summary as string[]).slice(0, 10)
      : [];

  // Annotate each patch with the old value so the UI can render strikethrough.
  const annotated = patches.map((p) => ({
    ...p,
    old: getValueAtPath(profile, p.path)
  }));

  return { agent_name: agentName, patches: annotated, human_summary };
}

export async function applyEvolutionDiff(
  agentName: string,
  diff: EvolutionDiff
): Promise<PersonalAgentProfile> {
  if (diff.patches.length === 0) {
    // Nothing to apply — return current profile.
    return getState(agentName);
  }
  // Strip the `old` annotation before forwarding to fast-json-patch, which
  // doesn't recognize it.
  const cleanPatches = diff.patches.map(({ op, path, value }) => ({ op, path, value }));
  const next = await updateState(agentName, cleanPatches as Parameters<typeof updateState>[1]);
  await appendTimelineEvent({
    ts: new Date().toISOString(),
    type: 'evolution_applied',
    agent_name: agentName,
    summary: `${agentName} 画像更新：${diff.human_summary.join('；').slice(0, 200)}`,
    detail: { patch_count: diff.patches.length }
  });
  return next;
}

function sanitizePatches(raw: unknown): EvolutionDiff['patches'] {
  if (!Array.isArray(raw)) return [];
  const out: EvolutionDiff['patches'] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const p = item as Record<string, unknown>;
    const op = p.op;
    const path = p.path;
    if (typeof op !== 'string' || typeof path !== 'string') continue;
    if (op !== 'add' && op !== 'replace' && op !== 'remove') continue;
    // Hard rule: drop patches whose path doesn't match an allowed prefix.
    const allowed = EVOLVABLE_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
    if (!allowed) {
      console.warn(`[evolution] dropped patch with disallowed path: ${path}`);
      continue;
    }
    out.push({ op: op as 'add' | 'replace' | 'remove', path, value: p.value });
  }
  return out;
}

function getValueAtPath(obj: unknown, path: string): unknown {
  if (!path || path === '/') return obj;
  const parts = path.split('/').slice(1).map(decodeJSONPointer);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      cur = Number.isFinite(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function decodeJSONPointer(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}
