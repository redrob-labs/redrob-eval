import { NextResponse } from 'next/server';
import { createRunStore } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

/** GET /api/analyze/runs/[runId] — one run, its events, and its artifact names. */
export async function GET(_request: Request, context: Ctx) {
  const { runId } = await context.params;
  const store = await createRunStore();
  try {
    const run = await store.get(runId);
    if (!run) {
      return NextResponse.json({ error: `No run with id ${runId}` }, { status: 404 });
    }
    const [events, artifacts] = await Promise.all([
      store.readEvents(runId),
      store.listArtifacts(runId),
    ]);
    return NextResponse.json({ run, events, artifacts });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not read run' },
      { status: 400 },
    );
  } finally {
    await store.close();
  }
}
