import {
  assertSafeOptimizeRunId,
  assertSplitIsolation,
  readOptimizeMeta,
  readOptimizeReport,
  readOptimizeReportMarkdown,
  readOptimizeResult,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/optimize/runs/:runId
 * Query:
 *   ?report=test — refused if the run optimized against test
 *   ?export=json|md — return baseline-vs-evolved report
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId: raw } = await ctx.params;
  let runId: string;
  try {
    runId = assertSafeOptimizeRunId(raw);
  } catch {
    return Response.json({ error: 'Invalid run id' }, { status: 400 });
  }

  try {
    const meta = await readOptimizeMeta(runId);
    const url = new URL(request.url);
    const report = url.searchParams.get('report');
    if (report === 'test') {
      try {
        assertSplitIsolation({
          optimizedAgainst: meta.optimizedAgainst,
          reported: 'test',
        });
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : 'Split isolation refused' },
          { status: 403 },
        );
      }
    }

    const exp = url.searchParams.get('export');
    if (exp === 'md' || exp === 'markdown') {
      const md = await readOptimizeReportMarkdown(runId);
      if (!md) {
        return Response.json({ error: 'Report not ready' }, { status: 404 });
      }
      return new Response(md, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${runId}-report.md"`,
        },
      });
    }
    if (exp === 'json' || exp === 'report') {
      const optimizeReport = await readOptimizeReport(runId);
      if (!optimizeReport) {
        return Response.json({ error: 'Report not ready' }, { status: 404 });
      }
      return Response.json(optimizeReport);
    }

    const result = await readOptimizeResult(runId);
    const optimizeReport = await readOptimizeReport(runId);
    return Response.json({ meta, result, report: optimizeReport });
  } catch {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }
}
