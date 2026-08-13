import { NextResponse } from 'next/server';
import { createRunStore, tallyFailures } from '@redrob/harness';
import { collectRunFailures } from '@/lib/analyze/collect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

/**
 * GET /api/analyze/runs/[runId]/failures — every classified failure, with
 * annotations applied, plus the facets the UI filters on.
 *
 * The whole set is returned and filtered in the browser: a run has at most a
 * few hundred failures, and a round trip per filter change would make the view
 * feel slower than the data is.
 */
export async function GET(_request: Request, context: Ctx) {
  const { runId } = await context.params;
  const store = await createRunStore();
  try {
    const { failures, artifactCount } = await collectRunFailures(store, runId);
    return NextResponse.json({
      failures,
      tally: tallyFailures(failures),
      artifactCount,
      facets: {
        kinds: [...new Set(failures.map((f) => f.kind))].sort(),
        models: [...new Set(failures.map((f) => f.model))].sort(),
        languages: [...new Set(failures.map((f) => f.language).filter(Boolean))].sort(),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not collect failures' },
      { status: 400 },
    );
  } finally {
    await store.close();
  }
}
