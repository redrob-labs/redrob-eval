import type { AxisId, AxisScore, Weights } from './types';

const AXES: AxisId[] = ['quality', 'preference', 'cost', 'speed'];

export function presentAxesFromScores(axes: Record<AxisId, AxisScore>): AxisId[] {
  return AXES.filter((a) => axes[a].score != null && Number.isFinite(axes[a].score!));
}

/**
 * Renormalize weights over axes that have data. Never zero-fill missing axes.
 */
export function renormalizeWeights(weights: Weights, present: AxisId[]): Weights {
  if (present.length === 0) {
    return { quality: 0, preference: 0, cost: 0, speed: 0 };
  }
  let sum = 0;
  for (const a of present) sum += Math.max(0, weights[a]);
  if (sum <= 0) {
    const eq = 1 / present.length;
    const out: Weights = { quality: 0, preference: 0, cost: 0, speed: 0 };
    for (const a of present) out[a] = eq;
    return out;
  }
  const out: Weights = { quality: 0, preference: 0, cost: 0, speed: 0 };
  for (const a of present) out[a] = Math.max(0, weights[a]) / sum;
  return out;
}

export function compositeScore(
  axes: Record<AxisId, AxisScore>,
  weights: Weights,
): AxisScore {
  const present = presentAxesFromScores(axes);
  if (present.length === 0) {
    return { score: null, feedback: 'No axes present — cannot score.' };
  }
  const w = renormalizeWeights(weights, present);
  let total = 0;
  for (const a of present) {
    total += (axes[a].score as number) * w[a];
  }
  const missing = AXES.filter((a) => !present.includes(a));
  const feedback =
    missing.length > 0
      ? `Composite ${total.toFixed(1)} on ${present.length}/4 axes (renormalized; missing: ${missing.join(', ')}). Not comparable to rows scored on all four.`
      : `Composite ${total.toFixed(1)} on all four axes.`;
  return { score: total, feedback };
}

export { AXES as COMPARE_AXES };
