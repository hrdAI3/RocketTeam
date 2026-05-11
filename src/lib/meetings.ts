// Meeting transcript registry. The system already reads team/context/meeting/*.txt
// for bootstrap; this module exposes them to the UI so users can read the raw
// evidence behind every profile claim.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './paths';

const MEETING_DIR = PATHS.contextMeeting;
const SLACK_DIR = join(PATHS.context, 'slack');

export interface MeetingMeta {
  file: string;
  title: string;
  date?: string; // MM-DD when extractable from filename
  sizeKb: number;
  lineCount: number;
  source?: 'meeting' | 'slack';
}

// Filename pattern: anything ending with 4-digit MMDD before .txt → date.
// Some files start with a person name prefix ("子岩-..."), strip for title.
function parseMeta(file: string, sizeBytes: number, lineCount: number): MeetingMeta {
  const stem = file.replace(/\.txt$/, '');
  let date: string | undefined;
  const m = stem.match(/(\d{4})$/);
  if (m && m[1]) {
    const mm = m[1].slice(0, 2);
    const dd = m[1].slice(2);
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      date = `${mm}-${dd}`;
    }
  }
  // Title: remove trailing date, leading person prefix ("子岩-"), bracket markers,
  // hyphenated trailing person tags ("-hyz0429").
  let title = stem
    .replace(/[-]?[a-zA-Z]+\d{4}$/, '') // trailing alias+date
    .replace(/\d{4}$/, '')
    .replace(/^\[(.+)\]$/, '$1')
    .replace(/^\[(.+)\]/, '$1')
    .replace(/^[一-龥]{1,3}-/, '') // leading 1-3 char Chinese prefix like "子岩-"
    .trim();
  if (!title) title = stem;
  return { file, title, date, sizeKb: Math.max(1, Math.round(sizeBytes / 1024)), lineCount };
}

async function listFromDir(dir: string, source: 'meeting' | 'slack'): Promise<MeetingMeta[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const txt = names.filter((n) => n.endsWith('.txt'));
  const out: MeetingMeta[] = [];
  for (const file of txt) {
    try {
      const buf = await fs.readFile(join(dir, file), 'utf8');
      const lines = buf.split('\n').length;
      const stat = await fs.stat(join(dir, file));
      out.push({ ...parseMeta(file, stat.size, lines), source });
    } catch {
      // Skip unreadable.
    }
  }
  return out;
}

// Meetings only — slack ingestion lives in a separate registry.
export async function listMeetings(): Promise<MeetingMeta[]> {
  const out = await listFromDir(MEETING_DIR, 'meeting');
  out.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.title.localeCompare(b.title);
  });
  return out;
}

export async function listSlackTranscripts(): Promise<MeetingMeta[]> {
  const out = await listFromDir(SLACK_DIR, 'slack');
  out.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.title.localeCompare(b.title);
  });
  return out;
}

export async function readMeeting(file: string): Promise<string | null> {
  if (file.includes('..') || file.includes('\\')) return null;
  if (!file.endsWith('.txt')) return null;
  // Accept dir-prefixed paths like "slack/foo.txt" or "meeting/bar.txt".
  let baseFile = file;
  let preferredDir: string | null = null;
  if (file.startsWith('slack/')) {
    baseFile = file.slice('slack/'.length);
    preferredDir = SLACK_DIR;
  } else if (file.startsWith('meeting/')) {
    baseFile = file.slice('meeting/'.length);
    preferredDir = MEETING_DIR;
  }
  if (baseFile.includes('/')) return null;
  const dirs = preferredDir ? [preferredDir, MEETING_DIR, SLACK_DIR] : [MEETING_DIR, SLACK_DIR];
  for (const dir of dirs) {
    try {
      return await fs.readFile(join(dir, baseFile), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}
