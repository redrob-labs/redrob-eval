import type { MetricId } from '../../config/datasets';
import type { ModelRef } from '../../config/models';
import type { EvalSampleResult, EvalTargetSummary } from './types';
import { ROUTER_TARGET_ID } from './types';

export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function summarizeTarget(params: {
  targetId: string;
  label: string;
  kind: 'model' | 'router';
  metric: MetricId;
  sampleResults: EvalSampleResult[];
  /** Per-sample relative cost weights (aligned with sampleResults) */
  costWeights: number[];
  largeBaselineWeight: number;
}): EvalTargetSummary {
  const ok = params.sampleResults.filter((r) => !r.error);
  const quality = mean(params.sampleResults.map((r) => r.score));
  const meanLatencyMs = mean(ok.map((r) => r.latencyMs));
  const meanRelativeCost = mean(params.costWeights);
  const baseline = params.largeBaselineWeight > 0 ? params.largeBaselineWeight : 100;
  const relativeCostPct = (meanRelativeCost / baseline) * 100;

  let routingPolicyAccuracy: number | undefined;
  if (params.kind === 'router') {
    const routed = params.sampleResults.filter((r) => r.route);
    const correct = routed.filter((r) => {
      const want = r.route!.complexity === 'hard' ? 'large' : 'small';
      return r.route!.chosenTier === want;
    });
    routingPolicyAccuracy = routed.length ? correct.length / routed.length : 1;
  }

  return {
    targetId: params.targetId,
    label: params.label,
    kind: params.kind,
    metric: params.metric,
    n: params.sampleResults.length,
    quality,
    meanLatencyMs,
    meanRelativeCost,
    relativeCostPct,
    sampleResults: params.sampleResults,
    routingPolicyAccuracy,
  };
}

/** Attach quality retention + optional oracle routing accuracy using small-model results. */
export function enrichSummaries(
  targets: EvalTargetSummary[],
  opts: {
    largeBaselineId: string | null;
    smallModelId: string | null;
  },
): EvalTargetSummary[] {
  const large = opts.largeBaselineId
    ? targets.find((t) => t.targetId === opts.largeBaselineId)
    : null;
  const small = opts.smallModelId
    ? targets.find((t) => t.targetId === opts.smallModelId)
    : null;
  const router = targets.find((t) => t.targetId === ROUTER_TARGET_ID);

  return targets.map((t) => {
    const qualityRetention =
      large && large.quality > 0 ? t.quality / large.quality : null;

    let routingOracleAccuracy: number | null | undefined = t.routingOracleAccuracy;
    if (t.targetId === ROUTER_TARGET_ID && router && small) {
      const smallById = new Map(small.sampleResults.map((r) => [r.sampleId, r]));
      let n = 0;
      let hit = 0;
      for (const r of router.sampleResults) {
        if (!r.route) continue;
        const s = smallById.get(r.sampleId);
        if (!s || s.error) continue;
        // Oracle: if small scored perfectly (or ≥ 0.99), sample is "easy" → should be small
        const oracleTier: 'small' | 'large' = s.score >= 0.99 ? 'small' : 'large';
        n += 1;
        if (r.route.chosenTier === oracleTier) hit += 1;
      }
      routingOracleAccuracy = n > 0 ? hit / n : null;
    }

    return {
      ...t,
      qualityRetention,
      routingOracleAccuracy:
        t.targetId === ROUTER_TARGET_ID ? routingOracleAccuracy ?? null : undefined,
    };
  });
}

export function pickLargeBaseline(
  models: ModelRef[],
  preferredId?: string | null,
): ModelRef | null {
  if (preferredId) {
    const pref = models.find((m) => m.id === preferredId);
    if (pref) return pref;
  }
  const larges = models.filter((m) => m.tier === 'large');
  if (larges.length === 0) {
    return models.slice().sort((a, b) => b.relativeCostWeight - a.relativeCostWeight)[0] ?? null;
  }
  return larges.slice().sort((a, b) => b.relativeCostWeight - a.relativeCostWeight)[0]!;
}
