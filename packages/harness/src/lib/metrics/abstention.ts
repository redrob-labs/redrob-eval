/**
 * Abstention rate — tracked separately from agreement metrics.
 * Abstaining on bad lighting/angle/focus is correct behavior and must not
 * be folded into QWK as a wrong answer.
 */

import { isAbstention } from './qwk';

export interface AbstentionRateResult {
  score: number;
  feedback: string;
  n: number;
  abstained: number;
}

export function abstentionRate(predictions: string[]): AbstentionRateResult {
  const n = predictions.length;
  if (n === 0) {
    return { score: 0, feedback: 'No predictions; abstention rate = 0.', n: 0, abstained: 0 };
  }
  let abstained = 0;
  for (const p of predictions) {
    if (isAbstention(p)) abstained += 1;
  }
  const rate = abstained / n;
  return {
    score: rate,
    feedback: `Abstention rate=${rate.toFixed(3)} (${abstained}/${n}); excluded from QWK denominators.`,
    n,
    abstained,
  };
}

export function abstentionPairFeedback(prediction: string): AbstentionRateResult {
  const abstained = isAbstention(prediction) ? 1 : 0;
  return {
    score: abstained,
    feedback: abstained
      ? 'Example abstained (input quality insufficient).'
      : 'Example scored (no abstention).',
    n: 1,
    abstained,
  };
}
