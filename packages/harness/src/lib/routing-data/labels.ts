import type { ModelCallRecord, RouteLabel } from './types';

/**
 * Outcome-supervised labeling.
 *
 * Prefer small when it is "good enough" (score ≥ threshold).
 * Otherwise escalate to large.
 *
 * This is the training target for a routing SLM — not heuristic difficulty.
 */
export function labelRoute(params: {
  small: ModelCallRecord;
  large: ModelCallRecord;
  smallOkThreshold: number;
}): { label: RouteLabel; reason: string } {
  const thr = Math.min(1, Math.max(0, params.smallOkThreshold));
  const { small, large } = params;

  if (small.error && !large.error) {
    return { label: 'large', reason: `small error: ${small.error}` };
  }
  if (small.error && large.error) {
    // Both failed — still label large (cannot trust small); SLM may learn to escalate hard fails
    return { label: 'large', reason: 'both errored; default escalate' };
  }
  if (!small.error && small.score >= thr) {
    return {
      label: 'small',
      reason: `small score ${small.score.toFixed(3)} ≥ threshold ${thr}`,
    };
  }
  if (!large.error && large.score > small.score) {
    return {
      label: 'large',
      reason: `small score ${small.score.toFixed(3)} < ${thr}; large better (${large.score.toFixed(3)})`,
    };
  }
  return {
    label: 'large',
    reason: `small score ${small.score.toFixed(3)} < threshold ${thr}`,
  };
}

/** Default threshold by metric family — exact-match tasks want near-perfect small answers. */
export function defaultSmallOkThreshold(metric: string): number {
  if (metric === 'gsm8k_exact' || metric === 'accuracy') return 0.99;
  if (metric === 'chrf') return 0.55;
  if (metric === 'qwk' || metric === 'cohens_kappa' || metric === 'checklist_composite') {
    return 0.6;
  }
  return 0.9;
}
