// CC SESSIONS extractor.
// Pulls jsonl files from http://192.168.22.88:8933 (Matrix-Riven Collector),
// parses Claude Code's real session schema, and emits typed events.
//
// Endpoint contract (probed 2026-05-11):
//   GET /api/users                             → { users: string[] }
//   GET /api/dates?user=<email>                → { dates: ["YYYY-MM-DD"] }
//   GET /api/sessions?user=<email>&date=<d>    → { sessions: [{id, ext, size, mtime}] }
//   GET /api/file?user=<email>&date=<d>&id=<sid>&ext=<jsonl> → raw file content
//
// Real CC jsonl line shapes encountered:
//   {type: 'last-prompt' | 'permission-mode' | 'worktree-state', ...}  — control
//   {type: 'attachment', attachment: {hookName, hookEvent, ...}, ...}  — hooks
//   {type: 'user',      message: {role: 'user',      content: [...]}, ...}
//   {type: 'assistant', message: {role: 'assistant', content: [...], usage: {...}}}
//   {type: 'system',    subtype: 'stop_hook_summary' | 'turn_duration', ...}
//
// Every assistant content item with type === 'tool_use' is a tool call.
// Defensive: anything we cannot parse falls back to cc.raw_blob, never throws.

import { appendEvents, readSyncState, writeSyncState } from '../lib/events';
import { resolveOrUnknown } from '../lib/identity';
import { isGhostUserId, canonicalSessionId } from '../lib/ghost_user';
import type { NewEvent } from '../lib/events';

const COLLECTOR_BASE =
  process.env.CC_COLLECTOR_BASE ?? 'http://192.168.22.88:8933';

// Stuck signal patterns. v0 was too broad — matched markdown templates and
// status reports that contained literal "BLOCKED" or "卡住" tokens. v1 narrows
// to first-person attestations: the speaker must be saying they themselves
// are stuck right now. Only checked against USER messages, not assistant text
// (assistants explain templates that mention these words).
const STUCK_PATTERNS: RegExp[] = [
  /(?:^|[\s，,。.；;])(?:我|咱)\s*(?:这边|目前|现在|刚刚|正)?\s*(?:被|因|给)?\s*(?:卡(?:住|在|了)|阻塞|卡死|挡)/,
  /(?:^|[\s，,。.；;])(?:我|咱)\s*(?:这边|目前|现在)?\s*等(?:运维|审核|批准|接入|权限|开通|配置|对方|他)/,
  /(?:^|[\s，,。.；;])(?:我|咱)\s*(?:这边|现在)?\s*(?:还)?\s*(?:拿|要|想)?\s*不到\s*(?:权限|文件|数据|结果)/,
  /(?:^|[\s，,。.；;])(?:我|咱)\s*(?:还)?\s*没\s*(?:权限|开通|授权|开放)/,
  /(?:^|[\s，,。.；;])(?:迟迟|一直)\s*(?:没|未)\s*(?:给|批|响应|回复)/,
  /\b(?:i\s*[''’]?\s*m|i\s*am)\s+(?:stuck|blocked|waiting\s+on)\b/i,
  /\bcannot\s+(?:access|connect|authenticate|login)\b/i,
  /\bpermission\s+denied\b(?![^.]*\bdocs?\b)/i
];

const SYNC_STATE_KEY = 'cc_session';

interface SyncState {
  users: Record<
    string,
    {
      lastSyncedMtime?: string; // ISO
    }
  >;
}

interface SessionFileRef {
  id: string;
  ext: string;
  size: number;
  mtime: string;
}

interface FetchSessionsResult {
  sessions: SessionFileRef[];
}

interface FetchDatesResult {
  dates: string[];
}

interface FetchUsersResult {
  users: string[];
}

