// Slack info-collection campaign runner. Invoke explicitly:
//   bun run tools/run_campaigns.ts c1     # collect GitHub usernames
//   bun run tools/run_campaigns.ts c2     # nudge email + nickname fixes
//   bun run tools/run_campaigns.ts both
//
// C1 is a collection campaign (replies auto-captured by the Socket Mode
// client → roster). C2 is a notify-only nudge (per-person missing items).

import { startCollection } from '../src/services/slack_collection';
import { getToken, openConversation } from '../src/lib/slack';
import { readRoster } from '../src/lib/team_roster';

async function dmByUserId(token: string, userId: string, text: string): Promise<boolean> {
  const channel = await openConversation(token, userId);
  if (!channel) return false;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text })
  });
  const j = (await res.json()) as { ok?: boolean };
  return j.ok ?? false;
}

const C1_PROMPT =
  '你好～Rocket Team 团队系统在登记大家的 GitHub 账号 👋\n\n' +
  '1️⃣ 你的 GitHub 用户名是？直接发 github.com/ 后面那串（或贴主页链接）就行。\n\n' +
  'ℹ️ 另外公司规定：GitHub 昵称（Settings → Public profile → Name）需要包含 "renlab"，登记时方便帮你核对。';

async function runC1(): Promise<void> {
  const roster = await readRoster();
  const names = roster.members
    .filter((m) => m.slack.user_id && !m.github.login)
    .map((m) => m.name);
  console.log('C1 →', names.join(' '));
  const res = await startCollection('github.login', C1_PROMPT, names);
  console.log(JSON.stringify(res, null, 2));
}

async function runC2(): Promise<void> {
  const token = await getToken();
  if (!token) { console.log('no slack token'); return; }
  const roster = await readRoster();
  for (const m of roster.members) {
    if (!m.slack.user_id || !m.github.login) continue;
    const need: string[] = [];
    if (!m.github.public_email_suffix_ok) {
      need.push(
        '• 公开邮箱：Settings → Public profile → Public email 选 @renlab.ai 或 @nb-ai.com 的邮箱'
      );
    }
    if (!m.github.display_name_ok) {
      const cur = m.github.display_name ? `（现在是 "${m.github.display_name}"）` : '（现在没设）';
      need.push(`• 昵称：Settings → Public profile → Name 改成包含 "renlab" ${cur}`);
    }
    if (need.length === 0) continue;
    const text =
      `你好～你的 GitHub 账号 ${m.github.login} 还差这些没配齐：\n` +
      need.join('\n') +
      `\n配好后团队系统会自动确认 ✓，不用回复我。`;
    const ok = await dmByUserId(token, m.slack.user_id, text).catch(() => false);
    console.log(`C2 ${m.name} → ${ok ? 'sent' : 'FAILED'}`);
  }
}

const mode = process.argv[2] ?? '';
if (mode === 'c1') await runC1();
else if (mode === 'c2') await runC2();
else if (mode === 'both') { await runC1(); await runC2(); }
else console.log('usage: bun run tools/run_campaigns.ts c1|c2|both');
