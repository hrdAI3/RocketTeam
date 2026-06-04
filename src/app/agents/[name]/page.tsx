import { redirect } from 'next/navigation';

// Per-person detail consolidated under /team/[name]. The legacy /agents/*
// surface (department-grouped list + PMA-profile editor) was folded into
// /team for IA clarity. Old bookmarks land here → forwarded.
export default function AgentsPersonRedirect({ params }: { params: { name: string } }): never {
  redirect(`/team/${encodeURIComponent(decodeURIComponent(params.name))}`);
}
