import type { EvalBatch, FrontierPoint } from '../types';

/** Hard quality floor — below floor is infeasible, not merely low-scoring. */
export function isFeasible(batch: EvalBatch, qualityFloor: number): boolean {
  return batch.quality >= qualityFloor;
}

/**
 * Compare feasible candidates: minimize tokens, then latency.
 * Never a weighted sum of quality and cost.
 * Returns true if `a` is strictly better than `b` under this rule.
 * Infeasible candidates lose to any feasible one.
 */
export function betterFeasible(
  a: EvalBatch,
  b: EvalBatch,
  qualityFloor: number,
): boolean {
  const aOk = isFeasible(a, qualityFloor);
  const bOk = isFeasible(b, qualityFloor);
  if (aOk && !bOk) return true;
  if (!aOk && bOk) return false;
  if (!aOk && !bOk) {
    // Both infeasible: prefer higher quality (closer to floor), then fewer tokens
    if (a.quality !== b.quality) return a.quality > b.quality;
    if (a.totalTokens !== b.totalTokens) return a.totalTokens < b.totalTokens;
    return a.latencyP50 < b.latencyP50;
  }
  if (a.totalTokens !== b.totalTokens) return a.totalTokens < b.totalTokens;
  return a.latencyP50 < b.latencyP50;
}

export function toFrontierPoint(
  candidateId: string,
  batch: EvalBatch,
  qualityFloor: number,
): FrontierPoint {
  return {
    candidateId,
    quality: batch.quality,
    totalTokens: batch.totalTokens,
    meanRelativeCost: batch.meanRelativeCost,
    feasible: isFeasible(batch, qualityFloor),
  };
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}
