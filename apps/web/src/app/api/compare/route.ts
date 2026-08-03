import {
  assertNoCurrencyInValue,
  assertSplitIsolation,
  compareModels,
  compareResultToMarkdown,
  ILLUSTRATIVE_TOKEN_PROFILE,
  loadCompareRegistry,
  qualitiesFromOptimizeReport,
  readOptimizeMeta,
  readOptimizeReport,
  tokenProfileFromEvalBatch,
  type CompareRequest,
  type OptimizeReport,
  type TokenProfile,
  type Weights,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = Partial<CompareRequest> & {
  /** Optional client-supplied qualities (e.g. from an in-memory text eval). */
  runQualities?: Record<string, number>;
  /** When true with GET-style export via POST, return markdown. */
  exportMd?: boolean;
};

function isWeights(w: unknown): w is Weights {
  if (!w || typeof w !== 'object') return false;
  const o = w as Weights;
  return (
    Number.isFinite(o.quality) &&
    Number.isFinite(o.preference) &&
    Number.isFinite(o.cost) &&
    Number.isFinite(o.speed)
  );
}

/**
 * POST /api/compare
 * Body: { modelIds, tokenProfile?, weights?, baselineModelId, qualitySource, runId?, split?, goodEnoughSeconds?, runQualities?, exportMd? }
 * Query: ?export=md — return markdown instead of JSON
 *
 * Rates never appear in the response. Relative cost is % of baseline only.
 */
export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map(String) : [];
  if (modelIds.length === 0) {
    return Response.json({ error: 'modelIds required' }, { status: 400 });
  }
  const baselineModelId = String(body.baselineModelId ?? '');
  if (!baselineModelId) {
    return Response.json({ error: 'baselineModelId required' }, { status: 400 });
  }
  const qualitySource = body.qualitySource === 'run' ? 'run' : 'registry';
  const weights = isWeights(body.weights)
    ? body.weights
    : { quality: 0.3, preference: 0.2, cost: 0.3, speed: 0.2 };

  const registry = loadCompareRegistry();
  let runQualities: Record<string, number> | undefined = body.runQualities;
  let tokenProfile: TokenProfile =
    body.tokenProfile && typeof body.tokenProfile === 'object'
      ? (body.tokenProfile as TokenProfile)
      : ILLUSTRATIVE_TOKEN_PROFILE;
  const notes: string[] = [];

  if (qualitySource === 'run') {
    const runId = body.runId?.trim();
    if (!runId && !runQualities) {
      return Response.json(
        { error: 'qualitySource=run requires runId or runQualities' },
        { status: 400 },
      );
    }
    if (runId) {
      try {
        const meta = await readOptimizeMeta(runId);
        const split = body.split === 'test' ? 'test' : 'val';
        if (split === 'test') {
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
        const report = (await readOptimizeReport(runId)) as OptimizeReport | null;
        if (!report) {
          return Response.json({ error: 'Optimize report not ready' }, { status: 404 });
        }
        const fromReport = qualitiesFromOptimizeReport(report, split);
        runQualities = { ...fromReport, ...runQualities };
        // Prefer run telemetry for token profile when caller left the illustrative default
        const batch = split === 'test' ? report.evolved.test : report.evolved.val;
        if (
          batch &&
          (!body.tokenProfile ||
            body.tokenProfile.label?.includes('illustrative default'))
        ) {
          tokenProfile = tokenProfileFromEvalBatch(batch, {
            parallelSections: tokenProfile.parallelSections,
            failureRate: tokenProfile.failureRate,
          });
          notes.push('Token profile derived from optimize run telemetry (prefer p95 when present).');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to read run';
        if (msg.includes('Invalid optimize') || msg.includes('ENOENT') || msg.includes('not found')) {
          return Response.json({ error: `Run not found: ${runId}` }, { status: 404 });
        }
        return Response.json({ error: msg }, { status: 400 });
      }
    }
  }

  try {
    const result = compareModels({
      request: {
        modelIds,
        tokenProfile,
        weights,
        baselineModelId,
        qualitySource,
        runId: body.runId,
        goodEnoughSeconds: body.goodEnoughSeconds,
        split: body.split,
      },
      registry,
      runQualities,
    });
    if (notes.length) result.notes.push(...notes);

    assertNoCurrencyInValue(result, 'CompareResult');

    const url = new URL(request.url);
    const exportMd = body.exportMd || url.searchParams.get('export') === 'md';
    if (exportMd) {
      const md = compareResultToMarkdown(result);
      return new Response(md, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="compare-report.md"',
        },
      });
    }

    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Compare failed' },
      { status: 400 },
    );
  }
}
