import { NextResponse } from 'next/server';
import { createRunStore, saveCohort, type FailureFilter } from '@redrob/harness';
import { collectRunFailures } from '@/lib/analyze/collect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

type Body = { name?: string; failureIds?: string[]; filter?: FailureFilter };

/**
 * POST /api/analyze/runs/[runId]/cohort — save a selection of failures.
 *
 * The client sends the exact failure ids it has on screen, not a filter for the
 * server to re-run: a cohort has to be the set the researcher was looking at,
 * and re-deriving it here could drift if the run changed underneath.
 */
export async function POST(request: Request, context: Ctx) {
  const { runId } = await context.params;
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: 'Provide a cohort name' }, { status: 400 });
  const wanted = new Set(body.failureIds ?? []);
  if (wanted.size === 0) {
    return NextResponse.json({ error: 'Select at least one failure' }, { status: 400 });
  }

  const store = await createRunStore();
  try {
    const { failures } = await collectRunFailures(store, runId);
    const chosen = failures.filter((f) => wanted.has(f.id));
    if (chosen.length === 0) {
      return NextResponse.json(
        { error: 'None of the selected failures were found in this run' },
        { status: 400 },
      );
    }
    const cohort = await saveCohort(store, {
      name,
      sourceRunId: runId,
      filter: body.filter ?? {},
      failures: chosen,
    });
    return NextResponse.json({ cohort });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not save cohort' },
      { status: 400 },
    );
  } finally {
    await store.close();
  }
}
