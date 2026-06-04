// Tiny in-memory cache for expensive read-only GET routes, with
// stale-while-revalidate (SWR).
//
// Several dashboard endpoints stream the 500MB+ event log or hit external
// services on every page load (10-30s). None needs to be real-time fresh for
// a glance. So we memoize per route:
//
//   - FRESH  (age < ttl)        → return cached, do nothing.
//   - STALE  (ttl ≤ age < hard) → return cached INSTANTLY, kick a background
//                                  refresh. The user never waits; the next
//                                  hit gets the newer value. This is what
//                                  kills "cold after idle" — once warmed, a
//                                  page open is always instant.
//   - EXPIRED (age ≥ hard) or absent → await the producer (true cold; only
//                                  the very first load, or after `hard`ms of
//                                  zero traffic AND zero prewarm).
//
// The background monitor calls prewarm() on a timer, which touches each key
// inside the stale window, so the cache is kept permanently warm and the
// EXPIRED branch is effectively never hit in normal use.
//
// Usage:
//   export const GET = () => memoTTL('cc-source', 90_000, async () => {...});

interface Entry {
  at: number;
  value: Promise<unknown>;
  resolved: boolean;     // has `value` settled (so we can serve it as "stale" safely)
  refreshing: boolean;   // a background revalidate is already in flight
}
const store = new Map<string, Entry>();

// How long a stale value may still be served while a refresh runs in the
// background. Past at + ttl + STALE_GRACE we treat the entry as fully expired
// and block on a fresh producer. Generous (1h) because a stale dashboard
// glance is fine; correctness on mutation is handled by bustTTL.
const STALE_GRACE_MS = 60 * 60 * 1000;

function runProducer<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const p = producer()
    .then((v) => {
      const e = store.get(key);
      if (e && e.value === (p as unknown)) e.resolved = true;
      return v;
    })
    .catch((err) => {
      // Drop on failure so the next call retries instead of caching a rejection.
      const e = store.get(key);
      if (e && e.value === (p as unknown)) store.delete(key);
      throw err;
    });
  return p;
}

export async function memoTTL<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);

  if (hit) {
    const age = now - hit.at;
    if (age < ttlMs) {
      // Fresh.
      return hit.value as Promise<T>;
    }
    if (age < ttlMs + STALE_GRACE_MS && hit.resolved) {
      // Stale but usable: serve immediately, revalidate in background (once).
      if (!hit.refreshing) {
        hit.refreshing = true;
        const fresh = runProducer(key, producer);
        void fresh
          .then((v) => {
            store.set(key, { at: Date.now(), value: Promise.resolve(v), resolved: true, refreshing: false });
          })
          .catch(() => {
            // failure already dropped the entry in runProducer; nothing to do
          });
      }
      return hit.value as Promise<T>;
    }
    // Fully expired — fall through to a blocking rebuild.
  }

  // Cold (absent or expired): block on the producer, share the in-flight
  // promise with concurrent callers.
  const value = runProducer(key, producer);
  store.set(key, { at: now, value, resolved: false, refreshing: false });
  return value as Promise<T>;
}

// Manual invalidation — call after a mutation that should be reflected
// immediately (archiving a project busts the workboard cache, etc.). Removes
// the entry entirely so the next read does a true (blocking) rebuild.
export function bustTTL(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
