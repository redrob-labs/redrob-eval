import { NextResponse } from 'next/server';
import { compareModels, createRunStore, type ToolRoutingMetric } from '@redrob/harness';
import { collectToolRoutingReports } from '@/lib/analyze/collect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

const METRICS = new Set<ToolRoutingMetric>(['toolSelect', 'argExact', 'absence', 'parsed']);

/**
 * GET /api/analyze/runs/[runId]/compare?metric= — paired comparison of every
 * model in the run on one metric, with intervals, McNemar and Holm adjustment.
 */
export async function GET(request: Request, context: Ctx) {
  const { runId } = await context.params;
  const raw = new URL(request.url).searchParams.get('metric') ?? 'toolSelect';
  const metric = (METRICS.has(raw as ToolRoutingMetric) ? raw : 'toolSelect') as ToolRoutingMetric;

  const store = await createRunStore();
  try {
    const reports = await collectToolRoutingReports(store, runId);
    if (reports.length < 2) {
      return NextResponse.json(
        { error: 'Need at least two models with stored reports to compare.' },
        { status: 400 },
      );
    }
    return NextResponse.json(compareModels({ reports, metric }));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not compare' },
      { status: 400 },
    );
  } finally {
    await store.close();
  }
}
