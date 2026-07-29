import {
  readRoutingExamples,
  readRoutingMeta,
  readRoutingSummary,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

/** GET /api/routing/runs/[runId] */
export async function GET(_request: Request, context: Ctx) {
  const { runId } = await context.params;
  try {
    const meta = await readRoutingMeta(runId);
    const summary = await readRoutingSummary(runId);
    const examples = await readRoutingExamples(runId);
    return Response.json({ meta, summary, examples });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Run not found' },
      { status: 404 },
    );
  }
}
