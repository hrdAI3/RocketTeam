/**
 * Helpers for detecting / handling "ghost user_id" forms produced by the
 * Matrix-Riven uploader when `git config user.email` is unset on a client
 * machine.
 *
 * Matrix-Riven's `getUserId()` (packages/shared/src/identity.ts) tries
 * `git config user.email` first and falls back to `${unix_user}@${hostname}`
 * (with an optional `.local` mDNS suffix on macOS). Pre-PR #3 on the realtime
 * path that fallback ALSO fired even when `~/.riven/digital-twin.json`
 * carried a real `identity.user_id` — which produced same-machine pairs
 * where the Stop hook tagged transcripts with the real email and the
 * realtime hook tagged cc-status snapshots with the hostname form.
 *
 * Two categories of ghost we see on the collector:
 *
 *   1. **Redundant ghost** — a hostname-form user_id whose session_ids are
 *      ALSO present (with full transcripts) under a real-email user_id on
 *      the same machine. The ghost only carries cc-status fragments; the
 *      paired real-email user has the bytes. The team extractor should
 *      skip these to avoid double-counting on the workboard.
 *
 *   2. **Sole-identity ghost** — a hostname-form user_id that IS the
 *      person's only upload identity (their `git config user.email` is
 *      genuinely never set; they're not running `riven digital-twin login`
 *      either). Their transcripts only exist under this id. Must be
 *      preserved.
 *
 * The redundant-vs-sole distinction is made by the extractor at sync time
 * by cross-referencing session_ids against the global non-ghost transcript
 * index — see `syncCcSessions` in `cc_session.ts`.
 */

/**
 * Email TLDs we accept as "looks like a real email" — empirically observed
 * across the team's user list. Add more as needed; rule of thumb is "domain
 * has a top-level public suffix" — but a hand-maintained allowlist is more
 * predictable than `psl`-style heuristics for this small team.
 */
const REAL_EMAIL_TLDS = [
  '.com', '.cn', '.io', '.org', '.net', '.dev', '.ai', '.co',
  '.app', '.me', '.us', '.uk', '.eu', '.gov', '.edu',
];

/**
 * Hostname suffixes that strongly imply this is NOT a real email — even
 * if the suffix happens to contain a dot (Mac mDNS `.local` is the common
 * case here).
 */
const HOSTNAME_SUFFIXES = ['.local'];

/**
 * Return true when `userId` matches the `${unix_user}@${hostname}` fallback
 * shape from Matrix-Riven's `getUserId()` — i.e. it does NOT look like a
 * real email.
 *
 *   isGhostUserId('hrdai@qq.com')                    → false (real email)
 *   isGhostUserId('horton2048@users.noreply.github.com') → false
 *   isGhostUserId('19723@hut')                       → true  (bare hostname)
 *   isGhostUserId('blink@BlinkdeMacBook-Air.local')  → true  (mDNS .local)
 *   isGhostUserId('lv@lvjiawendeMacBook-Air.local')  → true
 *
 * Note: this is a SHAPE test, not a "this user is fake" judgment. A
 * sole-identity ghost (someone whose only upload identity is the
 * hostname form) STILL matches — the redundant-vs-sole judgment is made
 * downstream by the session-id cross-reference.
 */
export function isGhostUserId(userId: string): boolean {
  const at = userId.lastIndexOf('@');
  if (at < 0) return false;
  const host = userId.slice(at + 1);
  if (host.length === 0) return false;
  // Explicit hostname suffix → ghost.
  for (const suf of HOSTNAME_SUFFIXES) {
    if (host.endsWith(suf)) return true;
  }
  // Real email TLD → real.
  const hostLower = host.toLowerCase();
  for (const tld of REAL_EMAIL_TLDS) {
    if (hostLower.endsWith(tld)) return false;
  }
  // No dot at all → bare hostname like `hut` → ghost.
  if (!host.includes('.')) return true;
  // Has a dot but no known TLD → unknown, lean conservative (treat as real
  // so we don't accidentally drop a legitimate user with an exotic TLD).
  return false;
}

/**
 * Strip the trailing `.cc-status` suffix that Matrix-Riven appends to
 * cc-status-snapshot session entries. The canonical session id is the
 * bare UUID/ULID; transcript and cc-status files for the same CC session
 * share that id with different suffix:
 *
 *   <uuid>.jsonl              → transcript
 *   <uuid>.cc-status.jsonl    → cc-status snapshot
 *
 * The `/api/sessions` listing exposes the basename-minus-extension as
 * `id`, so we see two entries with different `id` values for the same
 * underlying session. Use this helper to canonicalize.
 */
export function canonicalSessionId(rawId: string): string {
  if (rawId.endsWith('.cc-status')) {
    return rawId.slice(0, -'.cc-status'.length);
  }
  return rawId;
}
