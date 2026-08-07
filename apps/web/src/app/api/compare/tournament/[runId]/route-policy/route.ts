import { NextResponse } from 'next/server';
import {
  appendRoutingExamples,
  computeAndWriteCorpusStats,
  labelsFromPreference,
  makeRoutingRunId,
  preferenceRunMeta,
  readTournament,
  replayPolicy,
  writeRoutingMeta,
  writeRoutingSummary,
  type RoutingExample,
  type RoutingRunSummary,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

type Body = {
  smallModelId: string;
  largeModelId: string;
  /** Persist the labels into the shared routing corpus. */
  save?: boolean;
};

/**
 * POST /api/compare/tournament/[runId]/route-policy
 *
 * Turns the blind bracket outcomes into routing labels: the designated fast
 * model carries a prompt when it beat or tied the fallback, otherwise the
 * router escalates. Preview by default; `save: true` writes the examples into
 * the routing corpus so training and export pick them up unchanged.
 */
export async function POST(request: Request, context: Ctx) {
  const { runId } = await context.params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.smallModelId || !body.largeModelId) {
    return NextResponse.json(
      { error: 'Pick both a fast model and a fallback' },
      { status: 400 },
    );
  }
  if (body.smallModelId === body.largeModelId) {
    return NextResponse.json(
      { error: 'The fast model and the fallback must differ' },
      { status: 400 },
    );
  }

  try {
    const run = await readTournament(runId);
    const routingRunId = makeRoutingRunId(`pref-${run.meta.sourceRunId}`);

    const labelled = labelsFromPreference({
      brackets: run.brackets,
      votes: run.votes,
      smallModelId: body.smallModelId,
      largeModelId: body.largeModelId,
      runId: routingRunId,
      sourceRunId: run.meta.sourceRunId,
    });

    if (!labelled.examples.length) {
      return NextResponse.json(
        {
          error:
            'Neither model competed in these brackets. Pick two models that were in the run.',
        },
        { status: 400 },
      );
    }

    const first = labelled.examples[0]!;
    const oracle = replayPolicy({
      examples: labelled.examples,
      policy: 'oracle',
      metric: 'llm_judge',
      largeBaselineWeight: 1,
    });
    const heuristic = replayPolicy({
      examples: labelled.examples,
      policy: 'heuristic',
      metric: 'llm_judge',
      largeBaselineWeight: 1,
    });

    const meta = preferenceRunMeta({
      runId: routingRunId,
      sourceRunId: run.meta.sourceRunId,
      smallModelId: body.smallModelId,
      largeModelId: body.largeModelId,
      smallModelLabel: first.small.modelLabel,
      largeModelLabel: first.large.modelLabel,
      examples: labelled.examples,
    });

    const summary: RoutingRunSummary = {
      meta,
      saveRate: labelled.saveRate,
      // Preference "quality" is the win rate the policy reproduces, not a metric score.
      oracleQuality: oracle.quality,
      oracleRelativeCostPct: oracle.relativeCostPct,
      heuristicAgreeWithOracle: heuristic.routingOracleAccuracy ?? 0,
      smallAloneQuality:
        labelled.examples.filter((e: RoutingExample) => e.small.score > 0).length /
        labelled.examples.length,
      largeAloneQuality:
        labelled.examples.filter((e: RoutingExample) => e.large.score > 0).length /
        labelled.examples.length,
    };

    let saved = false;
    if (body.save) {
      await writeRoutingMeta(routingRunId, meta);
      await appendRoutingExamples(routingRunId, labelled.examples);
      await writeRoutingSummary(routingRunId, summary);
      await computeAndWriteCorpusStats();
      saved = true;
    }

    return NextResponse.json({
      saved,
      routingRunId,
      summary,
      skipped: labelled.skipped,
      examples: labelled.examples.map((e: RoutingExample) => ({
        sampleId: e.sampleId,
        input: e.input,
        label: e.label,
        labelReason: e.labelReason,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not derive a policy' },
      { status: 400 },
    );
  }
}