async function http<T>(path: string): Promise<T> {
  const url = `${COLLECTOR_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`collector ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

async function httpText(path: string): Promise<string> {
  const url = `${COLLECTOR_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`collector ${res.status} for ${path}`);
  return await res.text();
}

export async function listUsers(): Promise<string[]> {
  const r = await http<FetchUsersResult>('/api/users');
  return r.users ?? [];
}

export async function listDates(email: string): Promise<string[]> {
  const r = await http<FetchDatesResult>(
    `/api/dates?user=${encodeURIComponent(email)}`
  );
  return r.dates ?? [];
}

export async function listSessions(email: string, date: string): Promise<SessionFileRef[]> {
  const r = await http<FetchSessionsResult>(
    `/api/sessions?user=${encodeURIComponent(email)}&date=${encodeURIComponent(date)}`
  );
  return r.sessions ?? [];
}

export async function fetchSessionRaw(
  email: string,
  date: string,
  id: string,
  ext: string
): Promise<string> {
  return httpText(
    `/api/file?user=${encodeURIComponent(email)}&date=${encodeURIComponent(date)}&id=${encodeURIComponent(id)}&ext=${encodeURIComponent(ext)}`
  );
}

export interface ParsedSession {
  events: NewEvent[];
  meta: {
    sessionId: string;
    startedAt: string | null;
    endedAt: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    toolCounts: Record<string, number>;
    userMessages: number;
    assistantMessages: number;
    cwd: string | null;
    gitBranch: string | null;
    model: string | null;
  };
}

export function parseSession(
  email: string,
  date: string,
  fileId: string,
  ownerName: string,
  rawJsonl: string
): ParsedSession {
  const events: NewEvent[] = [];
  const meta: ParsedSession['meta'] = {
    sessionId: fileId,
    startedAt: null,
    endedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    toolCounts: {},
    userMessages: 0,
    assistantMessages: 0,
    cwd: null,
    gitBranch: null,
    model: null
  };

  const lines = rawJsonl.split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      events.push({
        source: 'cc_session',
        type: 'cc.raw_blob',
        subject: { kind: 'session', ref: fileId },
        actor: ownerName,
        evidence: { fields: { reason: 'invalid_json', sample: line.slice(0, 200) } },
        raw_ref: `${email}/${date}/${fileId}`
      });
      continue;
    }

    const type = typeof row.type === 'string' ? row.type : '';
    const ts = typeof row.timestamp === 'string' ? (row.timestamp as string) : null;
    if (ts) {
      if (!meta.startedAt || ts < meta.startedAt) meta.startedAt = ts;
      if (!meta.endedAt || ts > meta.endedAt) meta.endedAt = ts;
    }
    if (typeof row.cwd === 'string' && !meta.cwd) meta.cwd = row.cwd as string;
    if (typeof row.gitBranch === 'string' && !meta.gitBranch) {
      meta.gitBranch = row.gitBranch as string;
    }

    switch (type) {
      case 'user': {
        meta.userMessages++;
        const text = extractUserText(row);
        // Only check stuck signals on user messages — assistant content often
        // contains templates explaining what "BLOCKED" / "stuck" mean,
        // generating noise rather than leader-actionable signal.
        if (text && !looksLikeToolResult(row)) {
          checkStuck(text, row, fileId, ownerName, email, date, events);
        }
        break;
      }
      case 'assistant': {
        meta.assistantMessages++;
        const message = row.message as Record<string, unknown> | undefined;
        if (message && typeof message === 'object') {
          if (typeof message.model === 'string' && !meta.model) {
            meta.model = message.model as string;
          }
          const usage = message.usage as Record<string, unknown> | undefined;
          if (usage) {
            meta.inputTokens += toNum(usage.input_tokens);
            meta.outputTokens += toNum(usage.output_tokens);
            meta.cacheReadTokens += toNum(usage.cache_read_input_tokens);
            meta.cacheCreateTokens += toNum(usage.cache_creation_input_tokens);
          }
          const content = message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                typeof block === 'object' &&
                block &&
                (block as Record<string, unknown>).type === 'tool_use'
              ) {
                const blockObj = block as Record<string, unknown>;
                const toolName =
                  typeof blockObj.name === 'string' ? (blockObj.name as string) : 'unknown';
                meta.toolCounts[toolName] = (meta.toolCounts[toolName] ?? 0) + 1;
                // Capture an info-dense excerpt per tool for downstream
                // attribution / anomaly / work_summary. Without this every
                // non-Bash tool call landed empty (栾蕊加's 18k events: 100%
                // empty quotes despite 50 WebFetch + 47 WebSearch + 43 Write +
                // 47 TaskUpdate — LLM had to guess from tool names alone and
                // fabricated "Matrix-Riven 信息采集" because the name vibes).
                // Caps each capture at ~500 chars to bound events.jsonl growth;
                // per-tool slicing picks the highest-signal field.
                const input = blockObj.input as Record<string, unknown> | undefined;
                const str = (v: unknown): string => (typeof v === 'string' ? v : '');
                let commandText: string | undefined;
                if (input) {
                  switch (toolName) {
                    case 'Bash':
                      commandText = str(input.command).slice(0, 500);
                      break;
                    case 'WebFetch':
                      commandText = `${str(input.url)} | ${str(input.prompt)}`.slice(0, 500);
                      break;
                    case 'WebSearch':
                      commandText = str(input.query).slice(0, 500);
                      break;
                    case 'Read':
                    case 'NotebookEdit':
                      commandText = str(input.file_path).slice(0, 500);
                      break;
                    case 'Write':
                    case 'Edit':
                      commandText = `${str(input.file_path)} | ${str(input.new_string).slice(0, 200)}`.slice(0, 500);
                      break;
                    case 'Glob':
                      commandText = `${str(input.pattern)} in ${str(input.path)}`.slice(0, 500);
                      break;
                    case 'Grep':
                      commandText = `${str(input.pattern)} in ${str(input.path)} (${str(input.glob)})`.slice(0, 500);
                      break;
                    case 'TodoWrite': {
                      const todos = input.todos;
                      if (Array.isArray(todos)) {
                        commandText = todos
                          .map((t) => str((t as Record<string, unknown>)?.content))
                          .filter(Boolean)
                          .join(' | ')
                          .slice(0, 500);
                      }
                      break;
                    }
                    case 'TaskCreate':
                    case 'TaskUpdate':
                      // Subagent tool — `description` is short, `prompt` is the
                      // actual instruction (highest signal). Concat both.
                      commandText = `${str(input.description) || str(input.subagent_type)} | ${str(input.prompt)}`.slice(0, 500);
                      break;
                  }
                  if (commandText) commandText = commandText.replace(/\s+/g, ' ').trim();
                  if (commandText === '') commandText = undefined;
                }
                events.push({
                  ts: ts ?? undefined,
                  source: 'cc_session',
                  type: 'cc.tool_called',
                  subject: { kind: 'agent', ref: ownerName },
                  actor: ownerName,
                  evidence: {
                    quote: commandText,
                    fields: {
                      tool: toolName,
                      sessionId: fileId,
                      cwd: meta.cwd ?? undefined,
                      gitBranch: meta.gitBranch ?? undefined
                    }
                  },
                  raw_ref: `${email}/${date}/${fileId}`
                });
              }
              // Assistant text blocks intentionally NOT checked for stuck —
              // assistants quote templates and self-report scaffolding that
              // would otherwise trip the regex on every other turn.
            }
          }
        }
        break;
      }
      case 'attachment':
      case 'last-prompt':
      case 'permission-mode':
      case 'worktree-state':
      case 'system':
        // Control / hook frames; ignored for now.
        break;
      default:
        // Unknown shape — log raw blob once for forensics.
        events.push({
          ts: ts ?? undefined,
          source: 'cc_session',
          type: 'cc.raw_blob',
          subject: { kind: 'session', ref: fileId },
          actor: ownerName,
          evidence: { fields: { type, sample: line.slice(0, 200) } },
          raw_ref: `${email}/${date}/${fileId}`
        });
    }
  }

  // Lifecycle bookends + aggregate token usage.
  if (meta.startedAt) {
    events.unshift({
      ts: meta.startedAt,
      source: 'cc_session',
      type: 'cc.session_started',
      subject: { kind: 'agent', ref: ownerName },
      actor: ownerName,
      evidence: {
        fields: {
          sessionId: fileId,
          cwd: meta.cwd ?? undefined,
          gitBranch: meta.gitBranch ?? undefined,
          model: meta.model ?? undefined
        }
      },
      raw_ref: `${email}/${date}/${fileId}`
    });
  }
  if (meta.endedAt) {
    events.push({
      ts: meta.endedAt,
      source: 'cc_session',
      type: 'cc.session_ended',
      subject: { kind: 'agent', ref: ownerName },
      actor: ownerName,
      evidence: {
        fields: {
          sessionId: fileId,
          userMessages: meta.userMessages,
          assistantMessages: meta.assistantMessages,
          toolCounts: meta.toolCounts
        }
      },
      raw_ref: `${email}/${date}/${fileId}`
    });
    events.push({
      ts: meta.endedAt,
      source: 'cc_session',
      type: 'cc.token_usage',
      subject: { kind: 'agent', ref: ownerName },
      actor: ownerName,
      evidence: {
        fields: {
          sessionId: fileId,
          input_tokens: meta.inputTokens,
          output_tokens: meta.outputTokens,
          cache_read_input_tokens: meta.cacheReadTokens,
          cache_creation_input_tokens: meta.cacheCreateTokens,
          model: meta.model ?? undefined
        }
      },
      raw_ref: `${email}/${date}/${fileId}`
    });
  }

  return { events, meta };
}

function looksLikeToolResult(row: Record<string, unknown>): boolean {
  const message = row.message as Record<string, unknown> | undefined;
  if (!message) return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (typeof block === 'object' && block) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result') return true;
    }
  }
  return false;
}

function extractUserText(row: Record<string, unknown>): string {
  const message = row.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

function checkStuck(
  text: string,
  row: Record<string, unknown>,
  fileId: string,
  ownerName: string,
  email: string,
  date: string,
  out: NewEvent[]
): void {
  for (const re of STUCK_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const quote = excerptAround(text, m.index, 100);
      out.push({
        ts: typeof row.timestamp === 'string' ? (row.timestamp as string) : undefined,
        source: 'cc_session',
        type: 'cc.stuck_signal',
        subject: { kind: 'agent', ref: ownerName },
        actor: ownerName,
        evidence: { quote, fields: { sessionId: fileId, pattern: re.source } },
        raw_ref: `${email}/${date}/${fileId}`
      });
      return; // one signal per message is enough
    }
  }
}

function excerptAround(text: string, idx: number, span: number): string {
  const start = Math.max(0, idx - Math.floor(span / 2));
  const end = Math.min(text.length, start + span);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface SyncSummary {
  users: number;
  newSessions: number;
  eventsEmitted: number;
  unresolvedUsers: string[];
  /**
   * Sessions skipped because they were `cc-status`-only fragments under a
   * hostname-fallback "ghost" user_id whose session_id is also present
   * (with a real transcript) under a non-ghost user_id on the same Matrix-Riven
   * machine. See `lib/ghost_user.ts` for the detection rules + rationale.
   * Sole-identity ghosts (their session_id has no non-ghost peer) are NOT
   * skipped — their data is real and we want it.
   */
  redundantGhostsSkipped: number;
  errors: Array<{ user?: string; date?: string; sessionId?: string; error: string }>;
}

export async function syncCcSessions(opts?: { limitUsers?: string[]; lookbackDays?: number }): Promise<SyncSummary> {
  const state =
    (await readSyncState<SyncState>(SYNC_STATE_KEY)) ?? { users: {} };
  const summary: SyncSummary = {
    users: 0,
    newSessions: 0,
    eventsEmitted: 0,
    unresolvedUsers: [],
    redundantGhostsSkipped: 0,
    errors: []
  };

  let users: string[];
  try {
    users = await listUsers();
  } catch (err) {
    summary.errors.push({ error: `listUsers: ${(err as Error).message}` });
    return summary;
  }
  if (opts?.limitUsers) {
    users = users.filter((u) => opts.limitUsers!.includes(u));
  }
  summary.users = users.length;
  const lookback = opts?.lookbackDays ?? 14;
  const today = new Date();
  const cutoff = new Date(today.getTime() - lookback * 86_400_000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // ---- Pre-pass: index non-ghost (real-email) users' transcript session_ids.
  // Used in the main loop to skip "redundant ghost" sessions — cc-status
  // fragments under hostname-fallback user_ids whose canonical session_id
  // is already owned by a real-email user (which holds the actual transcript).
  // Sole-identity ghosts (no non-ghost peer for any of their sessions) pass
  // through untouched — see lib/ghost_user.ts.
  const nonGhostTranscriptIds = new Set<string>();
  for (const email of users) {
    if (isGhostUserId(email)) continue;
    let dates: string[];
    try {
      dates = await listDates(email);
    } catch {
      continue; // missing dates listing on a real user is not fatal here
    }
    for (const d of dates.filter((x) => x >= cutoffStr)) {
      let sess: SessionFileRef[];
      try {
        sess = await listSessions(email, d);
      } catch {
        continue;
      }
      for (const s of sess) {
        // Only record entries that are TRANSCRIPTS (not cc-status fragments).
        // The collector represents each as basename-minus-extension; cc-status
        // entries carry the `.cc-status` suffix on `id`.
        if (s.id.endsWith('.cc-status')) continue;
        nonGhostTranscriptIds.add(s.id);
      }
    }
  }

  for (const email of users) {
    let resolved = await resolveOrUnknown('email', email);
    if (resolved.unresolved) summary.unresolvedUsers.push(email);
    const userState = state.users[email] ?? {};
    const lastMtime = userState.lastSyncedMtime ?? '';
    let highestMtime = lastMtime;
    const isGhost = isGhostUserId(email);

    let dates: string[];
    try {
      dates = await listDates(email);
    } catch (err) {
      summary.errors.push({ user: email, error: `listDates: ${(err as Error).message}` });
      continue;
    }
    // Filter to lookback window — collector may list very old dates.
    const datesInWindow = dates.filter((d) => d >= cutoffStr).sort();

    for (const date of datesInWindow) {
      let sessions: SessionFileRef[];
      try {
        sessions = await listSessions(email, date);
      } catch (err) {
        summary.errors.push({
          user: email,
          date,
          error: `listSessions: ${(err as Error).message}`
        });
        continue;
      }
      for (const sess of sessions) {
        if (lastMtime && sess.mtime <= lastMtime) continue;

        // Redundant-ghost filter: this session is under a hostname-fallback
        // user_id AND its canonical session_id is already covered by a
        // real-email user's transcript on the same Matrix-Riven instance
        // (built in the pre-pass above). Skip ingestion to avoid emitting
        // duplicate cc.* events under both identities.
        if (isGhost && nonGhostTranscriptIds.has(canonicalSessionId(sess.id))) {
          summary.redundantGhostsSkipped++;
          if (sess.mtime > highestMtime) highestMtime = sess.mtime;
          continue;
        }

        try {
          const raw = await fetchSessionRaw(email, date, sess.id, sess.ext);
          const parsed = parseSession(email, date, sess.id, resolved.name, raw);
          if (parsed.events.length > 0) {
            await appendEvents(parsed.events);
            summary.eventsEmitted += parsed.events.length;
          }
          summary.newSessions++;
          if (sess.mtime > highestMtime) highestMtime = sess.mtime;
        } catch (err) {
          summary.errors.push({
            user: email,
            date,
            sessionId: sess.id,
            error: (err as Error).message
          });
        }
      }
    }

    if (highestMtime && highestMtime !== lastMtime) {
      state.users[email] = { lastSyncedMtime: highestMtime };
    }
  }

  await writeSyncState(SYNC_STATE_KEY, state);
  return summary;
}
