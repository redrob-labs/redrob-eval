/**
 * Pearson r between two equal-length series (pairwise complete).
 */
export function pearsonR(
  xs: number[],
  ys: number[],
): { pearsonR: number | null; rSquared: number | null; feedback: string } {
  if (xs.length !== ys.length) {
    return { pearsonR: null, rSquared: null, feedback: 'Series length mismatch.' };
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  if (pairs.length < 3) {
    return {
      pearsonR: null,
      rSquared: null,
      feedback: `Need ≥3 paired points for Pearson r (got ${pairs.length}).`,
    };
  }
  const n = pairs.length;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX <= 0 || denY <= 0) {
    return {
      pearsonR: null,
      rSquared: null,
      feedback: 'Zero variance in quality or preference — correlation undefined.',
    };
  }
  const r = num / Math.sqrt(denX * denY);
  const rSquared = r * r;
  return {
    pearsonR: r,
    rSquared,
    feedback: `Pearson r=${r.toFixed(3)} (r²=${rSquared.toFixed(3)}) over ${n} models. Where quality and preference diverge, the composite does unearned work.`,
  };
}
