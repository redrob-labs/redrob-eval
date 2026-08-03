import {
  abortPreferenceJob,
  listPreferenceRunIds,
  readPreferenceMeta,
  readPreferenceSummary,
  startPreferenceJob,
  type PreferenceJobRequest,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/preference/runs — start task-grounded preference generation.
 * GET  /api/preference/runs — list run ids + status
 */
export async function GET() {
  const ids = await listPreferenceRunIds();
  const runs = [];
  for (const id of ids.slice(0, 50)) {
    try {
      const meta = await readPreferenceMeta(id);
      const summary = await readPreferenceSummary(id);
      runs.push({
        id: meta.id,
        taskId: meta.taskId,
        status: meta.status,
        createdAt: meta.createdAt,
        finishedAt: meta.finishedAt,
        modelCount: meta.modelIds.length,
        inputCount: meta.inputIds.length,
        truncationWarning: summary?.truncationWarning ?? false,
      });
    } catch {
      // skip corrupt
    }
  }
  return Response.json({ runs });
}

export async function POST(request: Request) {
  let body: PreferenceJobRequest;
  try {
    body = (await request.json()) as PreferenceJobRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.customGoal) {
    return Response.json({ error: 'customGoal required' }, { status: 400 });
  }
  if (!body.modelIds?.length) {
    return Response.json({ error: 'modelIds required' }, { status: 400 });
  }

  try {
    const { runId } = await startPreferenceJob(body);
    return Response.json({ runId }, { status: 202 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to start preference run' },
      { status: 400 },
    );
  }
}

/** Optional: DELETE with ?runId= to abort (mirrors optimize stop patterns). */
export async function DELETE(request: Request) {
  const runId = new URL(request.url).searchParams.get('runId');
  if (!runId) return Response.json({ error: 'runId required' }, { status: 400 });
  const ok = abortPreferenceJob(runId);
  return Response.json({ aborted: ok });
}
