/**
 * Bisect for the axis value a model would need to reach targetRank (1 = best).
 * `evaluate(hypothetical)` must return the model's 1-based rank when the missing
 * axis is set to `hypothetical`. Search is monotonic in the improve direction.
 */
export function breakEvenForRank(params: {
  targetRank: number;
  evaluate: (hypothetical: number) => number;
  lo: number;
  hi: number;
  /** true when higher axis values improve rank (quality/preference/speed); false for cost/wall-clock */
  higherIsBetter: boolean;
  tol?: number;
  maxIters?: number;
}): { value: number | null; feedback: string } {
  const { targetRank, evaluate, higherIsBetter } = params;
  const tol = params.tol ?? 1e-4;
  const maxIters = params.maxIters ?? 64;
  let lo = params.lo;
  let hi = params.hi;

  if (!(lo < hi)) {
    return { value: null, feedback: 'break-even: lo must be < hi.' };
  }
  if (!(targetRank >= 1)) {
    return { value: null, feedback: 'break-even: targetRank must be ≥ 1.' };
  }

  const rankAt = (x: number) => evaluate(x);
  const loRank = rankAt(lo);
  const hiRank = rankAt(hi);

  const meets = (rank: number) => rank <= targetRank;

  // Determine which end can satisfy
  if (!meets(loRank) && !meets(hiRank)) {
    return {
      value: null,
      feedback: `Cannot reach rank ${targetRank} within [${lo}, ${hi}] (ranks ${loRank}…${hiRank}).`,
    };
  }

  // Find minimal improvement: for higherIsBetter, smallest x with rank≤target;
  // for lowerIsBetter (cost), smallest cost? Actually "value needed" for cost means
  // max relative cost still achieving rank k → bisect toward lower cost from hi.
  if (higherIsBetter) {
    // Want smallest x such that meets(rank(x))
    if (meets(loRank)) {
      return { value: lo, feedback: `Already at rank ≤${targetRank} at lo=${lo}.` };
    }
    for (let i = 0; i < maxIters && hi - lo > tol; i++) {
      const mid = (lo + hi) / 2;
      if (meets(rankAt(mid))) hi = mid;
      else lo = mid;
    }
    return {
      value: hi,
      feedback: `Needs ≈${hi.toFixed(4)} on missing axis to reach rank ${targetRank}.`,
    };
  }

  // lower is better (e.g. relative cost % or wall-clock)
  if (meets(hiRank) && !meets(loRank)) {
    // hi is worse value numerically if higher=worse... wait:
    // cost: lower better. lo=cheap, hi=expensive. meets at lo hopefully.
  }
  if (meets(hiRank) && loRank > targetRank) {
    // unusual orientation
  }
  if (meets(loRank)) {
    // Already good at the better end; find largest value that still meets
    // (most relaxed requirement)
    let a = lo;
    let b = hi;
    if (!meets(rankAt(b))) {
      for (let i = 0; i < maxIters && b - a > tol; i++) {
        const mid = (a + b) / 2;
        if (meets(rankAt(mid))) a = mid;
        else b = mid;
      }
      return {
        value: a,
        feedback: `Needs ≤≈${a.toFixed(4)} on missing axis to reach rank ${targetRank}.`,
      };
    }
    return {
      value: hi,
      feedback: `Entire range [${lo}, ${hi}] achieves rank ≤${targetRank}.`,
    };
  }

  return {
    value: null,
    feedback: `Cannot reach rank ${targetRank} within [${lo}, ${hi}].`,
  };
}
