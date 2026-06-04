// GET /api/repo-ownership — list every tracked GitHub repo whose owner
// account is NOT inside the renlab-ai umbrella. UI consumes this on the
// workboard so the leader sees personal-account repos that still need to be
// transferred to anzy-renlab-ai. monitor_loop pushes the corresponding Slack
// DM independently (see notifyExternalOwnerRepoIfNew).

import { NextResponse } from 'next/server';
import { findExternallyOwnedRepos } from '../../../services/repo_ownership';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const repos = await findExternallyOwnedRepos();
    return NextResponse.json({ repos });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, repos: [] },
      { status: 500 }
    );
  }
}
