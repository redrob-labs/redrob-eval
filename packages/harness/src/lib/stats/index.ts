/**
 * The statistics an eval needs to be believed.
 *
 * Two accuracy numbers side by side invite exactly one question - is that
 * difference real - and a workbench that cannot answer it leaves everyone
 * guessing from point estimates. On the sizes these evals run at, that guess is
 * usually wrong: 81 items is enough to separate 60% from 95% and nowhere near
 * enough to separate 91% from 94%.
 *
 * Everything here is paired, because these evals are: every model answers the
 * same items. A paired test is far more powerful than comparing two independent
 * proportions, and using the independent version on paired data throws away the
 * pairing that was expensive to arrange.
 *
 * Everything here is also deterministic. A confidence interval that moves when
 * you re-run it cannot go in a paper, so the bootstrap takes a seed.
 */

/** z for a two-sided 95% interval. */
const Z_95 = 1.959963984540054;

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a proportion.
 *
 * Not the normal approximation: at the denominators these slices have - an
 * absence rate over 13 items - `p ± z·sqrt(p(1-p)/n)` produces bounds below zero
 * or above one, and is badly wrong exactly when p is near 0 or 1, which is where
 * most of these rates sit.
 */
export function wilsonInterval(successes: number, n: number, z = Z_95): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, (centre - spread) / denom),
    high: Math.min(1, (centre + spread) / denom),
  };
}

/** Two-sided binomial tail probability, used for the exact McNemar test. */
function binomialTwoSided(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  // Under the null each discordant pair is a fair coin, so sum the tail at or
  // beyond the observed imbalance, both ways.
  const k = Math.min(b, c);
  let logFactorial = 0;
  const logFact: number[] = [0];
  for (let i = 1; i <= n; i += 1) {
    logFactorial += Math.log(i);
    logFact.push(logFactorial);
  }
  let tail = 0;
  for (let i = 0; i <= k; i += 1) {
    const logP = logFact[n]! - logFact[i]! - logFact[n - i]! - n * Math.LN2;
    tail += Math.exp(logP);
  }
  return Math.min(1, 2 * tail);
}

export interface McNemarResult {
  /** Items the first model got right and the second got wrong. */
  aOnly: number;
  /** Items the second got right and the first got wrong. */
  bOnly: number;
  /** Items they agreed on, which carry no information about the difference. */
  agreed: number;
  /** Exact two-sided p value. */
  p: number;
}

/**
 * McNemar's exact test on paired binary outcomes.
 *
 * Only the disagreements carry information: items both models got right, or both
 * got wrong, say nothing about which is better. The exact binomial form is used
 * rather than the chi-square approximation because the discordant counts here
 * are routinely single digits, where the approximation is not trustworthy.
 */
export function mcnemar(a: boolean[], b: boolean[]): McNemarResult {
  if (a.length !== b.length) {
    throw new Error('mcnemar needs the same items for both models, in the same order');
  }
  let aOnly = 0;
  let bOnly = 0;
  let agreed = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) agreed += 1;
    else if (a[i]) aOnly += 1;
    else bOnly += 1;
  }
  return { aOnly, bOnly, agreed, p: binomialTwoSided(aOnly, bOnly) };
}

/**
 * Deterministic RNG (mulberry32), so an interval is the same every time it is
 * computed. A result that moves on re-run cannot be cited.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedDiffResult {
  /** Mean of a minus mean of b. */
  diff: number;
  meanA: number;
  meanB: number;
  interval: Interval;
  n: number;
  /** True when the interval excludes zero at the level used. */
  significant: boolean;
}

/**
 * Paired bootstrap confidence interval for the difference of two means.
 *
 * Items are resampled, not scores: the pairing is the point, so a resample takes
 * both models' outcomes on the same drawn item. Works for any per-item score, so
 * the same function covers a 0/1 correctness rate and a continuous one.
 */
export function pairedBootstrapDiff(
  a: number[],
  b: number[],
  options: { iterations?: number; seed?: number; level?: number } = {},
): PairedDiffResult {
  if (a.length !== b.length) {
    throw new Error('a paired bootstrap needs the same items for both models');
  }
  const n = a.length;
  const iterations = options.iterations ?? 2000;
  const level = options.level ?? 0.95;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const meanA = mean(a);
  const meanB = mean(b);
  if (n === 0) {
    return { diff: 0, meanA, meanB, interval: { low: 0, high: 0 }, n, significant: false };
  }

  const random = rng(options.seed ?? 12345);
  const diffs: number[] = [];
  for (let it = 0; it < iterations; it += 1) {
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < n; i += 1) {
      const pick = Math.floor(random() * n);
      sumA += a[pick]!;
      sumB += b[pick]!;
    }
    diffs.push(sumA / n - sumB / n);
  }
  diffs.sort((x, y) => x - y);
  const alpha = (1 - level) / 2;
  const at = (q: number) =>
    diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(q * diffs.length)))]!;
  const interval = { low: at(alpha), high: at(1 - alpha) };
  return {
    diff: meanA - meanB,
    meanA,
    meanB,
    interval,
    n,
    significant: interval.low > 0 || interval.high < 0,
  };
}

/**
 * Holm-Bonferroni adjustment, in the input order.
 *
 * Comparing eight models pairwise is 28 tests, and at that point one p under
 * 0.05 is expected from noise alone. Holm rather than plain Bonferroni because
 * it is uniformly more powerful at the same guarantee.
 */
export function holmAdjust(pValues: number[]): number[] {
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    const scaled = Math.min(1, p * (pValues.length - rank));
    // Monotone: an adjusted p can never fall below one for a smaller raw p.
    running = Math.max(running, scaled);
    adjusted[index] = running;
  });
  return adjusted;
}

/**
 * Whether a comparison can support a claim at all.
 *
 * Reported next to every result rather than left to the reader, because the
 * failure mode is not a wrong number - it is a true number that cannot carry
 * the weight put on it. The thresholds are conventions, and named as such.
 */
export function powerWarnings(params: {
  n: number;
  discordant?: number;
}): string[] {
  const out: string[] = [];
  if (params.n === 0) return ['no shared items, so nothing can be compared'];
  if (params.n < 30) {
    out.push(`only ${params.n} shared item(s): treat any difference as a hint, not a result`);
  }
  if (params.discordant != null && params.discordant < 10 && params.discordant > 0) {
    out.push(
      `the models disagreed on only ${params.discordant} item(s), which is what the test is powered by`,
    );
  }
  if (params.discordant === 0) {
    out.push('the models never disagreed, so no test can separate them');
  }
  return out;
}
