import type { MetricId } from '../../config/datasets';
import { accuracyMatch, meanAccuracy } from './accuracy';
import { chrf, meanChrF } from './chrf';
import { gsm8kExactMatch, meanGsm8kExact } from './gsm8k';

export interface ScorePair {
  gold: string;
  prediction: string;
}

export interface ScoreResult {
  metric: MetricId;
  /** Aggregate score in [0, 1] */
  score: number;
  n: number;
  /**
   * Natural-language explanation of the score (why it failed / what matched).
   * Required for GEPA reflection in Phase 2; Phase 1 keeps numeric scores unchanged.
   */
  feedback: string;
  details?: unknown;
}

function feedbackChrF(score: number, gold: string, prediction: string): string {
  if (!prediction.trim()) return 'Empty prediction; chrF is zero against the reference.';
  if (score >= 0.95) return 'Near-exact character n-gram overlap with the reference.';
  if (score >= 0.55) return `Partial overlap with the reference (chrF=${score.toFixed(3)}).`;
  if (score >= 0.2) {
    return `Low character n-gram overlap (chrF=${score.toFixed(3)}); translation drifts from the reference.`;
  }
  return `Very low chrF (${score.toFixed(3)}); hypothesis and reference share little character overlap. Gold starts: "${gold.slice(0, 40)}…"`;
}

function feedbackAccuracy(correct: boolean, gold: string, prediction: string): string {
  if (correct) return `Label matched after normalization (gold="${gold}").`;
  return `Label mismatch: expected "${gold}", got "${prediction || '(empty)'}".`;
}

function feedbackGsm8k(
  correct: boolean,
  gold: string | null,
  prediction: string | null,
): string {
  if (correct) return `Numeric answer matched (extracted ${prediction}).`;
  if (prediction == null) return `Could not extract a numeric answer; gold was ${gold ?? '(none)'}.`;
  return `Numeric mismatch: predicted ${prediction}, gold ${gold ?? '(none)'}.`;
}

export function scorePair(metric: MetricId, gold: string, prediction: string): ScoreResult {
  switch (metric) {
    case 'chrf': {
      const r = chrf(prediction, gold);
      return {
        metric,
        score: r.score,
        n: 1,
        feedback: feedbackChrF(r.score, gold, prediction),
        details: r,
      };
    }
    case 'accuracy': {
      const r = accuracyMatch(gold, prediction);
      return {
        metric,
        score: r.score,
        n: 1,
        feedback: feedbackAccuracy(r.correct, r.gold, r.prediction),
        details: r,
      };
    }
    case 'gsm8k_exact': {
      const r = gsm8kExactMatch(gold, prediction);
      return {
        metric,
        score: r.score,
        n: 1,
        feedback: feedbackGsm8k(r.correct, r.gold, r.prediction),
        details: r,
      };
    }
    case 'llm_judge':
      throw new Error(
        'llm_judge is async; use llmJudgeScore() from evaluateCandidate, not scorePair()',
      );
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unknown metric: ${_exhaustive}`);
    }
  }
}

export function scorePairs(metric: MetricId, pairs: ScorePair[]): ScoreResult {
  if (pairs.length === 0) {
    return { metric, score: 0, n: 0, feedback: 'No pairs to score.' };
  }
  switch (metric) {
    case 'chrf':
      return {
        metric,
        score: meanChrF(pairs.map((p) => ({ hypothesis: p.prediction, reference: p.gold }))),
        n: pairs.length,
        feedback: `Mean chrF over ${pairs.length} pairs.`,
      };
    case 'accuracy':
      return {
        metric,
        score: meanAccuracy(pairs),
        n: pairs.length,
        feedback: `Mean accuracy over ${pairs.length} pairs.`,
      };
    case 'gsm8k_exact':
      return {
        metric,
        score: meanGsm8kExact(pairs),
        n: pairs.length,
        feedback: `Mean GSM8K exact-match over ${pairs.length} pairs.`,
      };
    case 'llm_judge':
      throw new Error(
        'llm_judge aggregation is handled per-example in evaluateCandidate',
      );
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unknown metric: ${_exhaustive}`);
    }
  }
}

export { accuracyMatch, meanAccuracy } from './accuracy';
export { chrf, meanChrF } from './chrf';
export { extractGsm8kAnswer, gsm8kExactMatch, meanGsm8kExact } from './gsm8k';
export {
  llmJudgeScore,
  buildJudgePrompt,
  parseJudgeResponseForTest,
} from './llm-judge';
