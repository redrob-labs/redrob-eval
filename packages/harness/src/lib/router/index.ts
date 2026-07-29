import type { DatasetTask } from '../../config/datasets';
import type { ModelRef } from '../../config/models';
import { classifyComplexity, type Complexity, type ComplexityDecision } from './complexity';

export interface RouteDecision {
  sampleId: string;
  complexity: Complexity;
  complexityScore: number;
  reasons: string[];
  chosenTier: 'small' | 'large';
  chosenModelId: string;
  chosenModelLabel: string;
}

export interface RouterPair {
  small: ModelRef;
  large: ModelRef;
}

/** Map complexity → small/large model from the configured pair. */
export function routeSample(
  sampleId: string,
  input: string,
  task: DatasetTask,
  pair: RouterPair,
): RouteDecision {
  const decision: ComplexityDecision = classifyComplexity(input, task);
  const chosenTier: 'small' | 'large' = decision.complexity === 'hard' ? 'large' : 'small';
  const model = chosenTier === 'large' ? pair.large : pair.small;

  return {
    sampleId,
    complexity: decision.complexity,
    complexityScore: decision.score,
    reasons: decision.reasons,
    chosenTier,
    chosenModelId: model.id,
    chosenModelLabel: model.label,
  };
}

export { classifyComplexity };
export type { Complexity, ComplexityDecision };
