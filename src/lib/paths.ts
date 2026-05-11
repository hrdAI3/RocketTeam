import { existsSync } from 'node:fs';
import { resolve, join, isAbsolute, normalize, sep } from 'node:path';

// All confidential runtime data lives under team/private/. team/private.example/
// is a public skeleton with placeholders so a fresh clone still boots.
//
// Resolution order:
//   1. TEAM_PRIVATE env var (absolute or relative to CWD) — explicit override
//   2. ./private if it exists at startup
//   3. ./private.example fallback (committed placeholders)
//
// existsSync runs once at module load; switching roots later requires restart.
function resolvePrivateRoot(): string {
  const override = process.env.TEAM_PRIVATE;
  if (override) return resolve(override);
  const real = resolve('./private');
  if (existsSync(real)) return real;
  return resolve('./private.example');
}

const PRIVATE_ROOT = resolvePrivateRoot();

export const PATHS = {
  root: PRIVATE_ROOT,
  agents: resolve(process.env.AGENTS_DIR ?? join(PRIVATE_ROOT, 'agents')),
  tasks: resolve(process.env.TASKS_DIR ?? join(PRIVATE_ROOT, 'tasks')),
  timeline: resolve(process.env.TIMELINE_FILE ?? join(PRIVATE_ROOT, 'timeline.jsonl')),
  context: resolve(process.env.CONTEXT_DIR ?? join(PRIVATE_ROOT, 'context')),
  contextMeeting: resolve(process.env.CONTEXT_DIR ?? join(PRIVATE_ROOT, 'context'), 'meeting'),
  contextOrg: resolve(process.env.CONTEXT_DIR ?? join(PRIVATE_ROOT, 'context'), 'org'),
  configs: resolve(join(PRIVATE_ROOT, 'configs')),
  resources: resolve(join(PRIVATE_ROOT, 'resources')),
  simReplays: resolve(join(PRIVATE_ROOT, 'sim-replays'))
} as const;

// safeJoin: join `name` onto `base` and verify the result still lives inside
// `base`. Rejects path traversal (..), absolute paths, null bytes, backslashes,
// and any resolved path that escapes the base directory. Use whenever a path
// component originates from user / external input.
export function safeJoin(base: string, name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('safeJoin: name must be a non-empty string');
  }
  if (name.includes('\0')) {
    throw new Error('safeJoin: null byte in name');
  }
  if (name.includes('\\')) {
    throw new Error(`safeJoin: backslash not allowed in name: ${name}`);
  }
  if (isAbsolute(name)) {
    throw new Error(`safeJoin: absolute path not allowed: ${name}`);
  }
  const baseAbs = resolve(base);
  const joined = resolve(baseAbs, normalize(name));
  if (joined !== baseAbs && !joined.startsWith(baseAbs + sep)) {
    throw new Error(`safeJoin: path escapes base: ${name}`);
  }
  return joined;
}

export function agentPath(name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid agent name: ${name}`);
  }
  return safeJoin(PATHS.agents, `${name}.json`);
}

export function taskPath(id: string): string {
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Invalid task id: ${id}`);
  }
  return safeJoin(PATHS.tasks, `${id}.json`);
}
