import {
  assertSafePreferenceRunId,
  readPreferenceGenerations,
  readPreferenceMeta,
  readPreferenceSummary,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/preference/runs/:runId
 * Returns meta + summary (with truncationWarning) + optional generations.
 * Query: ?generations=1 to include generation rows (can be large).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId: raw } = await ctx.params;
  let runId: string;
  try {
    runId = assertSafePreferenceRunId(raw);
  } catch {
    return Response.json({ error: 'Invalid run id' }, { status: 400 });
  }

  try {
    const meta = await readPreferenceMeta(runId);
    const summary = await readPreferenceSummary(runId);
    const url = new URL(request.url);
    const includeGens = url.searchParams.get('generations') === '1';
    const generations = includeGens ? await readPreferenceGenerations(runId) : undefined;

    return Response.json({
      meta,
      summary,
      generations,
      truncationWarning: summary?.truncationWarning ?? false,
      truncationWarningMessage: summary?.truncationWarningMessage,
    });
  } catch {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }
}
