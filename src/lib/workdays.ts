// Working-day calendar for Slack-reminder cadence.
//
// All escalation gaps in the project ("24h between stage N and N+1") count
// working days, NOT walltime. Weekends and statutory holidays don't count;
// 调休 补班 weekends DO count. The canonical list lives in
// `private/holidays.json` and is leader/HR-maintained — the State Council
// publishes each year's official schedule in late Q4, then this file gets
// updated.
//
// Timezone: we treat dates as China Standard Time (UTC+8, no DST). Any ISO
// timestamp passed in gets bucketed to its CST calendar date before the
// working-day check, so "Friday 23:30 UTC = Saturday 07:30 CST" correctly
// counts the Saturday.
//
// Module-level cache: holidays.json is read once per process. Restart the
// dev server / monitor loop after editing the file.

import { promises as fs } from 'fs';
import path from 'path';

const PRIVATE_DIR = path.join(process.cwd(), 'private');
const HOLIDAYS_PATH = path.join(PRIVATE_DIR, 'holidays.json');

interface HolidaysJson {
  non_working?: string[];
  extra_working?: string[];
}

interface HolidaysSet {
  nonWorking: Set<string>;
  extraWorking: Set<string>;
}

let cached: HolidaysSet | null = null;

async function loadHolidays(): Promise<HolidaysSet> {
  if (cached) return cached;
  try {
    const raw = await fs.readFile(HOLIDAYS_PATH, 'utf8');
    const j = JSON.parse(raw) as HolidaysJson;
    cached = {
      nonWorking: new Set(j.non_working ?? []),
      extraWorking: new Set(j.extra_working ?? [])
    };
  } catch {
    // No file / parse error → fall back to weekends-only.
    cached = { nonWorking: new Set(), extraWorking: new Set() };
  }
  return cached;
}

// Strip the date to YYYY-MM-DD in CST (UTC+8), regardless of host timezone.
// JS Date math is UTC-based — we add the offset manually so the bucketing is
// stable on dev machines in different zones.
function toCstYmd(d: Date): string {
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = cst.getUTCFullYear();
  const m = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(cst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Day-of-week in CST. 0 = Sunday, 6 = Saturday.
function cstDow(d: Date): number {
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return cst.getUTCDay();
}

export async function isWorkingDay(date: Date): Promise<boolean> {
  const h = await loadHolidays();
  const ymd = toCstYmd(date);
  if (h.extraWorking.has(ymd)) return true;   // 调休补班
  if (h.nonWorking.has(ymd)) return false;    // 法定节假日 / 公司休
  const dow = cstDow(date);
  return dow !== 0 && dow !== 6;              // 周末
}

// Inclusive count of working calendar days between two timestamps, walking
// midnight-to-midnight in CST. `from` and `to` are ISO strings or Date.
// Used to ask "has a working day boundary been crossed since the last DM?".
//
// Example: from=Fri 18:00, to=Mon 09:00 → returns 1 (Monday is the only
// working day fully entered in that span; Fri/Sat/Sun didn't count for the
// "next-working-day" purpose).
//
// More precisely: counts the number of DISTINCT working dates strictly after
// `from`'s CST date and ≤ `to`'s CST date. So if `from` is on Friday and
// `to` is on Monday, we count Mon → 1. If `from` is Mon 09:00 and `to` is
// Tue 09:00, we count Tue → 1. Walltime is irrelevant — only date boundaries.
export async function workingDaysBetween(
  from: string | Date,
  to: string | Date
): Promise<number> {
  const fromDate = typeof from === 'string' ? new Date(from) : from;
  const toDate = typeof to === 'string' ? new Date(to) : to;
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) {
    return 0;
  }
  if (toDate.getTime() <= fromDate.getTime()) return 0;

  // Walk one CST day at a time from the day AFTER `from` to the day OF `to`.
  // We do this with a Date pinned to 00:00 CST so DST/timezone shifts can't
  // double-count or skip a day.
  const startYmd = toCstYmd(fromDate);
  const endYmd = toCstYmd(toDate);
  if (startYmd === endYmd) {
    // Same CST calendar day — no day boundary crossed.
    return 0;
  }

  let count = 0;
  // Cursor starts at the day AFTER fromDate's CST date.
  const cursor = parseYmdToUtcMidnight(startYmd);
  cursor.setUTCDate(cursor.getUTCDate() + 1); // advance one calendar day
  const stop = parseYmdToUtcMidnight(endYmd);

  while (cursor.getTime() <= stop.getTime()) {
    // The "day" we're checking is whatever CST date this cursor falls on.
    // Use a representative time of 12:00 CST (= 04:00 UTC) to avoid edge
    // boundary issues, then run through isWorkingDay.
    const probe = new Date(cursor.getTime() + 4 * 60 * 60 * 1000); // 12:00 CST
    if (await isWorkingDay(probe)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function parseYmdToUtcMidnight(ymd: string): Date {
  // CST midnight for `ymd` = UTC `ymd - 8h`. We want a single anchor we can
  // increment with setUTCDate without DST quirks; storing it at UTC midnight
  // of the *CST* date is the cleanest representation. The actual hour offset
  // is reapplied by callers when they need wall time.
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}

// Hot-path reload after the leader edits holidays.json without restarting.
export function clearWorkdaysCache(): void {
  cached = null;
}
