import { NextResponse } from 'next/server';
import { listAgents, getState } from '@/lib/agents';
import { parseOrgChart } from '@/bootstrap/extract';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const [names, orgEntries] = await Promise.all([listAgents(), parseOrgChart()]);
    // Org chart is source of truth for dept + role. Profile JSON may be stale
    // if the user edited team/context/org/组织架构.txt and didn't re-bootstrap.
    const orgIndex = new Map(orgEntries.map((e) => [e.name, e]));
    const states = await Promise.all(
      names.map(async (n) => {
        try {
          const profile = await getState(n);
          const org = orgIndex.get(n);
          if (org) {
            return { ...profile, dept: org.dept || profile.dept, role: org.role || profile.role };
          }
          return profile;
        } catch {
          return { name: n, _error: 'profile_corrupted' };
        }
      })
    );
    return NextResponse.json({ agents: states });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
