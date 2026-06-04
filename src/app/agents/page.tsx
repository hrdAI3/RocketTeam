import { redirect } from 'next/navigation';

// /agents was the legacy department-grouped Team list. Superseded by
// the richer /team page (cards + projects + identity + sources). Keep
// /agents/[name] alive for per-member detail; the list page just
// permanently redirects so old bookmarks / sidebar memory still work.
export default function AgentsRootRedirect(): never {
  redirect('/team');
}
