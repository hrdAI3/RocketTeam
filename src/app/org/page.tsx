import { Crown } from 'lucide-react';
import { parseOrgChart } from '@/bootstrap/extract';
import { listAgents } from '@/lib/agents';
import { Avatar, MemberChip } from '@/components/Avatar';
import type { Department } from '@/types';

export const dynamic = 'force-dynamic';

const DEPT_ACCENT: Record<string, { ring: string; label: string }> = {
  产品: { ring: 'before:bg-coral', label: 'PRODUCT' },
  研发: { ring: 'before:bg-sky', label: 'ENGINEERING' },
  职能: { ring: 'before:bg-forest', label: 'FUNCTIONS' },
  运营: { ring: 'before:bg-amber', label: 'OPERATIONS' },
  老板: { ring: 'before:bg-ink', label: 'LEADERSHIP' },
  'Agent': { ring: 'before:bg-ink', label: 'AI WORKERS' }
};

// Display order: 老板 detached at top; rest 研发 → 产品 → 职能 → 运营 → AI 协作.
const DEPT_ORDER: string[] = ['研发', '产品', '职能', '运营', 'Agent'];

function sortMembers<T extends { name: string; role?: string }>(list: T[]): T[] {
  const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base' });
  return [...list].sort((a, b) => {
    const aLead = (a.role ?? '').includes('负责人') ? 0 : 1;
    const bLead = (b.role ?? '').includes('负责人') ? 0 : 1;
    if (aLead !== bLead) return aLead - bLead;
    return collator.compare(a.name, b.name);
  });
}

export default async function OrgPage() {
  const [entries, activeAgents] = await Promise.all([parseOrgChart(), listAgents()]);
  const activeSet = new Set(activeAgents);

  const grouped: Map<string, typeof entries> = new Map();
  for (const e of entries) {
    if (!grouped.has(e.dept)) grouped.set(e.dept, []);
    grouped.get(e.dept)!.push(e);
  }

  const total = entries.length;
  const boss = entries.find((e) => e.dept === '老板');
  const departments: Array<[string, typeof entries]> = [];
  for (const dept of DEPT_ORDER) {
    const list = grouped.get(dept);
    if (list) departments.push([dept, sortMembers(list)]);
  }
  // Append any other depts not in DEPT_ORDER (defensive)
  for (const [k, v] of grouped.entries()) {
    if (k !== '老板' && !DEPT_ORDER.includes(k)) departments.push([k, sortMembers(v)]);
  }

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <header className="flex items-end justify-between mb-10">
        <div className="max-w-2xl">
          <div className="eyebrow mb-2">Rocket Team / 组织架构</div>
          <h1 className="display-title">团队</h1>
          <p className="prose-warm text-body text-ink-muted mt-3">
            24 位同事。任务到来时，候选池从这张组织图中产生。
          </p>
        </div>
        <div className="flex items-center gap-6 text-right">
          <Stat label="总人数" value={total} />
          <Stat label="部门数" value={departments.length} />
          <Stat label="已建画像" value={activeAgents.length} accent />
        </div>
      </header>

      {/* Boss tier — single distinguished card */}
      {boss && (
        <section className="mb-8">
          <div className="card-warm p-5 max-w-md inline-flex items-center gap-4 shadow-card">
            <Avatar name={boss.name} dept={boss.dept as Department} size="xl" ringed />
            <div>
              <div className="font-serif text-[24px] leading-tight text-ink flex items-center gap-2">
                {boss.name}
                <Crown size={14} className="text-ink-quiet" aria-label="创始人" />
              </div>
              <div className="text-[13px] text-ink-muted mt-1">{boss.role}</div>
            </div>
          </div>
        </section>
      )}

      {/* Departments */}
      <div className="grid grid-cols-2 gap-5">
        {departments.map(([dept, members]) => {
          const accent = DEPT_ACCENT[dept] ?? { ring: 'before:bg-ink', label: dept };
          return (
            <section
              key={dept}
              className={`relative card-surface p-5 pl-6 before:content-[''] before:absolute before:left-0 before:top-5 before:bottom-5 before:w-[3px] before:rounded-r-md ${accent.ring}`}
            >
              <header className="flex items-baseline justify-between mb-4">
                <div>
                  <h2 className="font-serif text-[20px] leading-tight text-ink">{dept}</h2>
                  <div className="eyebrow mt-1">{accent.label}</div>
                </div>
                <span className="font-mono text-[12px] text-ink-quiet">{members.length} 人</span>
              </header>
              <div className="grid grid-cols-2 gap-2">
                {members.map((m) => (
                  <MemberChip
                    key={m.name}
                    name={m.name}
                    dept={m.dept as Department}
                    role={m.role !== '团队成员' ? m.role : undefined}
                    active={activeSet.has(m.name)}
                    href={activeSet.has(m.name) ? `/agents/${encodeURIComponent(m.name)}` : undefined}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className={`font-serif text-[28px] leading-none ${accent ? 'text-coral' : 'text-ink'}`}>
        {value}
      </div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}

