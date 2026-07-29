import { readCorpusStats } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/routing/corpus — corpus stats for the UI */
export async function GET() {
  const stats = await readCorpusStats();
  return Response.json({ stats });
}
