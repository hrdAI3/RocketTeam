// Core business library. The 4 functions below are the canonical surface
// for all personal-agent operations. MCP server (future) and Next.js API
// routes both import these directly. No protocol-layer logic here.
// Eng review 2A.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as jsonpatch from 'fast-json-patch';
import { agentPath, PATHS } from './paths';
import { withMutex } from './mutex';
import { llmCall } from './llm';
import { atomicWriteJSON } from '../_lib/file-io';
import {
  type PersonalAgentProfile,
  type AgentResponse,
  EVOLVABLE_PATH_PREFIXES,
  ENERGY_LEVELS,
  SCHEMA_VERSION
} from '../types/index';
import { personalAgentSystemPrompt, askAgentUserPrompt } from '../pma/system_prompts';

export async function listAgents(): Promise<string[]> {
  try {
    const files = await fs.readdir(PATHS.agents);
    return files
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function getState(name: string): Promise<PersonalAgentProfile> {
  const path = agentPath(name);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Agent not found: ${name}`);
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as PersonalAgentProfile;
  } catch {
    throw new Error(`Profile JSON corrupted for ${name}. Run /api/bootstrap to regenerate.`);
  }
}

// Validate that every patch path touches only allowed top-level fields.
// Eng review 6A hard rule: _meta paths can never be mutated by external input.
function validatePatchPaths(patches: jsonpatch.Operation[]): void {
  for (const p of patches) {
    const ok = EVOLVABLE_PATH_PREFIXES.some((prefix) => p.path === prefix || p.path.startsWith(prefix + '/'));
    if (!ok) {
      throw new Error(`Patch path not allowed: ${p.path}. Allowed prefixes: ${EVOLVABLE_PATH_PREFIXES.join(', ')}`);
    }
  }
}

// Cap memory arrays to prevent unbounded growth. Older entries live forever in
// team/timeline.jsonl (audit trail). v2 schema has moved memory references onto
// recent_overrides / recent_praises / recent_objections.
const MEMORY_CAP = 20;

function trimAndNormalize(profile: PersonalAgentProfile): PersonalAgentProfile {
  const next = { ...profile };
  for (const key of ['recent_overrides', 'recent_praises', 'recent_objections'] as const) {
    const arr = next[key];
    if (Array.isArray(arr) && arr.length > MEMORY_CAP) {
      next[key] = arr.slice(-MEMORY_CAP);
    }
  }
  if (next.energy && !ENERGY_LEVELS.includes(next.energy.current)) {
    next.energy = { ...next.energy, current: 'unknown' };
  }
  return next;
}

export async function updateState(
  name: string,
  patches: jsonpatch.Operation[]
): Promise<PersonalAgentProfile> {
  validatePatchPaths(patches);
  return withMutex(`agent:${name}`, async () => {
    const current = await getState(name);
    const result = jsonpatch.applyPatch(structuredClone(current), patches, true, false);
    const next = trimAndNormalize(result.newDocument as PersonalAgentProfile);
    next._meta = {
      ...current._meta,
      evolution_count: current._meta.evolution_count + 1
    };
    await atomicWriteJSON(agentPath(name), next);
    return next;
  });
}

export async function writeProfile(profile: PersonalAgentProfile): Promise<void> {
  // Used by bootstrap to first-write a profile. Bypasses the patch path
  // validator because bootstrap is the canonical writer of the full document.
  await withMutex(`agent:${profile.name}`, async () => {
    profile._meta.schema_version = SCHEMA_VERSION;
    await atomicWriteJSON(agentPath(profile.name), trimAndNormalize(profile));
  });
}

export async function deleteAllAgents(): Promise<number> {
  // Used by /api/bootstrap with `clear=true` to support the demo's
  // "watch agents emerge from empty" moment.
  let count = 0;
  try {
    const files = await fs.readdir(PATHS.agents);
    for (const f of files) {
      if (f.endsWith('.json')) {
        await fs.unlink(join(PATHS.agents, f));
        count++;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return count;
}

// Ask a personal agent a question, grounded in its current state.
// Returns structured AgentResponse. On timeout / LLM failure, returns a
// fallback response (eng review 3A) so the PMA can still synthesize.
export async function askAgent(
  name: string,
  question: string,
  signal?: AbortSignal
): Promise<AgentResponse> {
  let profile: PersonalAgentProfile;
  try {
    profile = await getState(name);
  } catch (err) {
    return {
      agent_name: name,
      capability_fit: null,
      load_fit: null,
      reason: `Agent state unavailable: ${(err as Error).message}`,
      fallback: true
    };
  }
  try {
    const text = await llmCall({
      system: personalAgentSystemPrompt(profile),
      user: askAgentUserPrompt(question),
      signal,
      // M2.7 reasoning eats most of the budget. Final JSON is small but
      // think block is large. 4000 leaves room for both.
      maxTokens: 4000,
      temperature: 0.5
    });
    // Expect JSON, but be tolerant.
    const obj = extractAgentResponseJSON(text);
    if (!obj) {
      return {
        agent_name: name,
        capability_fit: null,
        load_fit: null,
        reason: 'agent did not produce a valid structured response',
        fallback: true
      };
    }
    return {
      agent_name: name,
      capability_fit: clampScore(obj.capability_fit),
      load_fit: clampScore(obj.load_fit),
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 600) : '',
      fallback: false
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return {
        agent_name: name,
        capability_fit: null,
        load_fit: null,
        reason: 'agent did not respond in time (timeout)',
        fallback: true
      };
    }
    return {
      agent_name: name,
      capability_fit: null,
      load_fit: null,
      reason: `agent call failed: ${(err as Error).message}`,
      fallback: true
    };
  }
}

function clampScore(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function extractAgentResponseJSON(text: string): { capability_fit?: unknown; load_fit?: unknown; reason?: unknown } | null {
  // Strip M2.7 reasoning blocks first, then look for JSON.
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const openOnly = cleaned.indexOf('<think>');
  if (openOnly !== -1) cleaned = cleaned.slice(0, openOnly);
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : cleaned;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  // Walk back from last '}' until we find a parseable slice.
  for (let end = candidate.lastIndexOf('}'); end > start; end = candidate.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try smaller
    }
    if (end <= start) break;
  }
  return null;
}
