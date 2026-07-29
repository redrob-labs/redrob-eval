import type { MetricId } from '../../config/datasets';
import { accuracyMatch, meanAccuracy } from './accuracy';
import { abstentionPairFeedback, abstentionRate } from './abstention';
import { checklistCompositeScore } from './checklist-composite';
import { chrf, meanChrF } from './chrf';
import { cohensKappaFromPair } from './cohens-kappa';
import { gsm8kExactMatch, meanGsm8kExact } from './gsm8k';
import { qwkFromPairs, qwkPairProxy } from './qwk';

export interface ScorePair {
  gold: string;
  prediction: string;
}

export interface ScoreResult {
  metric: MetricId;
  /** Aggregate score in [0, 1] (abstention_rate is a rate in [0,1], not quality) */
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
    case 'qwk': {
      const r = qwkPairProxy(gold, prediction);
      return { metric, score: r.score, n: r.n, feedback: r.feedback, details: r };
    }
    case 'cohens_kappa': {
      const r = cohensKappaFromPair(gold, prediction);
      return { metric, score: r.score, n: r.n, feedback: r.feedback, details: r };
    }
    case 'checklist_composite': {
      const r = checklistCompositeScore(gold, prediction);
      return {
        metric,
        score: r.score,
        n: r.abstained ? 0 : 1,
        feedback: r.feedback,
        details: r,
      };
    }
    case 'abstention_rate': {
      const r = abstentionPairFeedback(prediction);
      return { metric, score: r.score, n: r.n, feedback: r.feedback, details: r };
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
    case 'qwk': {
      const r = qwkFromPairs(
        pairs.map((p) => p.gold),
        pairs.map((p) => p.prediction),
      );
      return { metric, score: r.score, n: r.n, feedback: r.feedback, details: r };
    }
    case 'cohens_kappa': {
      // Mean of per-pair κ (each pair is its own item vector)
      let sum = 0;
      let n = 0;
      for (const p of pairs) {
        const r = cohensKappaFromPair(p.gold, p.prediction);
        if (r.n > 0) {
          sum += r.score;
          n += 1;
        }
      }
      return {
        metric,
        score: n > 0 ? sum / n : 0,
        n,
        feedback: `Mean Cohen's κ over ${n} checklist pairs.`,
      };
    }
    case 'checklist_composite': {
      let sum = 0;
      let n = 0;
      for (const p of pairs) {
        const r = checklistCompositeScore(p.gold, p.prediction);
        if (!r.abstained) {
          sum += r.score;
          n += 1;
        }
      }
      return {
        metric,
        score: n > 0 ? sum / n : 0,
        n,
        feedback: `Mean checklist composite agreement over ${n} clips.`,
      };
    }
    case 'abstention_rate': {
      const r = abstentionRate(pairs.map((p) => p.prediction));
      return { metric, score: r.score, n: r.n, feedback: r.feedback, details: r };
    }
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
export {
  quadraticWeightedKappa,
  qwkFromPairs,
  qwkPairProxy,
  isAbstention,
  parseOrdinal,
} from './qwk';
export { cohensKappaBinary, cohensKappaFromPair, parseBinaryLabels } from './cohens-kappa';
export {
  checklistCompositeScore,
  isotonicFit,
  isotonicPredict,
} from './checklist-composite';
export { abstentionRate, abstentionPairFeedback } from './abstention';
