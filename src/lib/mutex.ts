// Per-key in-process mutex with bounded LRU storage.
// Protects against concurrent updateState calls for the same agent racing
// on read-modify-write of profile JSON files. Eng review 4A: combined with
// atomic file write (.tmp + rename) gives safety on a single-process server.
//
// M0 hardening: the mutex map is now a bounded LRU. The previous unbounded
// Map would accumulate one entry per distinct key forever, causing slow
// memory growth in long-running servers. LRU(MAX_KEYS) caps it; evicted
// entries simply get a fresh mutex on next acquisition (safe because
// eviction only happens for keys with no in-flight holder — async-mutex
// keeps the locked instance reachable through its closure).

import { Mutex } from 'async-mutex';

const MAX_KEYS = 1000;

class LRU<K, V> {
  private readonly map = new Map<K, V>();
  constructor(
    private readonly capacity: number,
    private readonly canEvict?: (key: K, value: V) => boolean
  ) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(`LRU capacity must be >= 1, got ${capacity}`);
    }
  }
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      // Find the oldest entry that the caller is willing to evict. Skipping
      // pinned entries protects locking invariants when an evictee is still
      // held — we'd otherwise hand a fresh mutex to the next caller and race.
      let evicted = false;
      for (const [k, v] of this.map) {
        if (!this.canEvict || this.canEvict(k, v)) {
          this.map.delete(k);
          evicted = true;
          break;
        }
      }
      // If every entry is pinned, accept the over-cap state rather than
      // breaking the invariant. Cap will recover as locks release.
      if (!evicted) break;
    }
  }
}

const mutexes = new LRU<string, Mutex>(MAX_KEYS, (_k, m) => !m.isLocked());

export function getMutex(key: string): Mutex {
  let m = mutexes.get(key);
  if (!m) {
    m = new Mutex();
    mutexes.set(key, m);
  }
  return m;
}

export async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return getMutex(key).runExclusive(fn);
}
