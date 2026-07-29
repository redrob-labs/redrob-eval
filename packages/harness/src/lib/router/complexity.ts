import type { DatasetTask } from '../../config/datasets';

export type Complexity = 'easy' | 'hard';

export interface ComplexityDecision {
  complexity: Complexity;
  /** 0 = clearly easy, 1 = clearly hard */
  score: number;
  reasons: string[];
}

const HARD_MATH_CUES =
  /\b(how many|altogether|remaining|ratio|percent|percentage|fraction|each|per|then|after|before|twice|thrice|combined|difference|total)\b/i;

/**
 * Heuristic complexity classifier (pure TS).
 * Used by the small/large router — not a trained model.
 */
export function classifyComplexity(
  input: string,
  task: DatasetTask,
): ComplexityDecision {
  const text = input.trim();
  const len = text.length;
  const reasons: string[] = [];
  let score = 0;

  if (task === 'math') {
    const nums = text.match(/-?\d+(?:[.,]\d+)?/g) ?? [];
    if (nums.length >= 4) {
      score += 0.35;
      reasons.push(`${nums.length} numbers`);
    } else if (nums.length >= 2) {
      score += 0.15;
      reasons.push(`${nums.length} numbers`);
    }
    if (len > 280) {
      score += 0.35;
      reasons.push('long question');
    } else if (len > 160) {
      score += 0.2;
      reasons.push('medium length');
    }
    if (HARD_MATH_CUES.test(text)) {
      score += 0.2;
      reasons.push('multi-step cues');
    }
    if ((text.match(/\?/g) ?? []).length > 1) {
      score += 0.1;
      reasons.push('multi-part');
    }
  } else if (task === 'translation') {
    if (len > 220) {
      score += 0.55;
      reasons.push('long source');
    } else if (len > 110) {
      score += 0.3;
      reasons.push('medium source');
    }
    const clauses = (text.match(/[。.!?；;]/g) ?? []).length;
    if (clauses >= 2) {
      score += 0.25;
      reasons.push('multi-clause');
    }
  } else if (task === 'custom') {
    if (len > 800) {
      score += 0.55;
      reasons.push('long input');
    } else if (len > 300) {
      score += 0.3;
      reasons.push('medium input');
    }
    if ((text.match(/\n/g) ?? []).length >= 3) {
      score += 0.2;
      reasons.push('multi-paragraph');
    }
  } else {
    // classification
    if (len > 500) {
      score += 0.55;
      reasons.push('long review');
    } else if (len > 220) {
      score += 0.3;
      reasons.push('medium review');
    }
    if ((text.match(/\n/g) ?? []).length >= 3) {
      score += 0.2;
      reasons.push('multi-paragraph');
    }
  }

  score = Math.min(1, Math.max(0, score));
  const complexity: Complexity = score >= 0.45 ? 'hard' : 'easy';
  if (reasons.length === 0) {
    reasons.push(complexity === 'easy' ? 'short / simple cues' : 'elevated difficulty cues');
  }
  return { complexity, score, reasons };
}
