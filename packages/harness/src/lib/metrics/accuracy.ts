/**
 * Classification accuracy — exact label match after light normalization.
 */

export interface AccuracyResult {
  correct: boolean;
  score: number; // 0 or 1
  gold: string;
  prediction: string;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function accuracyMatch(gold: string, prediction: string): AccuracyResult {
  const g = normalizeLabel(gold);
  const p = normalizeLabel(prediction);
  // Allow "label: 2" / "Label 2" style model answers for int ClassLabels
  const goldNum = g.match(/^-?\d+$/)?.[0];
  const goldLetter = g.match(/^[a-d]$/)?.[0];
  let predNorm = p;
  if (goldNum != null) {
    const m = p.match(/-?\d+/);
    if (m) predNorm = m[0]!;
  } else if (goldLetter != null) {
    const letters = [...p.matchAll(/\b([a-d])\b/gi)].map((m) => m[1]!.toLowerCase());
    if (letters.length > 0) predNorm = letters[letters.length - 1]!;
  }
  const correct = g === predNorm || g === p;
  return {
    correct,
    score: correct ? 1 : 0,
    gold: g,
    prediction: predNorm,
  };
}

export function meanAccuracy(pairs: Array<{ gold: string; prediction: string }>): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const p of pairs) sum += accuracyMatch(p.gold, p.prediction).score;
  return sum / pairs.length;
}
