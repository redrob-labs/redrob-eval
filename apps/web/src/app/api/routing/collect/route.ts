import {
  startRoutingCollectJob,
  type RoutingCollectRequest,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/routing/collect — start dual-eval collection job.
 * Returns `{ runId }` immediately; stream progress via
 * GET /api/routing/runs/:runId/events
 */
export async function POST(request: Request) {
  let body: RoutingCollectRequest;
  try {
    body = (await request.json()) as RoutingCollectRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.datasetId || !Number.isFinite(body.sampleCount)) {
    return new Response(
      JSON.stringify({ error: 'Provide datasetId and sampleCount' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!body.smallModelId || !body.largeModelId) {
    return new Response(
      JSON.stringify({ error: 'Provide smallModelId and largeModelId' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { runId } = await startRoutingCollectJob({
      datasetId: body.datasetId,
      sampleCount: body.sampleCount,
      smallModelId: body.smallModelId,
      largeModelId: body.largeModelId,
      smallOkThreshold: body.smallOkThreshold,
    });
    return new Response(JSON.stringify({ runId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to start collection',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
