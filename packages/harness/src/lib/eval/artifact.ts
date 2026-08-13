import type { EvalRunMeta, EvalTargetSummary } from './types';

/**
 * Evidence from one deterministic text comparison.
 *
 * The summary answers "who scored highest"; this artifact keeps the prompt,
 * reference, prediction, score and error that make the answer auditable.
 */
export interface TextEvalReport {
  schema: 'redrob-text-eval/v1';
  createdAt: string;
  meta: EvalRunMeta;
  targets: EvalTargetSummary[];
}

export function buildTextEvalReport(params: {
  meta: EvalRunMeta;
  targets: EvalTargetSummary[];
}): TextEvalReport {
  return {
    schema: 'redrob-text-eval/v1',
    createdAt: params.meta.finishedAt,
    meta: params.meta,
    targets: params.targets,
  };
}
