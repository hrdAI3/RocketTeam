// Task persistence. File-based per-task JSON for demo simplicity.
// Postgres v1 (TODOS.md item 2).

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS, taskPath } from './paths';
import { atomicWriteJSON } from '../_lib/file-io';
import type { Task } from '../types/index';

export async function saveTask(task: Task): Promise<void> {
  await atomicWriteJSON(taskPath(task.id), task);
}

export async function getTask(id: string): Promise<Task | null> {
  try {
    const raw = await fs.readFile(taskPath(id), 'utf8');
    return JSON.parse(raw) as Task;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listTasks(): Promise<Task[]> {
  let files: string[];
  try {
    files = await fs.readdir(PATHS.tasks);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const tasks: Task[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      const raw = await fs.readFile(join(PATHS.tasks, f), 'utf8');
      tasks.push(JSON.parse(raw));
    } catch {
      // Skip corrupted files.
    }
  }
  // Newest first.
  tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return tasks;
}

export function newTaskId(): string {
  // TASK-<timestamp-secs>-<rand>. Sortable, human-readable, no collisions
  // on a single-process demo server.
  const t = Math.floor(Date.now() / 1000);
  const r = Math.random().toString(36).slice(2, 6);
  return `TASK-${t}-${r}`;
}
