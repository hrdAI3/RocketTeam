// Shared file I/O helpers. Single source for atomic JSON writes.
// Replaces three duplicated implementations in lib/agents.ts, lib/tasks.ts,
// and sim/runner.ts (M0 of BACKEND-REDESIGN.md §13).

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

// Atomic write: write to a uniquely-named temp file in the same directory,
// then rename onto the target. crypto.randomBytes gives collision-free
// suffixes even when two writers fire in the same millisecond from the
// same process (the previous `${pid}.${Date.now()}` scheme could collide).
export async function atomicWriteJSON(path: string, data: unknown): Promise<void> {
  await ensureDir(path);
  const suffix = crypto.randomBytes(8).toString('hex');
  const tmp = `${path}.tmp.${suffix}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
