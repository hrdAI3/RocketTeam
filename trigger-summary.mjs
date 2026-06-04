// Trigger fresh getWorkSummary for one agent to verify A-D fixes.
// Uses tsx to load the TS module so imports resolve.
import { execSync } from 'node:child_process';
const name = process.argv[2] || '黄运樟';
const script = `
import { getWorkSummary, readCachedSummaries } from './src/services/work_summary.js';
const r = await getWorkSummary(${JSON.stringify(name)});
console.log('summary:', JSON.stringify(r, null, 2));
`;
import { writeFileSync, unlinkSync } from 'node:fs';
writeFileSync('D:/hrdai/team/.trigger-tmp.mjs', script);
try {
  execSync('cd D:/hrdai/team && npx tsx .trigger-tmp.mjs', { stdio: 'inherit' });
} finally {
  try { unlinkSync('D:/hrdai/team/.trigger-tmp.mjs'); } catch {}
}
