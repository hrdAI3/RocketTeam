// Shared Slack transcript writer. The lightweight extractor (`syncSlack` in
// `extractors/slack.ts`) and the heavy POST route (`/api/slack/sync`) both
// advance `cfg.channel_last_ts` and used to fight: whichever ran first ate
// the new messages, the other found nothing to write. The extractor (cron)
// usually wins and never wrote .txt, so on-disk transcripts froze.
//
// This module owns the .txt write so both call sites produce the same files.
// Dedup by Slack `#ts` token embedded in each line; new-day files get a
// header on first write.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SlackMessage } from './slack';

export interface SlackTranscriptInput {
  channel: { id: string; name: string };
  messages: SlackMessage[]; // any order; this fn orders oldest→newest internally
  userMap: Record<string, string>;
  slackDir: string;
}

export interface SlackTranscriptWriteResult {
  files: Array<{ file: string; messages: number }>;
}

export async function writeSlackTranscript(
  input: SlackTranscriptInput
): Promise<SlackTranscriptWriteResult> {
  const { channel, messages, userMap, slackDir } = input;
  if (messages.length === 0) return { files: [] };
  await fs.mkdir(slackDir, { recursive: true });
  const ordered = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  const byDate: Record<string, SlackMessage[]> = {};
  for (const m of ordered) {
    const date = new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 10);
    (byDate[date] ??= []).push(m);
  }

  const out: SlackTranscriptWriteResult['files'] = [];
  for (const [date, dayMsgs] of Object.entries(byDate)) {
    const fileName = `slack-${channel.name}-${date}.txt`;
    const filePath = join(slackDir, fileName);
    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf8');
    } catch {
      existing = `# Slack #${channel.name}\n频道: ${channel.name} · 日期: ${date}\n`;
    }
    const newLines: string[] = [];
    for (const m of dayMsgs) {
      if (!m.text || !m.text.trim()) continue;
      const speaker = m.user ? (userMap[m.user] ?? m.user) : 'unknown';
      const ts = new Date(parseFloat(m.ts) * 1000).toISOString();
      const cleaned = m.text.replace(
        /<@([A-Z0-9]+)>/g,
        (_, id: string) => `@${userMap[id] ?? id}`
      );
      newLines.push(`[${ts.slice(0, 19).replace('T', ' ')} #${m.ts}] ${speaker}: ${cleaned}`);
    }
    if (newLines.length === 0) continue;
    const filtered = newLines.filter((line) => {
      const m = line.match(/#(\d+\.\d+)\]/);
      if (!m) return true;
      return !existing.includes(`#${m[1]}]`);
    });
    if (filtered.length === 0) continue;
    const updated = existing.trimEnd() + '\n' + filtered.join('\n') + '\n';
    await fs.writeFile(filePath, updated, 'utf8');
    out.push({ file: fileName, messages: filtered.length });
  }
  return { files: out };
}
