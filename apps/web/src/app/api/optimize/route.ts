import {
  startOptimizeJob,
  type OptimizeJobRequest,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/optimize — start GEPA (or RandomSearch) job.
 * Returns `{ runId }`; stream via GET /api/optimize/runs/:id/events
 */
export async function POST(request: Request) {
  let body: OptimizeJobRequest;
  try {
    body = (await request.json()) as OptimizeJobRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.datasetId || !body.seedModelId) {
    return new Response(
      JSON.stringify({ error: 'Provide datasetId and seedModelId' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { runId } = await startOptimizeJob(body);
    return new Response(JSON.stringify({ runId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start optimize';
    const status = message.includes('Refusing') ? 400 : 400;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
