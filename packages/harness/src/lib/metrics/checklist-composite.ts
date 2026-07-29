/**
 * Checklist composite: per-item binary judgments → weighted sum → optional
 * isotonic calibration against a human scale.
 *
 * Never ask the model for a holistic total; always decompose first, sum second.
 */

import { parseBinaryLabels } from './cohens-kappa';
import { isAbstention, parseOrdinal } from './qwk';

export interface ChecklistCompositeResult {
  score: number;
  feedback: string;
  /** Raw weighted sum before mapping to [0,1] agreement with human */
  composite: number | null;
  humanTotal: number | null;
  abstained: boolean;
}

export interface IsotonicPoint {
  /** Model composite (weighted sum) */
  x: number;
  /** Human total / scale value */
  y: number;
}

/**
 * Pool-adjacent-violators isotonic regression (non-decreasing).
 * Returns calibrated predictions ŷ for each x in `xs` given training pairs.
 */
export function isotonicFit(train: IsotonicPoint[]): IsotonicPoint[] {
  if (train.length === 0) return [];
  const sorted = [...train].sort((a, b) => a.x - b.x || a.y - b.y);
  const xs = sorted.map((p) => p.x);
  const ys = sorted.map((p) => p.y);
  // PAV
  const blocks: { sumY: number; n: number; start: number; end: number }[] = [];
  for (let i = 0; i < ys.length; i++) {
    blocks.push({ sumY: ys[i]!, n: 1, start: i, end: i });
    while (
      blocks.length >= 2 &&
      blocks[blocks.length - 2]!.sumY / blocks[blocks.length - 2]!.n >
        blocks[blocks.length - 1]!.sumY / blocks[blocks.length - 1]!.n
    ) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      blocks.push({
        sumY: a.sumY + b.sumY,
        n: a.n + b.n,
        start: a.start,
        end: b.end,
      });
    }
  }
  const calibrated = new Array(ys.length);
  for (const b of blocks) {
    const mean = b.sumY / b.n;
    for (let i = b.start; i <= b.end; i++) calibrated[i] = mean;
  }
  return xs.map((x, i) => ({ x, y: calibrated[i]! }));
}

/** Piecewise-constant prediction from fitted isotonic curve. */
export function isotonicPredict(curve: IsotonicPoint[], x: number): number {
  if (curve.length === 0) return x;
  if (x <= curve[0]!.x) return curve[0]!.y;
  if (x >= curve[curve.length - 1]!.x) return curve[curve.length - 1]!.y;
  for (let i = 1; i < curve.length; i++) {
    if (x <= curve[i]!.x) {
      const a = curve[i - 1]!;
      const b = curve[i]!;
      if (b.x === a.x) return b.y;
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return curve[curve.length - 1]!.y;
}

function parseWeights(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  return raw as number[];
}

/**
 * Score one clip: model checklist binaries vs human total (and optional item gold).
 *
 * Gold formats:
 * - `{"items":[0,1,...],"total":3,"weights":[1,1,...]}`
 * - plain ordinal total
 *
 * Prediction formats:
 * - `{"items":[0,1,...]}` (preferred)
 * - binary array / CSV
 * - abstain
 */
export function checklistCompositeScore(
  gold: string,
  prediction: string,
  options?: { calibrationCurve?: IsotonicPoint[] },
): ChecklistCompositeResult {
  if (isAbstention(prediction)) {
    return {
      score: 0,
      feedback: 'Model abstained from scoring; not counted as a checklist error for QWK.',
      composite: null,
      humanTotal: null,
      abstained: true,
    };
  }

  let weights: number[] | null = null;
  let humanItems: number[] | null = null;
  let humanTotal = parseOrdinal(gold);

  try {
    const g = JSON.parse(gold.trim()) as Record<string, unknown>;
    if (g && typeof g === 'object') {
      weights = parseWeights(g.weights);
      if (Array.isArray(g.items)) humanItems = parseBinaryLabels(JSON.stringify(g.items));
      if (typeof g.total === 'number') humanTotal = g.total;
    }
  } catch {
    /* plain ordinal gold */
  }

  const predItems = parseBinaryLabels(prediction);
  if (!predItems) {
    // Fall back: treat prediction as a holistic number — discouraged, score harshly
    const p = parseOrdinal(prediction);
    if (p != null && humanTotal != null) {
      const err = Math.abs(p - humanTotal);
      const denom = Math.max(1, Math.abs(humanTotal));
      const score = Math.max(0, 1 - err / denom);
      return {
        score,
        feedback:
          'Prediction looks like a holistic total; prefer per-item checklist JSON. ' +
          `Agreement proxy=${score.toFixed(3)}.`,
        composite: p,
        humanTotal,
        abstained: false,
      };
    }
    return {
      score: 0,
      feedback: 'Could not parse checklist item judgments from prediction.',
      composite: null,
      humanTotal,
      abstained: false,
    };
  }

  const w =
    weights && weights.length === predItems.length
      ? weights
      : predItems.map(() => 1);
  const composite = predItems.reduce((s, v, i) => s + v * (w[i] ?? 1), 0);

  let mapped = composite;
  if (options?.calibrationCurve?.length) {
    mapped = isotonicPredict(options.calibrationCurve, composite);
  }

  if (humanTotal == null && humanItems) {
    const hw =
      weights && weights.length === humanItems.length
        ? weights
        : humanItems.map(() => 1);
    humanTotal = humanItems.reduce((s, v, i) => s + v * (hw[i] ?? 1), 0);
  }

  if (humanTotal == null) {
    return {
      score: 0,
      feedback: `Composite sum=${composite} but no human total/items to compare.`,
      composite,
      humanTotal: null,
      abstained: false,
    };
  }

  const err = Math.abs(mapped - humanTotal);
  const denom = Math.max(1, Math.abs(humanTotal), w.reduce((a, b) => a + b, 0));
  const score = Math.max(0, 1 - err / denom);
  return {
    score,
    feedback: `Checklist composite=${composite}${
      options?.calibrationCurve?.length ? ` (calibrated→${mapped.toFixed(2)})` : ''
    }; human=${humanTotal}; agreement=${score.toFixed(3)}.`,
    composite,
    humanTotal,
    abstained: false,
  };
}
