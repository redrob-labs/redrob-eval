import {
  buildCustomGoalSpec,
  startOptimizeJob,
  type OptimizeJobRequest,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/optimize — start GEPA (or RandomSearch) job.
 * Returns `{ runId }`; stream via GET /api/optimize/runs/:id/events
 *
 * Body: seedModelId required. Either datasetId (catalog) or customGoal
 * { goal, rubric, examplesRaw }.
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

  if (!body.seedModelId) {
    return new Response(
      JSON.stringify({ error: 'Provide seedModelId' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const hasCustom = Boolean(body.customGoal);
  const hasCatalog = Boolean(body.datasetId);
  if (!hasCustom && !hasCatalog) {
    return new Response(
      JSON.stringify({ error: 'Provide datasetId or customGoal' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (hasCustom && hasCatalog) {
    return new Response(
      JSON.stringify({ error: 'Use either datasetId or customGoal, not both' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (hasCustom) {
    try {
      buildCustomGoalSpec(body.customGoal!);
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: e instanceof Error ? e.message : 'Invalid customGoal',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  try {
    const { runId } = await startOptimizeJob(body);
    return new Response(JSON.stringify({ runId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start optimize';
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
