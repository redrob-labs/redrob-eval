import { NextResponse } from 'next/server';
import type { MetricId } from '@redrob/harness';
import { scorePair, scorePairs } from '@redrob/harness';
import { METRIC_FIXTURES, runMetricFixtures } from '@redrob/harness';

export const runtime = 'nodejs';

const METRICS = new Set<MetricId>(['chrf', 'accuracy', 'gsm8k_exact']);

type ScoreBody = {
  /** Run built-in unit fixtures (no dataset / model needed) */
  fixtures?: boolean;
  metric?: MetricId;
  gold?: string;
  prediction?: string;
  pairs?: Array<{ gold: string; prediction: string }>;
};

/**
 * POST /api/score
 * - { "fixtures": true } → self-check all metrics
 * - { "metric": "chrf", "gold": "...", "prediction": "..." }
 * - { "metric": "gsm8k_exact", "pairs": [{ gold, prediction }, ...] }
 */
export async function POST(request: Request) {
  let body: ScoreBody;
  try {
    body = (await request.json()) as ScoreBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.fixtures) {
    const results = runMetricFixtures();
    const passed = results.every((r) => r.pass);
    return NextResponse.json({
      ok: passed,
      fixtures: results,
      catalog: METRIC_FIXTURES.map((f) => ({
        id: f.id,
        metric: f.metric,
        note: f.note,
      })),
    });
  }

  if (!body.metric || !METRICS.has(body.metric)) {
    return NextResponse.json(
      {
        error: 'Provide metric: chrf | accuracy | gsm8k_exact (or fixtures: true)',
      },
      { status: 400 },
    );
  }

  if (body.pairs && Array.isArray(body.pairs)) {
    const result = scorePairs(body.metric, body.pairs);
    return NextResponse.json({ ok: true, ...result });
  }

  if (body.gold == null || body.prediction == null) {
    return NextResponse.json(
      {
        error: 'Provide gold + prediction, or pairs[], or fixtures: true',
      },
      { status: 400 },
    );
  }

  const result = scorePair(body.metric, body.gold, body.prediction);
  return NextResponse.json({ ok: true, ...result });
}

/** GET /api/score — run fixtures (convenient for curl smoke checks). */
export async function GET() {
  const results = runMetricFixtures();
  const passed = results.every((r) => r.pass);
  return NextResponse.json({
    ok: passed,
    fixtures: results,
  });
}
