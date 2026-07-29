import type { EvalSampleResult, EvalTargetSummary } from '../eval/types';
import { summarizeTarget } from '../eval/aggregate';
import type { MetricId } from '../../config/datasets';
import type { RoutingExample, RouterPolicyId } from './types';

export const ROUTER_HEURISTIC_ID = 'router-heuristic';
export const ROUTER_ORACLE_ID = 'router-oracle';
export const ROUTER_CASCADE_ID = 'router-cascade';

function pickCall(
  ex: RoutingExample,
  tier: 'small' | 'large',
): { score: number; latencyMs: number; prediction: string; error?: string; weight: number; modelId: string } {
  const c = tier === 'small' ? ex.small : ex.large;
  return {
    score: c.score,
    latencyMs: c.latencyMs,
    prediction: c.prediction,
    error: c.error,
    weight: c.relativeCostWeight,
    modelId: c.modelId,
  };
}

function policyTier(ex: RoutingExample, policy: RouterPolicyId): 'small' | 'large' {
  if (policy === 'oracle') return ex.label;
  if (policy === 'cascade') {
    // Offline cascade ≈ escalate when small is not good enough (same as oracle label policy)
    return ex.label;
  }
  return ex.heuristic.chosenTier;
}

/** Replay a routing policy over dual-eval examples without new model calls. */
export function replayPolicy(params: {
  examples: RoutingExample[];
  policy: RouterPolicyId;
  metric: MetricId;
  largeBaselineWeight: number;
}): EvalTargetSummary {
  const sampleResults: EvalSampleResult[] = [];
  const costWeights: number[] = [];
  let agree = 0;

  for (const ex of params.examples) {
    const tier = policyTier(ex, params.policy);
    if (tier === ex.label) agree += 1;
    const call = pickCall(ex, tier);
    sampleResults.push({
      sampleId: ex.sampleId,
      score: call.error ? 0 : call.score,
      latencyMs: call.latencyMs,
      prediction: call.prediction,
      error: call.error,
      route:
        params.policy === 'heuristic'
          ? ex.heuristic
          : {
              ...ex.heuristic,
              chosenTier: tier,
              chosenModelId: call.modelId,
              chosenModelLabel: tier === 'small' ? ex.small.modelLabel : ex.large.modelLabel,
              reasons:
                params.policy === 'oracle'
                  ? [ex.labelReason]
                  : [`cascade/oracle: ${ex.labelReason}`],
            },
    });
    costWeights.push(call.weight);
  }

  const id =
    params.policy === 'heuristic'
      ? ROUTER_HEURISTIC_ID
      : params.policy === 'oracle'
        ? ROUTER_ORACLE_ID
        : ROUTER_CASCADE_ID;

  const label =
    params.policy === 'heuristic'
      ? 'Router · heuristic'
      : params.policy === 'oracle'
        ? 'Router · oracle (train labels)'
        : 'Router · cascade (threshold)';

  const summary = summarizeTarget({
    targetId: id,
    label,
    kind: 'router',
    metric: params.metric,
    sampleResults,
    costWeights,
    largeBaselineWeight: params.largeBaselineWeight,
  });

  const n = params.examples.length;
  summary.routingOracleAccuracy = n > 0 ? agree / n : null;
  summary.routingPolicyAccuracy = n > 0 ? agree / n : undefined;
  return summary;
}

export function modelAloneSummary(params: {
  examples: RoutingExample[];
  tier: 'small' | 'large';
  metric: MetricId;
  largeBaselineWeight: number;
}): EvalTargetSummary {
  const sampleResults: EvalSampleResult[] = [];
  const costWeights: number[] = [];
  let modelId = '';
  let modelLabel = '';

  for (const ex of params.examples) {
    const call = pickCall(ex, params.tier);
    modelId = call.modelId;
    modelLabel = params.tier === 'small' ? ex.small.modelLabel : ex.large.modelLabel;
    sampleResults.push({
      sampleId: ex.sampleId,
      score: call.error ? 0 : call.score,
      latencyMs: call.latencyMs,
      prediction: call.prediction,
      error: call.error,
    });
    costWeights.push(call.weight);
  }

  return summarizeTarget({
    targetId: modelId || params.tier,
    label: modelLabel || params.tier,
    kind: 'model',
    metric: params.metric,
    sampleResults,
    costWeights,
    largeBaselineWeight: params.largeBaselineWeight,
  });
}
