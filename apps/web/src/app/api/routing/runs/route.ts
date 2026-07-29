import {
  listRoutingRunIds,
  readCorpusStats,
  readRoutingMeta,
  readRoutingSummary,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/routing/runs — list collection runs + corpus stats */
export async function GET() {
  const ids = await listRoutingRunIds();
  const runs = [];
  for (const id of ids.slice(0, 50)) {
    try {
      const meta = await readRoutingMeta(id);
      const summary = await readRoutingSummary(id);
      runs.push({ meta, summary });
    } catch {
      // skip
    }
  }
  const corpus = await readCorpusStats();
  return Response.json({ runs, corpus });
}
