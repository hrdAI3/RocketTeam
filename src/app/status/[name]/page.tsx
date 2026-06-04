import { redirect } from 'next/navigation';

// Per-person detail consolidated under /team/[name]. The /status surface is
// the workboard (anomalies + project blocks) and intentionally drills only
// into projects, not people. Old bookmarks land here → forwarded.
export default function StatusPersonRedirect({ params }: { params: { name: string } }): never {
  redirect(`/team/${encodeURIComponent(decodeURIComponent(params.name))}`);
}
