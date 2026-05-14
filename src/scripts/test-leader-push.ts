// One-shot: send a sample warning DM to whoever LEADER_NAME points to (default
// 安子岩). Bypasses the regular notifyActNowIfNew templating so we can include
// concrete numbers (util %, reset countdown) in the message body.
//
//   bun run src/scripts/test-leader-push.ts
//   LEADER_NAME=戴昊然 bun run src/scripts/test-leader-push.ts

import { getToken, postDM } from '../lib/slack';

const SENDER_LABEL = process.env.PUSH_SENDER_LABEL ?? 'RocketTeam';
const LEADER_NAME = process.env.LEADER_NAME ?? '安子岩';

async function main(): Promise<void> {
  const token = await getToken();
  if (!token) {
    console.log(JSON.stringify({ pushed: false, reason: 'no-slack-token' }));
    return;
  }
  const text = [
    `🚀 *${SENDER_LABEL}* · 警告`,
    `⚠️ *7d 配额接近限额* — 戴昊然`,
    ``,
    `戴昊然 7 天用量已经到 95%，还有约 1 天 2 小时才重置。`,
    `不出意外的话他在重置前会被限流，建议看一眼他在干嘛、是否要调整今天的节奏。`,
    ``,
    `在 CC 里看详情: \`team:status 戴昊然\` 或 \`team:ask 戴昊然 "你今天还要继续推 TeamBrain 吗？7d 配额快到了"\`。`
  ].join('\n');
  const ok = await postDM(token, LEADER_NAME, text);
  console.log(JSON.stringify({ leader: LEADER_NAME, pushed: ok }, null, 2));
}

void main();
