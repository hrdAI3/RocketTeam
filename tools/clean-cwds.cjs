// One-time retroactive cleanup of poisoned observed_cwds in private/projects.json.
// Replicates src/lib/projects.ts denial logic. Separator-agnostic binding check
// (splits on BOTH / and \) so legit Windows backslash paths are preserved —
// this matches the plan intent ("keep legit ones"), since the in-repo gate's
// '/'-only split would over-remove every backslash path.
const fs = require('fs');
const path = require('path');

const PROJECTS = path.join(__dirname, '..', 'private', 'projects.json');
const BACKUP = path.join(__dirname, '..', 'private', 'projects.json.bak-20260603');
const APPLY = process.argv.includes('--apply');

const WRITEBACK_DENY_LEAVES = new Set([
  'tmp','temp','var','private','users','user','home','desktop','documents',
  'downloads','system32','projects','workspace','workspaces','src','public',
  '[redacted]','redacted','.claude','.codex','.cursor','.git','.gstack',
  'worktrees','work','node_modules','dist','build','out',
  'neuro','asus','zhangziyi','tianhaoxuan','19723',
  'thesis','renlab','research','personal'
]);
const WRITEBACK_DENY_PATTERNS = [
  /^night-shift-e2e-/i, /^deep-smoke-/i, /^claude-shell-/i, /^worktree-/i, /^\.tmp/i,
  /(会议|纪要|meeting|briefing|memo|notes)$/i
];
const WRITEBACK_DENY_PATH_PATTERNS = [
  /^[a-z]:[\\/]users[\\/][^\\/]+$/i,
  /^[\\/]home[\\/][^\\/]+$/i
];
function normalizeCwd(s) { return s.trim().replace(/[\\/]+$/, '').toLowerCase(); }
function isDenyCwd(cwd) {
  const norm = normalizeCwd(cwd);
  if (WRITEBACK_DENY_PATH_PATTERNS.some((re) => re.test(norm))) return true;
  const segs = norm.split(/[\\/]+/).filter(Boolean);
  const leaf = segs[segs.length - 1] ?? '';
  if (!leaf) return true;
  const low = leaf.toLowerCase();
  if (WRITEBACK_DENY_LEAVES.has(low)) return true;
  if (WRITEBACK_DENY_PATTERNS.some((re) => re.test(leaf))) return true;
  if (/^\d{1,4}$/.test(leaf)) return true;
  return false;
}
function projectBindingTokens(p) {
  const out = new Set();
  out.add(p.name.toLowerCase());
  for (const a of p.aliases ?? []) {
    const low = a.toLowerCase();
    out.add(low);
    const slash = low.lastIndexOf('/');
    if (slash >= 0) out.add(low.slice(slash + 1));
  }
  for (const t of [...out]) if (WRITEBACK_DENY_LEAVES.has(t)) out.delete(t);
  return out;
}
function cwdBindsToProject(cwd, tokens) {
  if (tokens.size === 0) return false;
  const norm = normalizeCwd(cwd);
  for (const seg of norm.split(/[\\/]+/).filter(Boolean)) {
    if (tokens.has(seg.toLowerCase())) return true;
  }
  return false;
}
function isLegit(cwd, p, tokens) {
  if (isDenyCwd(cwd)) return false;
  if (!cwdBindsToProject(cwd, tokens)) return false;
  return true;
}

const raw = fs.readFileSync(PROJECTS, 'utf8');
const file = JSON.parse(raw);
let removed = 0, kept = 0;
const audit = [];
for (const p of file.projects) {
  if (!Array.isArray(p.observed_cwds) || p.observed_cwds.length === 0) continue;
  const tokens = projectBindingTokens(p);
  const keepArr = [];
  for (const c of p.observed_cwds) {
    if (isLegit(c, p, tokens)) { keepArr.push(c); kept++; }
    else { audit.push(`${p.id}\tDROP\t${c}`); removed++; }
  }
  for (const c of keepArr) audit.push(`${p.id}\tKEEP\t${c}`);
  p.observed_cwds = keepArr;
}

console.log('removed=' + removed + ' kept=' + kept);
console.log('--- audit ---');
console.log(audit.join('\n'));

if (APPLY) {
  fs.copyFileSync(PROJECTS, BACKUP);
  console.log('backup written: ' + BACKUP);
  // atomic-ish write: tmp + rename, preserve 2-space JSON formatting
  const tmp = PROJECTS + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, PROJECTS);
  console.log('projects.json written');
}
