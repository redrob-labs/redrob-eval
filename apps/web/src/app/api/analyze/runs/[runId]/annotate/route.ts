import { NextResponse } from 'next/server';
import {
  annotateFailure,
  createRunStore,
  FAILURE_KINDS,
  type FailureKind,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

type Body = { failureId?: string; kind?: string; note?: string };

/**
 * POST /api/analyze/runs/[runId]/annotate — a reader's verdict on one failure.
 *
 * Overrides the derived classification; the derived kind is kept beside it by
 * the harness, so a classifier that is corrected the same way repeatedly stays
 * visible.
 */
export async function POST(request: Request, context: Ctx) {
  const { runId } = await context.params;
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.failureId) {
    return NextResponse.json({ error: 'Provide failureId' }, { status: 400 });
  }
  if (body.kind && !FAILURE_KINDS.includes(body.kind as FailureKind)) {
    return NextResponse.json({ error: `Unknown kind: ${body.kind}` }, { status: 400 });
  }

  const store = await createRunStore();
  try {
    const annotations = await annotateFailure(store, runId, {
      failureId: body.failureId,
      ...(body.kind ? { kind: body.kind as FailureKind } : {}),
      ...(body.note ? { note: body.note } : {}),
    });
    return NextResponse.json({ ok: true, annotations });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not annotate' },
      { status: 400 },
    );
  } finally {
    await store.close();
  }
}
