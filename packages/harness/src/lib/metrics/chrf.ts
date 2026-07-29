/**
 * Character n-gram F-score (chrF) — Popović 2015 style.
 * Pure TypeScript; no Python / sacrebleu dependency.
 *
 * Defaults match common MT eval practice: char order 1..6, β=2 (chrF2).
 */

export interface ChrFOptions {
  /** Max character n-gram order (inclusive). Default 6. */
  charOrder?: number;
  /** F-score β. Default 2 (recall-weighted). */
  beta?: number;
  /** If true, collapse whitespace to single spaces. Default true. */
  normalizeWhitespace?: boolean;
}

export interface ChrFResult {
  score: number;
  precision: number;
  recall: number;
  /** Same as score — 0..1 scale (not ×100). */
  chrf: number;
}

function prepareText(text: string, normalizeWhitespace: boolean): string {
  let s = text.normalize('NFC');
  if (normalizeWhitespace) {
    s = s.replace(/\s+/g, ' ').trim();
  }
  return s;
}

function ngramCounts(text: string, n: number): Map<string, number> {
  const counts = new Map<string, number>();
  if (text.length < n) return counts;
  for (let i = 0; i <= text.length - n; i += 1) {
    const gram = text.slice(i, i + n);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function overlap(hyp: Map<string, number>, ref: Map<string, number>): number {
  let matched = 0;
  for (const [gram, hypCount] of hyp) {
    const refCount = ref.get(gram);
    if (refCount) matched += Math.min(hypCount, refCount);
  }
  return matched;
}

function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const c of counts.values()) total += c;
  return total;
}

/**
 * Compute chrF between a hypothesis and a reference.
 * Returns scores in [0, 1]. Identical strings → 1.
 */
export function chrf(hypothesis: string, reference: string, options?: ChrFOptions): ChrFResult {
  const charOrder = options?.charOrder ?? 6;
  const beta = options?.beta ?? 2;
  const normalizeWhitespace = options?.normalizeWhitespace ?? true;

  const hyp = prepareText(hypothesis, normalizeWhitespace);
  const ref = prepareText(reference, normalizeWhitespace);

  if (hyp.length === 0 && ref.length === 0) {
    return { score: 1, precision: 1, recall: 1, chrf: 1 };
  }
  if (hyp.length === 0 || ref.length === 0) {
    return { score: 0, precision: 0, recall: 0, chrf: 0 };
  }

  let precSum = 0;
  let recSum = 0;
  let nEffective = 0;

  for (let n = 1; n <= charOrder; n += 1) {
    const hypN = ngramCounts(hyp, n);
    const refN = ngramCounts(ref, n);
    const hypTotal = sumCounts(hypN);
    const refTotal = sumCounts(refN);
    if (hypTotal === 0 || refTotal === 0) continue;

    const matched = overlap(hypN, refN);
    precSum += matched / hypTotal;
    recSum += matched / refTotal;
    nEffective += 1;
  }

  if (nEffective === 0) {
    return { score: 0, precision: 0, recall: 0, chrf: 0 };
  }

  const precision = precSum / nEffective;
  const recall = recSum / nEffective;
  const beta2 = beta * beta;
  const denom = beta2 * precision + recall;
  const score = denom === 0 ? 0 : ((1 + beta2) * precision * recall) / denom;

  return { score, precision, recall, chrf: score };
}

/** Mean chrF over paired hypothesis/reference lists. */
export function meanChrF(
  pairs: Array<{ hypothesis: string; reference: string }>,
  options?: ChrFOptions,
): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const p of pairs) {
    sum += chrf(p.hypothesis, p.reference, options).score;
  }
  return sum / pairs.length;
}
