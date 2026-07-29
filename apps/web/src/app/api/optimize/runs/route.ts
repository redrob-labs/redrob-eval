import {
  listOptimizeRunIds,
  readOptimizeMeta,
  readOptimizeResult,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/optimize/runs — list recent optimize runs */
export async function GET() {
  const ids = await listOptimizeRunIds();
  const runs = [];
  for (const id of ids.slice(0, 30)) {
    try {
      const meta = await readOptimizeMeta(id);
      const result = await readOptimizeResult(id);
      runs.push({ meta, result });
    } catch {
      // skip corrupt
    }
  }
  return Response.json({ runs });
}
