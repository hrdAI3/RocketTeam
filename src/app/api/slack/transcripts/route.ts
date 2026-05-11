import { listSlackTranscripts } from '@/lib/meetings';

export const dynamic = 'force-dynamic';

// GET /api/slack/transcripts
// Slack-only transcript files (separate from meeting recordings).
export async function GET(): Promise<Response> {
  const transcripts = await listSlackTranscripts();
  return new Response(JSON.stringify({ transcripts }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
